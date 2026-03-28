/**
 * Background controller for GitHub public profile scraping without a token.
 */

const GITHUB_PROFILE_SNAPSHOT_STORAGE_KEY = 'githubProfileSnapshot';
const GITHUB_PROFILE_STATUS_STORAGE_KEY = 'githubProfileStatus';
const GITHUB_PROFILE_LOADING_STORAGE_KEY = 'githubProfileIsLoading';
const GITHUB_API_BASE_URL = 'https://api.github.com';

let githubProfileRunInProgress = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action === 'startGithubProfileScrape') {
        handleGithubProfileScrape(sendResponse);
        return true;
    }

    if (message?.action === 'clearGithubProfileData') {
        clearGithubProfileData()
            .then(() => sendResponse({ success: true }))
            .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
        return true;
    }

    return undefined;
});

async function handleGithubProfileScrape(sendResponse) {
    if (githubProfileRunInProgress) {
        sendResponse({ success: false, error: 'GitHub scrape is already running.' });
        return;
    }

    githubProfileRunInProgress = true;

    try {
        const snapshot = await runGithubProfileScrape();
        sendResponse({
            success: true,
            repoCount: Array.isArray(snapshot?.repos) ? snapshot.repos.length : 0,
            profileLogin: snapshot?.profile?.login || ''
        });
    } catch (error) {
        const message = error?.message || String(error);
        console.error('[GitHub Controller] Scrape failed:', error);
        await chrome.storage.local.set({
            [GITHUB_PROFILE_STATUS_STORAGE_KEY]: `Error: ${message}`,
            [GITHUB_PROFILE_LOADING_STORAGE_KEY]: false
        });
        sendResponse({ success: false, error: message });
    } finally {
        githubProfileRunInProgress = false;
    }
}

async function clearGithubProfileData() {
    await chrome.storage.local.remove(GITHUB_PROFILE_SNAPSHOT_STORAGE_KEY);
    await chrome.storage.local.set({
        [GITHUB_PROFILE_STATUS_STORAGE_KEY]: 'Data cleared.',
        [GITHUB_PROFILE_LOADING_STORAGE_KEY]: false
    });
}

async function runGithubProfileScrape() {
    await chrome.storage.local.set({
        [GITHUB_PROFILE_LOADING_STORAGE_KEY]: true,
        [GITHUB_PROFILE_STATUS_STORAGE_KEY]: 'Inspecting the active GitHub profile tab...'
    });

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const profileTarget = parseGithubProfileTarget(activeTab?.url);

    if (!profileTarget) {
        throw new Error('Open a GitHub user or organization profile page first.');
    }

    await chrome.storage.local.set({
        [GITHUB_PROFILE_STATUS_STORAGE_KEY]: `Loading public profile for ${profileTarget.login}...`
    });

    const profileResponse = await githubGetJson(`/users/${encodeURIComponent(profileTarget.login)}`);
    const profileData = profileResponse.data;
    const repoOwner = profileData?.login || profileTarget.login;
    const isOrganization = String(profileData?.type || '').toLowerCase() === 'organization';
    const repoSort = 'updated';
    const existingSnapshotData = await chrome.storage.local.get(GITHUB_PROFILE_SNAPSHOT_STORAGE_KEY);
    const existingSnapshot = normalizeReusableSnapshot(existingSnapshotData[GITHUB_PROFILE_SNAPSHOT_STORAGE_KEY], repoOwner);
    const existingReposByFullName = buildExistingRepoMap(existingSnapshot);

    await chrome.storage.local.set({
        [GITHUB_PROFILE_STATUS_STORAGE_KEY]: `Loading public repositories for ${repoOwner}...`
    });

    const repoFetchResult = await fetchAllPublicRepos(repoOwner, isOrganization, repoSort);
    const repos = repoFetchResult.repos;
    let lastRateLimit = repoFetchResult.lastRateLimit || profileResponse.rateLimit || null;
    const normalizedRepos = [];
    let readmesFetchedThisRun = 0;
    let readmesReused = 0;
    let rateLimitReached = false;

    for (let index = 0; index < repos.length; index += 1) {
        const repo = repos[index];
        const remainingRepos = repos.length - index;
        const existingRepo = existingReposByFullName.get(String(repo.full_name || '').toLowerCase());

        if (canReuseExistingReadme(existingRepo, repo)) {
            normalizedRepos.push(normalizeGithubRepo(repo, cloneGithubReadmeState(existingRepo.readme)));
            readmesReused += 1;
            continue;
        }

        if (Number.isFinite(lastRateLimit?.remaining) && lastRateLimit.remaining <= 0) {
            rateLimitReached = true;
        }

        if (rateLimitReached) {
            for (let skipIndex = index; skipIndex < repos.length; skipIndex += 1) {
                const skippedRepo = repos[skipIndex];
                const skippedExistingRepo = existingReposByFullName.get(String(skippedRepo.full_name || '').toLowerCase());
                if (canReuseExistingReadme(skippedExistingRepo, skippedRepo)) {
                    normalizedRepos.push(normalizeGithubRepo(skippedRepo, cloneGithubReadmeState(skippedExistingRepo.readme)));
                    readmesReused += 1;
                    continue;
                }

                normalizedRepos.push(normalizeGithubRepo(repos[skipIndex], {
                    status: 'skipped',
                    reason: 'unauthenticated_rate_limit_reached'
                }));
            }
            break;
        }

        await chrome.storage.local.set({
            [GITHUB_PROFILE_STATUS_STORAGE_KEY]: `Fetching README ${index + 1}/${repos.length}: ${repo.full_name}`
        });

        try {
            const readmeResponse = await githubGetJson(`/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/readme`);
            lastRateLimit = readmeResponse.rateLimit || lastRateLimit;
            normalizedRepos.push(normalizeGithubRepo(repo, normalizeGithubReadme(readmeResponse.data)));
            readmesFetchedThisRun += 1;
        } catch (error) {
            if (error?.status === 404) {
                normalizedRepos.push(normalizeGithubRepo(repo, {
                    status: 'missing',
                    reason: 'not_found'
                }));
                lastRateLimit = error.rateLimit || lastRateLimit;
                continue;
            }

            if (error?.isRateLimitError) {
                normalizedRepos.push(normalizeGithubRepo(repo, {
                    status: 'skipped',
                    reason: 'unauthenticated_rate_limit_reached'
                }));
                lastRateLimit = error.rateLimit || lastRateLimit;
                rateLimitReached = true;

                for (let skipIndex = index + 1; skipIndex < repos.length; skipIndex += 1) {
                    const skippedRepo = repos[skipIndex];
                    const skippedExistingRepo = existingReposByFullName.get(String(skippedRepo.full_name || '').toLowerCase());
                    if (canReuseExistingReadme(skippedExistingRepo, skippedRepo)) {
                        normalizedRepos.push(normalizeGithubRepo(skippedRepo, cloneGithubReadmeState(skippedExistingRepo.readme)));
                        readmesReused += 1;
                        continue;
                    }

                    normalizedRepos.push(normalizeGithubRepo(skippedRepo, {
                        status: 'skipped',
                        reason: 'unauthenticated_rate_limit_reached'
                    }));
                }
                break;
            }

            normalizedRepos.push(normalizeGithubRepo(repo, {
                status: 'error',
                reason: 'request_failed',
                statusCode: error?.status || null,
                message: error?.message || 'Unknown README fetch error.'
            }));
            lastRateLimit = error?.rateLimit || lastRateLimit;
        }

        if (remainingRepos > 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }

    const readmeSummary = summarizeGithubReadmes(normalizedRepos);

    const snapshot = {
        scrapedAt: new Date().toISOString(),
        source: {
            mode: 'github-public-api-no-token',
            activeTabUrl: activeTab?.url || '',
            profilePath: profileTarget.path
        },
        profile: normalizeGithubProfile(profileData, activeTab?.url || ''),
        summary: {
            repoCount: normalizedRepos.length,
            readmesFetched: readmeSummary.fetched,
            readmesMissing: readmeSummary.missing,
            readmesErrored: readmeSummary.errored,
            readmesSkipped: readmeSummary.skipped,
            readmesFetchedThisRun,
            readmesReused,
            rateLimitReached,
            rateLimit: normalizeRateLimit(lastRateLimit)
        },
        repos: normalizedRepos
    };

    const finalStatus = buildGithubFinalStatus(snapshot);

    await chrome.storage.local.set({
        [GITHUB_PROFILE_SNAPSHOT_STORAGE_KEY]: snapshot,
        [GITHUB_PROFILE_STATUS_STORAGE_KEY]: finalStatus,
        [GITHUB_PROFILE_LOADING_STORAGE_KEY]: false
    });

    return snapshot;
}

function parseGithubProfileTarget(rawUrl) {
    if (!rawUrl) return null;

    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch (_error) {
        return null;
    }

    const hostname = String(parsed.hostname || '').toLowerCase();
    if (hostname !== 'github.com' && hostname !== 'www.github.com') {
        return null;
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length !== 1) {
        return null;
    }

    const reserved = new Set([
        'about',
        'account',
        'codespaces',
        'collections',
        'contact',
        'customer-stories',
        'enterprise',
        'events',
        'explore',
        'features',
        'gist',
        'gists',
        'issues',
        'join',
        'login',
        'logout',
        'marketplace',
        'new',
        'notifications',
        'orgs',
        'organizations',
        'pricing',
        'pulls',
        'readme',
        'search',
        'security',
        'sessions',
        'settings',
        'signup',
        'site',
        'sponsors',
        'team',
        'teams',
        'topics',
        'trending'
    ]);

    const login = segments[0];
    if (reserved.has(login.toLowerCase())) {
        return null;
    }

    return {
        login,
        path: parsed.pathname
    };
}

async function fetchAllPublicRepos(login, isOrganization, sort) {
    const repos = [];
    let page = 1;
    let lastRateLimit = null;

    while (true) {
        const path = isOrganization
            ? `/orgs/${encodeURIComponent(login)}/repos?type=public&sort=${encodeURIComponent(sort)}&per_page=100&page=${page}`
            : `/users/${encodeURIComponent(login)}/repos?type=owner&sort=${encodeURIComponent(sort)}&per_page=100&page=${page}`;

        const response = await githubGetJson(path);
        lastRateLimit = response.rateLimit || lastRateLimit;

        if (!Array.isArray(response.data) || response.data.length === 0) {
            break;
        }

        repos.push(...response.data);

        if (response.data.length < 100) {
            break;
        }

        page += 1;
    }

    return { repos, lastRateLimit };
}

async function githubGetJson(path) {
    const response = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
        method: 'GET',
        headers: {
            Accept: 'application/vnd.github+json'
        }
    });

    const rateLimit = extractGithubRateLimit(response.headers);
    const responseText = await response.text();
    let data = null;

    if (responseText) {
        try {
            data = JSON.parse(responseText);
        } catch (_error) {
            data = responseText;
        }
    }

    if (!response.ok) {
        const message = typeof data === 'object' && data && typeof data.message === 'string'
            ? data.message
            : `GitHub API request failed with status ${response.status}.`;
        const error = new Error(message);
        error.status = response.status;
        error.rateLimit = rateLimit;
        error.isRateLimitError = response.status === 403 || response.status === 429;
        throw error;
    }

    return { data, rateLimit };
}

function extractGithubRateLimit(headers) {
    const limit = Number.parseInt(headers.get('x-ratelimit-limit') || '', 10);
    const remaining = Number.parseInt(headers.get('x-ratelimit-remaining') || '', 10);
    const resetEpochSeconds = Number.parseInt(headers.get('x-ratelimit-reset') || '', 10);
    const resource = headers.get('x-ratelimit-resource') || '';

    return {
        limit: Number.isFinite(limit) ? limit : null,
        remaining: Number.isFinite(remaining) ? remaining : null,
        resetAt: Number.isFinite(resetEpochSeconds) ? new Date(resetEpochSeconds * 1000).toISOString() : null,
        resource
    };
}

function normalizeGithubProfile(profileData, fallbackUrl) {
    return {
        login: profileData?.login || '',
        id: toFiniteNumber(profileData?.id),
        type: profileData?.type || '',
        name: profileData?.name || '',
        bio: profileData?.bio || '',
        company: profileData?.company || '',
        location: profileData?.location || '',
        blog: profileData?.blog || '',
        email: profileData?.email || '',
        htmlUrl: profileData?.html_url || fallbackUrl,
        avatarUrl: profileData?.avatar_url || '',
        followers: toFiniteNumber(profileData?.followers),
        following: toFiniteNumber(profileData?.following),
        publicRepos: toFiniteNumber(profileData?.public_repos),
        publicGists: toFiniteNumber(profileData?.public_gists),
        createdAt: profileData?.created_at || null,
        updatedAt: profileData?.updated_at || null
    };
}

function normalizeGithubRepo(repoData, readme) {
    return {
        id: toFiniteNumber(repoData?.id),
        name: repoData?.name || '',
        fullName: repoData?.full_name || '',
        owner: repoData?.owner?.login || '',
        description: repoData?.description || '',
        htmlUrl: repoData?.html_url || '',
        apiUrl: repoData?.url || '',
        homepage: repoData?.homepage || '',
        visibility: repoData?.visibility || (repoData?.private ? 'private' : 'public'),
        defaultBranch: repoData?.default_branch || '',
        language: repoData?.language || '',
        topics: Array.isArray(repoData?.topics) ? repoData.topics : [],
        fork: repoData?.fork === true,
        archived: repoData?.archived === true,
        disabled: repoData?.disabled === true,
        size: toFiniteNumber(repoData?.size),
        stargazersCount: toFiniteNumber(repoData?.stargazers_count),
        watchersCount: toFiniteNumber(repoData?.watchers_count),
        forksCount: toFiniteNumber(repoData?.forks_count),
        openIssuesCount: toFiniteNumber(repoData?.open_issues_count),
        createdAt: repoData?.created_at || null,
        updatedAt: repoData?.updated_at || null,
        pushedAt: repoData?.pushed_at || null,
        license: repoData?.license
            ? {
                key: repoData.license.key || '',
                name: repoData.license.name || ''
            }
            : null,
        readme
    };
}

function normalizeGithubReadme(readmeData) {
    return {
        status: 'fetched',
        name: readmeData?.name || '',
        path: readmeData?.path || '',
        sha: readmeData?.sha || '',
        size: toFiniteNumber(readmeData?.size),
        encoding: readmeData?.encoding || '',
        htmlUrl: readmeData?.html_url || '',
        downloadUrl: readmeData?.download_url || '',
        text: decodeGithubBase64Utf8(readmeData?.content || '')
    };
}

function normalizeReusableSnapshot(snapshot, expectedLogin) {
    if (!snapshot || typeof snapshot !== 'object') {
        return null;
    }

    const snapshotLogin = String(snapshot?.profile?.login || '').toLowerCase();
    if (!snapshotLogin || snapshotLogin !== String(expectedLogin || '').toLowerCase()) {
        return null;
    }

    return snapshot;
}

function buildExistingRepoMap(snapshot) {
    const map = new Map();
    const repos = Array.isArray(snapshot?.repos) ? snapshot.repos : [];

    for (const repo of repos) {
        const key = String(repo?.fullName || '').toLowerCase();
        if (!key) {
            continue;
        }

        map.set(key, repo);
    }

    return map;
}

function canReuseExistingReadme(existingRepo, repoData) {
    if (!existingRepo || !existingRepo.readme || typeof existingRepo.readme !== 'object') {
        return false;
    }

    const readmeStatus = String(existingRepo.readme.status || '');
    if (readmeStatus !== 'fetched' && readmeStatus !== 'missing') {
        return false;
    }

    const existingPushedAt = String(existingRepo.pushedAt || '');
    const latestPushedAt = String(repoData?.pushed_at || '');
    if (!existingPushedAt || !latestPushedAt) {
        return false;
    }

    return existingPushedAt === latestPushedAt;
}

function cloneGithubReadmeState(readme) {
    return JSON.parse(JSON.stringify(readme || null));
}

function summarizeGithubReadmes(repos) {
    const summary = {
        fetched: 0,
        missing: 0,
        errored: 0,
        skipped: 0
    };

    for (const repo of Array.isArray(repos) ? repos : []) {
        const status = String(repo?.readme?.status || '');
        if (status === 'fetched') {
            summary.fetched += 1;
        } else if (status === 'missing') {
            summary.missing += 1;
        } else if (status === 'error') {
            summary.errored += 1;
        } else if (status === 'skipped') {
            summary.skipped += 1;
        }
    }

    return summary;
}

function decodeGithubBase64Utf8(base64Content) {
    const normalized = String(base64Content || '').replace(/\s+/g, '');
    if (!normalized) return '';

    try {
        const binary = atob(normalized);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return new TextDecoder('utf-8').decode(bytes);
    } catch (error) {
        console.warn('[GitHub Controller] Failed to decode README content:', error);
        return '';
    }
}

function buildGithubFinalStatus(snapshot) {
    const login = snapshot?.profile?.login || 'profile';
    const repoCount = toFiniteNumber(snapshot?.summary?.repoCount);
    const readmesFetched = toFiniteNumber(snapshot?.summary?.readmesFetched);
    const readmesMissing = toFiniteNumber(snapshot?.summary?.readmesMissing);
    const readmesErrored = toFiniteNumber(snapshot?.summary?.readmesErrored);
    const readmesSkipped = toFiniteNumber(snapshot?.summary?.readmesSkipped);
    const readmesFetchedThisRun = toFiniteNumber(snapshot?.summary?.readmesFetchedThisRun);
    const readmesReused = toFiniteNumber(snapshot?.summary?.readmesReused);
    const readmeParts = [`${readmesFetched} fetched total`];

    if (readmesMissing > 0) {
        readmeParts.push(`${readmesMissing} missing`);
    }

    if (readmesErrored > 0) {
        readmeParts.push(`${readmesErrored} errored`);
    }

    if (readmesSkipped > 0) {
        readmeParts.push(`${readmesSkipped} skipped after the unauthenticated API limit was reached`);
    }

    return `Saved ${repoCount} public repos for ${login}. READMEs: ${readmeParts.join(', ')}. This run fetched ${readmesFetchedThisRun} and reused ${readmesReused} cached results.`;
}

function normalizeRateLimit(rateLimit) {
    return {
        limit: toNullableFiniteNumber(rateLimit?.limit),
        remaining: toNullableFiniteNumber(rateLimit?.remaining),
        resetAt: rateLimit?.resetAt || null,
        resource: rateLimit?.resource || ''
    };
}

function toNullableFiniteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function toFiniteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
