const INJECTED_SCRAPER_HELPER_FILES = [
    'background/injected/job-post-page.js'
];
const MAIN_WORLD_SCRAPER_HELPER_FILES = [
    'background/injected/proposals-network-monitor.js'
];

const DEBUGGER_ENABLED_FOR_LIST_SCRAPE = true;
const DEBUGGER_PROTOCOL_VERSION = '1.3';
const DEBUGGER_TARGET_ORIGIN = 'https://www.upwork.com';
const DEBUGGER_TARGET_PATH = '/api/graphql/v1';
const DEBUGGER_LIST_ALIAS = 'gql-query-proposalsbytype';
const DEBUGGER_DETAILS_ALIAS = 'gql-query-get-auth-job-details';
const DEBUGGER_GRAPHQL_PATH_PREFIX = '/api/graphql/';
const DEBUGGER_LOG_PREFIX = '[ProposalCopycatDebugger]';
const DEBUGGER_VERBOSE_LOGS = false;
const DEBUGGER_DETAILS_RESPONSE_WAIT_MS = 12000;
const DEBUGGER_DETAILS_INTER_ITEM_DELAY_MS = 250;

const debuggerSessions = new Map();
let debuggerListenersInstalled = false;
let proposalListWriteQueue = Promise.resolve();
let proposalDetailsWriteQueue = Promise.resolve();
let proposalDetailsSummaryWriteQueue = Promise.resolve();

function isReasonAllowedForMode(reason, scrapeMode) {
    if (scrapeMode === 'all') {
        return true;
    }
    return String(reason || '').trim().toLowerCase() === 'hired';
}

function parseSubmissionTimestamp(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        if (value > 1e12) {
            return Math.floor(value);
        }
        if (value > 0) {
            return Math.floor(value * 1000);
        }
        return null;
    }

    const asString = String(value).trim();
    if (!asString) {
        return null;
    }

    if (/^\d+(\.\d+)?$/.test(asString)) {
        const numericValue = Number(asString);
        if (Number.isFinite(numericValue)) {
            if (numericValue > 1e12) {
                return Math.floor(numericValue);
            }
            if (numericValue > 0) {
                return Math.floor(numericValue * 1000);
            }
        }
    }

    const parsedDate = Date.parse(asString);
    if (Number.isFinite(parsedDate)) {
        return parsedDate;
    }

    return null;
}

function pickFirstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return '';
}

function toAbsoluteUpworkUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        return '';
    }

    try {
        return new URL(raw, DEBUGGER_TARGET_ORIGIN).href;
    } catch (error) {
        return '';
    }
}

function normalizeProposalReason(candidate) {
    if (!candidate || typeof candidate !== 'object') {
        return '';
    }

    if (candidate.hired === true || candidate.isHired === true || candidate.wasHired === true) {
        return 'Hired';
    }

    const rawReason = pickFirstString(
        candidate.reason,
        candidate.archiveReason,
        candidate.archivedReason,
        candidate.archiveStatus,
        candidate.status,
        candidate.applicationStatus,
        candidate.result,
        candidate.state,
        candidate.proposal?.reason,
        candidate.proposal?.status
    );

    if (!rawReason) {
        return '';
    }

    const normalized = rawReason.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    if (/hired/i.test(normalized)) {
        return 'Hired';
    }

    return normalized;
}

function collectObjectNodes(root) {
    const result = [];
    const stack = [root];
    const seen = new WeakSet();

    while (stack.length > 0) {
        const current = stack.pop();
        if (!current || typeof current !== 'object') {
            continue;
        }

        if (seen.has(current)) {
            continue;
        }
        seen.add(current);
        result.push(current);

        if (Array.isArray(current)) {
            for (const item of current) {
                if (item && typeof item === 'object') {
                    stack.push(item);
                }
            }
            continue;
        }

        for (const value of Object.values(current)) {
            if (value && typeof value === 'object') {
                stack.push(value);
            }
        }
    }

    return result;
}

function safeParseJsonPayload(rawText) {
    const text = String(rawText || '').replace(/^\)\]\}'\s*/, '').trim();
    if (!text) {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch (error) {
        return null;
    }
}

function buildProposalEntryFromNode(node, scrapeMode, options = {}) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return null;
    }

    let href = toAbsoluteUpworkUrl(pickFirstString(
        node.proposalUrl,
        node.proposalURL,
        node.href,
        node.url,
        node.link,
        node.proposal?.proposalUrl,
        node.proposal?.url,
        node.application?.proposalUrl,
        node.application?.url
    ));

    if (!href) {
        const ciphertext = pickFirstString(
            node.proposalCiphertext,
            node.applicationCiphertext,
            node.ciphertext,
            node.proposal?.ciphertext,
            node.application?.ciphertext
        );
        if (ciphertext) {
            href = toAbsoluteUpworkUrl(`/ab/proposals/${ciphertext}`);
        }
    }

    if (!href) {
        const applicationId = pickFirstString(
            node.applicationId,
            node.proposalId,
            node.id,
            node.application?.applicationId,
            node.proposal?.applicationId
        );
        if (applicationId && /^\d+$/.test(applicationId)) {
            href = toAbsoluteUpworkUrl(`/nx/proposals/${applicationId}`);
        }
    }

    if (!href || !/upwork\.com/i.test(href) || !/\/proposals\//i.test(href)) {
        return null;
    }

    const reason = normalizeProposalReason(node) || 'Unknown';
    if (!isReasonAllowedForMode(reason, scrapeMode)) {
        return null;
    }

    const title = pickFirstString(
        node.title,
        node.jobTitle,
        node.proposalTitle,
        node.job?.title,
        node.opening?.title,
        node.jobPost?.title,
        node.proposal?.title
    ) || 'Untitled Proposal';

    const submissionTime = parseSubmissionTimestamp(
        node.submittedOn ??
        node.submittedAt ??
        node.submissionTime ??
        node.createdAt ??
        node.createdOn ??
        node.createdDate ??
        node.auditDetails?.createdDateTime ??
        node.auditDetails?.modifiedDateTime ??
        node.proposal?.submittedOn ??
        node.proposal?.submittedAt ??
        node.application?.submittedOn ??
        node.application?.submittedAt
    );

    return {
        href,
        text: title,
        reason,
        submissionTime,
        rawGraphql: options.includeRawNode ? node : undefined
    };
}

function extractProposalLinksFromGraphqlResponse(rawResponseText, scrapeMode) {
    const parsedResponse = safeParseJsonPayload(rawResponseText);
    if (!parsedResponse) {
        return [];
    }

    const links = [];
    const seen = new Set();
    const pushIfEligible = (node, includeRawNode = false) => {
        const entry = buildProposalEntryFromNode(node, scrapeMode, { includeRawNode });
        if (!entry) {
            return;
        }
        if (seen.has(entry.href)) {
            return;
        }
        seen.add(entry.href);
        links.push(entry);
    };

    const applications = parsedResponse?.data?.proposalsByType?.applications;
    if (Array.isArray(applications) && applications.length > 0) {
        for (const application of applications) {
            pushIfEligible(application, true);
        }
        if (links.length > 0) {
            return links;
        }
    }

    const objectNodes = collectObjectNodes(parsedResponse);
    for (const node of objectNodes) {
        pushIfEligible(node, false);
    }

    return links;
}

function isTargetGraphqlRequestUrl(urlValue) {
    try {
        const url = new URL(String(urlValue || ''), DEBUGGER_TARGET_ORIGIN);
        return (
            url.origin === DEBUGGER_TARGET_ORIGIN &&
            url.pathname === DEBUGGER_TARGET_PATH &&
            url.searchParams.get('alias') === DEBUGGER_LIST_ALIAS
        );
    } catch (error) {
        return false;
    }
}

function isTargetDetailsGraphqlRequestUrl(urlValue) {
    try {
        const url = new URL(String(urlValue || ''), DEBUGGER_TARGET_ORIGIN);
        return (
            url.origin === DEBUGGER_TARGET_ORIGIN &&
            url.pathname === DEBUGGER_TARGET_PATH &&
            url.searchParams.get('alias') === DEBUGGER_DETAILS_ALIAS
        );
    } catch (error) {
        return false;
    }
}

function isGraphqlRequestUrl(urlValue) {
    try {
        const url = new URL(String(urlValue || ''), DEBUGGER_TARGET_ORIGIN);
        return (
            url.origin === DEBUGGER_TARGET_ORIGIN &&
            String(url.pathname || '').includes(DEBUGGER_GRAPHQL_PATH_PREFIX)
        );
    } catch (error) {
        return false;
    }
}

function isLikelyProposalsGraphqlRequest(urlValue, postDataValue) {
    const urlText = String(urlValue || '').toLowerCase();
    const postData = String(postDataValue || '').toLowerCase();
    return (
        urlText.includes('proposalsbytype') ||
        urlText.includes('gql-query-proposalsbytype') ||
        postData.includes('proposalsbytype') ||
        postData.includes('gql-query-proposalsbytype')
    );
}

function isLikelyProposalDetailsGraphqlRequest(urlValue, postDataValue) {
    const urlText = String(urlValue || '').toLowerCase();
    const postData = String(postDataValue || '').toLowerCase();
    return (
        urlText.includes('get-auth-job-details') ||
        urlText.includes(DEBUGGER_DETAILS_ALIAS) ||
        postData.includes('get-auth-job-details') ||
        postData.includes(DEBUGGER_DETAILS_ALIAS)
    );
}

function aliasFromGraphqlUrl(urlValue) {
    try {
        const url = new URL(String(urlValue || ''), DEBUGGER_TARGET_ORIGIN);
        return String(url.searchParams.get('alias') || '').trim();
    } catch (error) {
        return '';
    }
}

function decodeDebuggerResponseBody(responseBodyResult) {
    const body = String(responseBodyResult?.body || '');
    if (!body) {
        return '';
    }

    if (!responseBodyResult?.base64Encoded) {
        return body;
    }

    try {
        return atob(body);
    } catch (error) {
        return '';
    }
}

function debuggerAttach(tabId) {
    return new Promise((resolve, reject) => {
        chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION, () => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve();
        });
    });
}

function debuggerDetach(tabId) {
    return new Promise((resolve, reject) => {
        chrome.debugger.detach({ tabId }, () => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve();
        });
    });
}

function debuggerSendCommand(source, command, params = {}) {
    return new Promise((resolve, reject) => {
        chrome.debugger.sendCommand(source, command, params, (result) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(result || {});
        });
    });
}

function queueProposalListUpsert(entries, sourceLabel) {
    proposalListWriteQueue = proposalListWriteQueue
        .then(() => upsertProposalListEntries(entries, sourceLabel))
        .catch((error) => {
            console.warn(`${DEBUGGER_LOG_PREFIX} failed to upsert proposal list:`, error);
        });
    return proposalListWriteQueue;
}

function queueProposalDetailsUpsert(detailEntry, sourceLabel) {
    proposalDetailsWriteQueue = proposalDetailsWriteQueue
        .then(() => upsertProposalDetailsEntry(detailEntry, sourceLabel))
        .catch((error) => {
            console.warn(`${DEBUGGER_LOG_PREFIX} failed to upsert proposal details:`, error);
            return null;
        });
    return proposalDetailsWriteQueue;
}

function queueProposalDetailsSummaryUpdate(update, options = {}) {
    proposalDetailsSummaryWriteQueue = proposalDetailsSummaryWriteQueue
        .then(async () => {
            const reset = options?.reset === true;
            const storage = await chrome.storage.local.get('proposalDetailsCaptureSummary');
            const previous = reset
                ? {}
                : (storage?.proposalDetailsCaptureSummary && typeof storage.proposalDetailsCaptureSummary === 'object'
                    ? storage.proposalDetailsCaptureSummary
                    : {});
            const nextSummary = {
                ...previous,
                ...(update || {})
            };
            await chrome.storage.local.set({ proposalDetailsCaptureSummary: nextSummary });
            return nextSummary;
        })
        .catch((error) => {
            console.warn(`${DEBUGGER_LOG_PREFIX} failed to update proposal details summary:`, error);
            return null;
        });
    return proposalDetailsSummaryWriteQueue;
}

async function upsertProposalListEntries(entries, sourceLabel = 'debugger') {
    const normalizedEntries = Array.isArray(entries) ? entries : [];
    if (!normalizedEntries.length) {
        return { upsertedCount: 0, totalSize: 0 };
    }

    const storageUpdate = await chrome.storage.local.get('proposalList');
    const proposalList = Array.isArray(storageUpdate.proposalList) ? storageUpdate.proposalList : [];
    const listByHref = new Map();

    for (const entry of proposalList) {
        const href = String(entry?.href || '').trim();
        if (href) {
            listByHref.set(href, entry);
        }
    }

    const scrapedAtIso = new Date().toISOString();
    let upsertedCount = 0;
    for (const item of normalizedEntries) {
        const href = String(item?.href || '').trim();
        if (!href) {
            continue;
        }

        const previous = listByHref.get(href) || {};
        listByHref.set(href, {
            ...previous,
            href,
            text: item?.text || previous.text || '',
            reason: item?.reason || previous.reason || '',
            submissionTime: item?.submissionTime ?? previous.submissionTime ?? null,
            rawGraphql: (
                item?.rawGraphql !== undefined
                    ? item.rawGraphql
                    : (previous.rawGraphql ?? null)
            ),
            scrapedAt: scrapedAtIso,
            source: sourceLabel
        });
        upsertedCount += 1;
    }

    await chrome.storage.local.set({ proposalList: Array.from(listByHref.values()) });
    return {
        upsertedCount,
        totalSize: listByHref.size
    };
}

function extractExistingProposalHref(entry) {
    return String(
        entry?.proposalDetailsPage?.url ||
        entry?.proposalListPage?.href ||
        entry?.proposal?.proposalUrl ||
        entry?.href ||
        ''
    ).trim();
}

function normalizeLinkData(linkData) {
    const href = String(linkData?.href || '').trim();
    if (!href) {
        return null;
    }
    return {
        href,
        text: String(linkData?.text || '').trim(),
        reason: String(linkData?.reason || '').trim(),
        submissionTime: linkData?.submissionTime ?? null
    };
}

function normalizeJobPostHref(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) {
        return '';
    }

    if (/^https?:\/\//i.test(value)) {
        return value;
    }

    if (/^\/jobs\//i.test(value)) {
        return `${DEBUGGER_TARGET_ORIGIN}${value}`;
    }

    if (/^~0\d+/.test(value)) {
        return `${DEBUGGER_TARGET_ORIGIN}/jobs/${value}`;
    }

    return '';
}

function deriveCiphertextFromOpeningId(rawValue) {
    const value = String(rawValue || '').trim();
    if (!/^\d{8,}$/.test(value)) {
        return '';
    }
    return `~02${value}`;
}

function collectJobPostHrefCandidatesFromDetailsPayload(rawGraphql) {
    const details = rawGraphql?.jobAuthDetails || rawGraphql || {};
    const opening = details?.opening || {};
    const jobDetails = details?.jobDetails || {};
    const jobDetailsOpening = jobDetails?.opening || {};
    const openingJob = opening?.job || jobDetailsOpening?.job || jobDetails?.job || {};
    const openingInfo = opening?.info || openingJob?.info || jobDetailsOpening?.info || {};
    const jobInfo = openingJob?.info || {};

    const openingIdCandidates = [
        opening?.id,
        opening?.openingId,
        opening?.openingUid,
        openingInfo?.id,
        openingJob?.id,
        openingJob?.uid,
        openingJob?.openingId,
        openingJob?.openingUid,
        jobInfo?.id,
        details?.openingId,
        details?.openingUid,
        jobDetailsOpening?.id,
        jobDetailsOpening?.openingId,
        jobDetailsOpening?.openingUid
    ]
        .map((value) => deriveCiphertextFromOpeningId(value))
        .filter(Boolean);

    // All candidates are tied to this proposal's opening details.
    return [
        opening?.url,
        opening?.jobPostUrl,
        opening?.canonicalUrl,
        openingInfo?.url,
        openingJob?.url,
        jobInfo?.url,
        opening?.ciphertext,
        opening?.jobCiphertext,
        openingInfo?.ciphertext,
        openingJob?.ciphertext,
        jobInfo?.ciphertext,
        jobDetailsOpening?.ciphertext,
        jobDetailsOpening?.jobCiphertext,
        ...openingIdCandidates
    ];
}

function extractJobPostHrefFromDetailsPayload(rawGraphql) {
    const candidates = collectJobPostHrefCandidatesFromDetailsPayload(rawGraphql);
    for (const candidate of candidates) {
        const normalized = normalizeJobPostHref(candidate);
        if (normalized) {
            return normalized;
        }
    }

    return '';
}

function maybeSetNestedJobUrl(data, jobUrl) {
    if (!data || typeof data !== 'object' || !jobUrl) {
        return data;
    }
    if (!data.jobPost || typeof data.jobPost !== 'object') {
        return data;
    }
    return {
        ...data,
        jobPost: {
            ...data.jobPost,
            url: jobUrl
        }
    };
}

async function repairSavedJobPostUrls() {
    const storageData = await chrome.storage.local.get(['proposalList', 'proposals', 'jobPosts']);
    const proposalList = Array.isArray(storageData.proposalList) ? storageData.proposalList : [];
    const proposals = Array.isArray(storageData.proposals) ? storageData.proposals : [];
    const jobPosts = Array.isArray(storageData.jobPosts) ? storageData.jobPosts : [];

    if (!proposals.length) {
        return {
            proposalListCount: proposalList.length,
            proposalsCount: 0,
            proposalsWithRawGraphql: 0,
            proposalsUpdated: 0,
            proposalsDerivedUrlMissing: 0,
            uniqueJobUrlsAfterRepair: 0,
            jobPostsUpdated: 0
        };
    }

    let proposalsWithRawGraphql = 0;
    let proposalsUpdated = 0;
    let proposalsDerivedUrlMissing = 0;
    const proposalUrlFixes = new Map();
    const repairedProposals = proposals.map((entry) => {
        const rawGraphql = entry?.proposalDetailsPage?.rawGraphql;
        if (rawGraphql != null) {
            proposalsWithRawGraphql += 1;
        }

        const derivedJobUrl = extractJobPostHrefFromDetailsPayload(rawGraphql);
        if (!derivedJobUrl) {
            proposalsDerivedUrlMissing += 1;
            return entry;
        }

        const currentDetailsUrl = normalizeJobPostHref(entry?.proposalDetailsPage?.jobPostHref);
        const currentJobPageUrl = normalizeJobPostHref(entry?.jobPostPage?.url);
        const needsUpdate = currentDetailsUrl !== derivedJobUrl || currentJobPageUrl !== derivedJobUrl;
        if (!needsUpdate) {
            return entry;
        }

        proposalsUpdated += 1;
        const proposalHref = extractExistingProposalHref(entry);
        if (proposalHref) {
            proposalUrlFixes.set(proposalHref, derivedJobUrl);
        }

        return {
            ...entry,
            proposalDetailsPage: {
                ...(entry?.proposalDetailsPage || {}),
                jobPostHref: derivedJobUrl
            },
            jobPostPage: {
                ...(entry?.jobPostPage || {}),
                url: derivedJobUrl
            }
        };
    });

    if (proposalsUpdated > 0) {
        await chrome.storage.local.set({ proposals: repairedProposals });
    }

    let jobPostsUpdated = 0;
    if (jobPosts.length > 0 && proposalUrlFixes.size > 0) {
        const repairedJobPosts = jobPosts.map((entry) => {
            const sourceProposalUrl = String(entry?.sourcePageUrl || '').trim();
            const derivedJobUrl = proposalUrlFixes.get(sourceProposalUrl);
            if (!derivedJobUrl) {
                return entry;
            }

            const currentJobPageUrl = normalizeJobPostHref(entry?.jobPostPage?.url || entry?.sourcePageUrl);
            if (currentJobPageUrl === derivedJobUrl) {
                return entry;
            }

            jobPostsUpdated += 1;
            return {
                ...entry,
                jobPostPage: {
                    ...(entry?.jobPostPage || {}),
                    url: derivedJobUrl,
                    data: maybeSetNestedJobUrl(entry?.jobPostPage?.data, derivedJobUrl)
                }
            };
        });

        if (jobPostsUpdated > 0) {
            await chrome.storage.local.set({ jobPosts: repairedJobPosts });
        }
    }

    const uniqueJobUrls = new Set(
        repairedProposals
            .map((entry) => normalizeJobPostHref(entry?.jobPostPage?.url || entry?.proposalDetailsPage?.jobPostHref))
            .filter(Boolean)
    );

    return {
        proposalListCount: proposalList.length,
        proposalsCount: proposals.length,
        proposalsWithRawGraphql,
        proposalsUpdated,
        proposalsDerivedUrlMissing,
        uniqueJobUrlsAfterRepair: uniqueJobUrls.size,
        jobPostsUpdated
    };
}

function isQuotaExceededError(error) {
    const message = String(error?.message || error || '');
    return /quota|QUOTA_BYTES|QUOTA_BYTES_PER_ITEM/i.test(message);
}

function getScrapedAtMs(entry) {
    const asMs = Date.parse(String(entry?.scrapedAt || ''));
    return Number.isFinite(asMs) ? asMs : 0;
}

async function writeProposalsWithQuotaGuard(proposals) {
    try {
        await chrome.storage.local.set({ proposals });
        return { droppedRawCount: 0 };
    } catch (error) {
        if (!isQuotaExceededError(error)) {
            throw error;
        }
    }

    const working = Array.isArray(proposals) ? proposals : [];
    const indicesByOldest = working
        .map((entry, index) => ({ index, scrapedAtMs: getScrapedAtMs(entry) }))
        .sort((a, b) => a.scrapedAtMs - b.scrapedAtMs)
        .map((item) => item.index);

    let droppedRawCount = 0;
    for (const index of indicesByOldest) {
        const entry = working[index];
        if (!entry?.proposalDetailsPage || entry.proposalDetailsPage.rawGraphql == null) {
            continue;
        }

        entry.proposalDetailsPage = {
            ...entry.proposalDetailsPage,
            rawGraphql: null,
            rawGraphqlDropped: true,
            rawGraphqlDroppedAt: new Date().toISOString()
        };
        droppedRawCount += 1;

        if (droppedRawCount % 10 !== 0) {
            continue;
        }

        try {
            await chrome.storage.local.set({ proposals: working });
            return { droppedRawCount };
        } catch (error) {
            if (!isQuotaExceededError(error)) {
                throw error;
            }
        }
    }

    await chrome.storage.local.set({ proposals: working });
    return { droppedRawCount };
}

async function upsertProposalDetailsEntry(detailEntry, sourceLabel = 'debugger:details') {
    const normalized = normalizeLinkData(detailEntry);
    if (!normalized) {
        return null;
    }

    const storageUpdate = await chrome.storage.local.get('proposals');
    const proposals = Array.isArray(storageUpdate.proposals) ? storageUpdate.proposals : [];
    const href = normalized.href;
    const existingIndex = proposals.findIndex((entry) => extractExistingProposalHref(entry) === href);
    const existingRecord = existingIndex >= 0 ? (proposals[existingIndex] || {}) : {};
    const scrapedAtIso = new Date().toISOString();
    const isHired = /hired/i.test(String(normalized.reason || ''));
    const rawGraphql = detailEntry?.rawGraphql ?? null;
    const extractedJobPostHref = extractJobPostHrefFromDetailsPayload(rawGraphql);

    const nextRecord = {
        ...existingRecord,
        scrapedAt: scrapedAtIso,
        proposalListPage: {
            ...(existingRecord.proposalListPage || {}),
            href,
            text: normalized.text || existingRecord?.proposalListPage?.text || '',
            reason: normalized.reason || existingRecord?.proposalListPage?.reason || '',
            submissionTime: normalized.submissionTime ?? existingRecord?.proposalListPage?.submissionTime ?? null,
            isHired: (
                existingRecord?.proposalListPage?.isHired !== undefined
                    ? existingRecord.proposalListPage.isHired
                    : isHired
            )
        },
        proposalDetailsPage: {
            url: href,
            rawGraphql,
            graphqlAlias: DEBUGGER_DETAILS_ALIAS,
            source: sourceLabel,
            capturedAt: scrapedAtIso,
            captureMethod: 'debugger-graphql',
            jobPostHref: extractedJobPostHref || null
        },
        jobPostPage: {
            ...(existingRecord.jobPostPage || {}),
            url: extractedJobPostHref || existingRecord?.jobPostPage?.url || null
        }
    };

    if (existingIndex >= 0) {
        proposals[existingIndex] = nextRecord;
    } else {
        proposals.push(nextRecord);
    }

    const writeResult = await writeProposalsWithQuotaGuard(proposals);
    if (writeResult?.droppedRawCount > 0) {
        console.warn(
            `${DEBUGGER_LOG_PREFIX} quota guard dropped rawGraphql from ${writeResult.droppedRawCount} older proposal record(s).`
        );
    }
    return {
        updated: existingIndex >= 0,
        totalSize: proposals.length,
        href,
        droppedRawCount: writeResult?.droppedRawCount || 0
    };
}

function setActiveDetailContext(tabId, linkData) {
    const session = debuggerSessions.get(tabId);
    if (!session) {
        return;
    }
    const normalized = normalizeLinkData(linkData);
    if (!normalized) {
        return;
    }
    session.activeDetailContext = {
        ...normalized,
        startedAtMs: Date.now()
    };
}

function clearActiveDetailContext(tabId) {
    const session = debuggerSessions.get(tabId);
    if (!session) {
        return;
    }
    session.activeDetailContext = null;
}

function resolveDetailCaptureWaiters(session, href, detailPayload) {
    if (!session || !href) {
        return;
    }

    session.capturedDetailHrefs.add(href);
    for (let index = 0; index < session.detailCaptureWaiters.length; index += 1) {
        const waiter = session.detailCaptureWaiters[index];
        if (waiter.href !== href) {
            continue;
        }
        clearTimeout(waiter.timeoutId);
        session.detailCaptureWaiters.splice(index, 1);
        index -= 1;
        waiter.resolve(detailPayload || null);
    }
}

function waitForDetailCapture(tabId, href, timeoutMs = DEBUGGER_DETAILS_RESPONSE_WAIT_MS) {
    const session = debuggerSessions.get(tabId);
    if (!session || !href) {
        return Promise.resolve(null);
    }

    if (session.capturedDetailHrefs.has(href)) {
        session.capturedDetailHrefs.delete(href);
        return Promise.resolve({ href, fromBuffer: true });
    }

    return new Promise((resolve) => {
        const waiter = {
            href,
            resolve,
            timeoutId: null
        };
        waiter.timeoutId = setTimeout(() => {
            const waiterIndex = session.detailCaptureWaiters.indexOf(waiter);
            if (waiterIndex >= 0) {
                session.detailCaptureWaiters.splice(waiterIndex, 1);
            }
            resolve(null);
        }, timeoutMs);

        session.detailCaptureWaiters.push(waiter);
    });
}

async function logDebuggerToTab(tabId, message) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: (msg) => console.log(msg),
            args: [message]
        });
    } catch (error) {
        // Ignore tab-console mirror failures.
    }
}

function ensureDebuggerListeners() {
    if (debuggerListenersInstalled) {
        return;
    }

    chrome.debugger.onEvent.addListener((source, method, params) => {
        handleDebuggerEvent(source, method, params).catch((error) => {
            console.warn(`${DEBUGGER_LOG_PREFIX} event handling failed:`, error);
        });
    });

    chrome.debugger.onDetach.addListener((source, reason) => {
        if (!source?.tabId) {
            return;
        }
        const existingSession = debuggerSessions.get(source.tabId);
        if (existingSession) {
            if (existingSession.detailCaptureWaiters?.length) {
                for (const waiter of existingSession.detailCaptureWaiters) {
                    clearTimeout(waiter.timeoutId);
                    waiter.resolve(null);
                }
                existingSession.detailCaptureWaiters.length = 0;
            }
            debuggerSessions.delete(source.tabId);
            console.log(`${DEBUGGER_LOG_PREFIX} detached from tab ${source.tabId} (${reason}).`);
        }
    });

    debuggerListenersInstalled = true;
}

async function handleDebuggerEvent(source, method, params) {
    const tabId = source?.tabId;
    if (!tabId || !debuggerSessions.has(tabId)) {
        return;
    }

    const session = debuggerSessions.get(tabId);
    if (!session) {
        return;
    }

    if (method === 'Network.requestWillBeSent') {
        const requestId = String(params?.requestId || '');
        const request = params?.request || {};
        if (!requestId || !isGraphqlRequestUrl(request.url)) {
            return;
        }

        const alias = aliasFromGraphqlUrl(request.url);
        const likelyProposalList = isTargetGraphqlRequestUrl(request.url) ||
            isLikelyProposalsGraphqlRequest(request.url, request.postData);
        const likelyProposalDetails = isTargetDetailsGraphqlRequestUrl(request.url) ||
            isLikelyProposalDetailsGraphqlRequest(request.url, request.postData);

        session.requests.set(requestId, {
            requestId,
            url: String(request.url || ''),
            method: String(request.method || 'GET').toUpperCase(),
            alias,
            likelyProposalList,
            likelyProposalDetails,
            postData: String(request.postData || ''),
            requestStartedAtMs: Date.now(),
            responseMeta: null
        });
        session.stats.graphqlRequestsSeen += 1;
        if (likelyProposalList) {
            session.stats.likelyListRequests += 1;
        }
        if (likelyProposalDetails) {
            session.stats.likelyDetailsRequests += 1;
        }
        console.log(
            `${DEBUGGER_LOG_PREFIX} request captured tab=${tabId} id=${requestId} ` +
            `method=${String(request.method || 'GET').toUpperCase()} alias=${alias || 'none'} ` +
            `list=${likelyProposalList ? 'yes' : 'no'} details=${likelyProposalDetails ? 'yes' : 'no'}`
        );
        if (
            likelyProposalList ||
            likelyProposalDetails ||
            (DEBUGGER_VERBOSE_LOGS && (session.stats.graphqlRequestsSeen <= 10 || session.stats.graphqlRequestsSeen % 25 === 0))
        ) {
            await logDebuggerToTab(
                tabId,
                `${DEBUGGER_LOG_PREFIX} request captured alias=${alias || 'none'} list=${likelyProposalList ? 'yes' : 'no'} details=${likelyProposalDetails ? 'yes' : 'no'} url=${String(request.url || '')}`
            );
        }
        return;
    }

    if (method === 'Network.responseReceived') {
        const requestId = String(params?.requestId || '');
        const tracked = session.requests.get(requestId);
        if (!tracked) {
            return;
        }
        tracked.responseMeta = params?.response || null;
        return;
    }

    if (method === 'Network.loadingFailed') {
        const requestId = String(params?.requestId || '');
        if (!session.requests.has(requestId)) {
            return;
        }
        session.requests.delete(requestId);
        console.warn(`${DEBUGGER_LOG_PREFIX} request failed tab=${tabId} id=${requestId}`);
        return;
    }

    if (method === 'Network.loadingFinished') {
        const requestId = String(params?.requestId || '');
        const tracked = session.requests.get(requestId);
        if (!tracked) {
            return;
        }

        session.requests.delete(requestId);

        let responseBodyResult;
        try {
            responseBodyResult = await debuggerSendCommand(source, 'Network.getResponseBody', { requestId });
        } catch (error) {
            session.stats.parseFailed += 1;
            console.warn(`${DEBUGGER_LOG_PREFIX} getResponseBody failed for ${requestId}:`, error.message);
            return;
        }

        const responseText = decodeDebuggerResponseBody(responseBodyResult);

        if (session.captureMode === 'details') {
            if (!tracked.likelyProposalDetails) {
                session.stats.nonTargetResponsesIgnored += 1;
                return;
            }

            session.stats.detailsResponsesCaptured += 1;
            const parsedResponse = safeParseJsonPayload(responseText);
            if (!parsedResponse) {
                session.stats.parseFailed += 1;
                console.warn(
                    `${DEBUGGER_LOG_PREFIX} details response parse failed tab=${tabId} id=${requestId} alias=${tracked.alias || 'none'}`
                );
                return;
            }

            const activeContext = session.activeDetailContext ? { ...session.activeDetailContext } : null;
            const href = String(activeContext?.href || '').trim();
            if (!href) {
                session.stats.nonTargetResponsesIgnored += 1;
                if (DEBUGGER_VERBOSE_LOGS) {
                    console.log(
                        `${DEBUGGER_LOG_PREFIX} details response ignored because active context is missing ` +
                        `tab=${tabId} id=${requestId} alias=${tracked.alias || 'none'}`
                    );
                }
                return;
            }

            const upsertResult = await queueProposalDetailsUpsert(
                {
                    ...activeContext,
                    rawGraphql: parsedResponse?.data ?? parsedResponse
                },
                `debugger:${tracked.method.toLowerCase()}`
            );
            session.stats.detailsUpsertOps += 1;
            if (upsertResult) {
                session.stats.detailsUpsertedEntries += 1;
            }

            const detailPayload = {
                href,
                alias: tracked.alias || '',
                len: responseText.length
            };
            resolveDetailCaptureWaiters(session, href, detailPayload);

            await logDebuggerToTab(
                tabId,
                `${DEBUGGER_LOG_PREFIX} details response alias=${tracked.alias || 'none'} href=${href} len=${responseText.length} total=${upsertResult?.totalSize || '?'}`
            );
            return;
        }

        if (!tracked.likelyProposalList) {
            session.stats.nonTargetResponsesIgnored += 1;
            return;
        }

        const links = extractProposalLinksFromGraphqlResponse(responseText, session.scrapeMode);
        session.stats.responsesCaptured += 1;

        if (!links.length) {
            session.stats.parseFailed += 1;
            if (DEBUGGER_VERBOSE_LOGS) {
                const preview = responseText.replace(/\s+/g, ' ').slice(0, 100);
                console.log(
                    `${DEBUGGER_LOG_PREFIX} response captured tab=${tabId} id=${requestId} ` +
                    `alias=${tracked.alias || 'none'} likely=${tracked.likelyProposalList ? 'yes' : 'no'} ` +
                    `len=${responseText.length} links=0 preview="${preview || '<empty>'}"`
                );
            }
            return;
        }

        session.stats.linksRecovered += links.length;
        const upsertResult = await queueProposalListUpsert(
            links,
            `debugger:${tracked.method.toLowerCase()}`
        );
        session.stats.upsertOps += 1;
        session.stats.upsertedEntries += upsertResult?.upsertedCount || 0;

        console.log(
            `${DEBUGGER_LOG_PREFIX} response captured tab=${tabId} id=${requestId} ` +
            `alias=${tracked.alias || 'none'} likely=${tracked.likelyProposalList ? 'yes' : 'no'} ` +
            `len=${responseText.length} links=${links.length} ` +
            `upserted=${upsertResult?.upsertedCount || 0} totalList=${upsertResult?.totalSize || 0}`
        );
        await logDebuggerToTab(
            tabId,
            `${DEBUGGER_LOG_PREFIX} response alias=${tracked.alias || 'none'} likely=${tracked.likelyProposalList ? 'yes' : 'no'} len=${responseText.length} links=${links.length} upserted=${upsertResult?.upsertedCount || 0} total=${upsertResult?.totalSize || 0}`
        );
    }
}

async function startDebuggerCaptureForTab(tabId, options = {}) {
    ensureDebuggerListeners();
    const scrapeMode = options?.scrapeMode === 'all' ? 'all' : 'successful';
    const captureMode = options?.captureMode === 'details' ? 'details' : 'list';

    if (debuggerSessions.has(tabId)) {
        const existingSession = debuggerSessions.get(tabId);
        if (existingSession) {
            existingSession.scrapeMode = scrapeMode;
            existingSession.captureMode = captureMode;
        }
        return true;
    }

    try {
        await debuggerAttach(tabId);
        const source = { tabId };
        await debuggerSendCommand(source, 'Network.enable', {});
        await debuggerSendCommand(source, 'Network.setCacheDisabled', { cacheDisabled: true });

        debuggerSessions.set(tabId, {
            tabId,
            source,
            scrapeMode,
            captureMode,
            requests: new Map(),
            activeDetailContext: null,
            capturedDetailHrefs: new Set(),
            detailCaptureWaiters: [],
            stats: {
                graphqlRequestsSeen: 0,
                likelyListRequests: 0,
                likelyDetailsRequests: 0,
                responsesCaptured: 0,
                detailsResponsesCaptured: 0,
                nonTargetResponsesIgnored: 0,
                parseFailed: 0,
                linksRecovered: 0,
                upsertOps: 0,
                upsertedEntries: 0,
                detailsUpsertOps: 0,
                detailsUpsertedEntries: 0
            }
        });

        console.log(`${DEBUGGER_LOG_PREFIX} attached to tab ${tabId}.`);
        await logDebuggerToTab(tabId, `${DEBUGGER_LOG_PREFIX} attached to tab ${tabId}.`);
        return true;
    } catch (error) {
        console.warn(`${DEBUGGER_LOG_PREFIX} could not attach to tab ${tabId}:`, error.message);
        await logDebuggerToTab(tabId, `${DEBUGGER_LOG_PREFIX} could not attach: ${error.message}`);
        return false;
    }
}

async function stopDebuggerCaptureForTab(tabId) {
    const session = debuggerSessions.get(tabId);
    debuggerSessions.delete(tabId);

    if (session?.detailCaptureWaiters?.length) {
        for (const waiter of session.detailCaptureWaiters) {
            clearTimeout(waiter.timeoutId);
            waiter.resolve(null);
        }
        session.detailCaptureWaiters.length = 0;
    }

    try {
        await new Promise((resolve) => setTimeout(resolve, 600));
        await debuggerDetach(tabId);
    } catch (error) {
        console.warn(`${DEBUGGER_LOG_PREFIX} detach failed for tab ${tabId}:`, error.message);
    }

    if (session) {
        const stats = session.stats;
        const summary = (
            `${DEBUGGER_LOG_PREFIX} summary tab=${tabId} graphql=${stats.graphqlRequestsSeen} ` +
            `likelyList=${stats.likelyListRequests} likelyDetails=${stats.likelyDetailsRequests} ` +
            `ignored=${stats.nonTargetResponsesIgnored} ` +
            `listResponses=${stats.responsesCaptured} links=${stats.linksRecovered} ` +
            `detailResponses=${stats.detailsResponsesCaptured} ` +
            `parseFailed=${stats.parseFailed} listUpserts=${stats.upsertOps}/${stats.upsertedEntries} ` +
            `detailUpserts=${stats.detailsUpsertOps}/${stats.detailsUpsertedEntries}`
        );
        console.log(summary);
        await logDebuggerToTab(tabId, summary);
    }
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'startScraping') {
        const scrapeMode = normalizeScrapeMode(request.scrapeMode);
        startScrapingFlow(scrapeMode).catch((error) => {
            console.error('Failed to start proposal scraping:', error);
        });
        return;
    }

    if (request.action === 'startArchivedListScraping') {
        const scrapeMode = normalizeScrapeMode(request.scrapeMode);
        startArchivedListScrapingFlow(scrapeMode).catch((error) => {
            console.error('Failed to start archived proposal list scraping:', error);
        });
        return;
    }

    if (request.action === 'startCurrentJobPostScraping') {
        startCurrentJobPostScrapingFlow().catch((error) => {
            console.error('Failed to start current job post scraping:', error);
        });
        return;
    }

    if (request.action === 'startJobPostsFromSavedListScraping') {
        const scrapeMode = normalizeScrapeMode(request.scrapeMode);
        startJobPostsFromSavedListScrapingFlow(scrapeMode).catch((error) => {
            console.error('Failed to start saved-list job post scraping:', error);
        });
        return;
    }

    if (request.action === 'repairSavedJobPostUrls') {
        repairSavedJobPostUrls()
            .then((summary) => {
                sendResponse({ ok: true, summary });
            })
            .catch((error) => {
                console.error('Failed to repair saved job post URLs:', error);
                sendResponse({ ok: false, error: error?.message || 'Unknown repair failure' });
            });
        return true;
    }
});

function hasCapturedDetailsRaw(entry) {
    return entry?.proposalDetailsPage?.rawGraphql !== undefined &&
        entry?.proposalDetailsPage?.rawGraphql !== null;
}

async function buildPendingDetailLinks(scrapeMode) {
    const storageData = await chrome.storage.local.get(['proposalList', 'proposals']);
    const proposalList = Array.isArray(storageData.proposalList) ? storageData.proposalList : [];
    const proposals = Array.isArray(storageData.proposals) ? storageData.proposals : [];
    const capturedByHref = new Set();

    for (const entry of proposals) {
        const href = extractExistingProposalHref(entry);
        if (!href) {
            continue;
        }
        if (hasCapturedDetailsRaw(entry)) {
            capturedByHref.add(href);
        }
    }

    const pending = [];
    const seen = new Set();
    for (const entry of proposalList) {
        const normalized = normalizeLinkData(entry);
        if (!normalized) {
            continue;
        }
        if (!isReasonAllowedForMode(normalized.reason, scrapeMode)) {
            continue;
        }
        if (capturedByHref.has(normalized.href)) {
            continue;
        }
        if (seen.has(normalized.href)) {
            continue;
        }
        seen.add(normalized.href);
        pending.push(normalized);
    }

    return {
        proposalList,
        proposals,
        pending
    };
}

async function runDebuggerProposalDetailsFlow(tabId, scrapeMode) {
    const { pending, proposalList, proposals } = await buildPendingDetailLinks(scrapeMode);
    const startedAtIso = new Date().toISOString();
    await queueProposalDetailsSummaryUpdate({
        mode: scrapeMode,
        startedAt: startedAtIso,
        finishedAt: null,
        inProgress: true,
        totalPending: pending.length,
        captured: 0,
        timedOut: 0,
        currentIndex: 0,
        currentHref: '',
        listSize: proposalList.length,
        proposalsSize: proposals.length
    }, { reset: true });
    await logDebuggerToTab(
        tabId,
        `${DEBUGGER_LOG_PREFIX} details run started. list=${proposalList.length} proposals=${proposals.length} pending=${pending.length} mode=${scrapeMode}`
    );

    if (!pending.length) {
        console.log(`${DEBUGGER_LOG_PREFIX} details run found no pending proposal links.`);
        await logDebuggerToTab(tabId, `${DEBUGGER_LOG_PREFIX} details run found no pending proposal links.`);
        await queueProposalDetailsSummaryUpdate({
            inProgress: false,
            finishedAt: new Date().toISOString(),
            status: 'no-pending-links'
        });
        return;
    }

    let captured = 0;
    let timedOut = 0;
    for (let index = 0; index < pending.length; index += 1) {
        const link = pending[index];
        await queueProposalDetailsSummaryUpdate({
            currentIndex: index + 1,
            currentHref: link.href
        });
        setActiveDetailContext(tabId, link);
        await logDebuggerToTab(
            tabId,
            `${DEBUGGER_LOG_PREFIX} details ${index + 1}/${pending.length} navigating ${link.href}`
        );

        await chrome.tabs.update(tabId, { url: link.href });
        await waitForTabReady(tabId, UPWORK_ROOT_URL);
        const capturedPayload = await waitForDetailCapture(tabId, link.href, DEBUGGER_DETAILS_RESPONSE_WAIT_MS);

        if (capturedPayload) {
            captured += 1;
            await queueProposalDetailsSummaryUpdate({ captured });
            await logDebuggerToTab(
                tabId,
                `${DEBUGGER_LOG_PREFIX} details ${index + 1}/${pending.length} captured alias=${capturedPayload.alias || 'unknown'} href=${link.href}`
            );
        } else {
            timedOut += 1;
            await queueProposalDetailsSummaryUpdate({ timedOut });
            console.warn(`${DEBUGGER_LOG_PREFIX} details capture timeout for ${link.href}`);
            await logDebuggerToTab(
                tabId,
                `${DEBUGGER_LOG_PREFIX} details ${index + 1}/${pending.length} timed out for ${link.href}`
            );
        }

        await new Promise((resolve) => setTimeout(resolve, DEBUGGER_DETAILS_INTER_ITEM_DELAY_MS));
    }

    clearActiveDetailContext(tabId);
    await queueProposalDetailsSummaryUpdate({
        inProgress: false,
        finishedAt: new Date().toISOString(),
        currentHref: '',
        status: 'completed',
        captured,
        timedOut
    });
    await logDebuggerToTab(
        tabId,
        `${DEBUGGER_LOG_PREFIX} details run complete. captured=${captured} timedOut=${timedOut} total=${pending.length}`
    );
}

async function startScrapingFlow(scrapeMode = DEFAULT_SCRAPE_MODE) {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    let targetTabId;
    if (currentTab?.url?.startsWith(ARCHIVED_PROPOSALS_URL)) {
        targetTabId = currentTab.id;
    } else {
        const newTab = await chrome.tabs.create({ url: ARCHIVED_PROPOSALS_URL });
        targetTabId = newTab.id;
    }

    await waitForTabReady(targetTabId, ARCHIVED_PROPOSALS_URL);
    const debuggerAttached = await startDebuggerCaptureForTab(targetTabId, {
        scrapeMode,
        captureMode: 'details'
    });
    if (!debuggerAttached) {
        throw new Error(
            'Proposal details capture requires debugger attachment. ' +
            'Close DevTools for this tab (if open) and retry.'
        );
    }

    try {
        try {
            await runDebuggerProposalDetailsFlow(targetTabId, scrapeMode);
        } catch (error) {
            await queueProposalDetailsSummaryUpdate({
                inProgress: false,
                finishedAt: new Date().toISOString(),
                status: 'failed',
                error: error?.message || 'unknown details capture failure'
            });
            throw error;
        }
    } finally {
        await stopDebuggerCaptureForTab(targetTabId);
        await chrome.tabs.update(targetTabId, { url: ARCHIVED_PROPOSALS_URL });
    }
}

async function startArchivedListScrapingFlow(scrapeMode = DEFAULT_SCRAPE_MODE) {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    let targetTabId;
    if (currentTab?.url?.startsWith(ARCHIVED_PROPOSALS_URL)) {
        targetTabId = currentTab.id;
    } else {
        const newTab = await chrome.tabs.create({ url: ARCHIVED_PROPOSALS_URL });
        targetTabId = newTab.id;
    }

    await waitForTabReady(targetTabId, ARCHIVED_PROPOSALS_URL);
    let debuggerAttached = false;
    if (DEBUGGER_ENABLED_FOR_LIST_SCRAPE) {
        debuggerAttached = await startDebuggerCaptureForTab(targetTabId, {
            scrapeMode,
            captureMode: 'list'
        });
        if (!debuggerAttached) {
            throw new Error(
                'Archived list capture requires debugger attachment. ' +
                'Close DevTools for this tab (if open) and retry.'
            );
        }
    }
    await ensureInjectedScraperHelpers(targetTabId, {
        injectMainWorldHelpers: !debuggerAttached
    });

    try {
        await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            function: scrapeProposals,
            args: [{
                scrapeMode,
                scrapeArchivedListOnly: true,
                useDebuggerProposalListCapture: debuggerAttached,
                disableNetworkMonitor: debuggerAttached
            }]
        });
    } finally {
        if (debuggerAttached) {
            await stopDebuggerCaptureForTab(targetTabId);
        }
    }
}

async function startJobPostsFromSavedListScrapingFlow(scrapeMode = DEFAULT_SCRAPE_MODE) {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    let targetTabId;
    if (currentTab?.url?.startsWith(ARCHIVED_PROPOSALS_URL)) {
        targetTabId = currentTab.id;
    } else {
        const newTab = await chrome.tabs.create({ url: ARCHIVED_PROPOSALS_URL });
        targetTabId = newTab.id;
    }

    await waitForTabReady(targetTabId, ARCHIVED_PROPOSALS_URL);
    await ensureInjectedScraperHelpers(targetTabId);
    await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        function: scrapeProposals,
        args: [{ scrapeMode, scrapeJobPostsFromSavedList: true }]
    });
}

async function startCurrentJobPostScrapingFlow() {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!currentTab?.id) {
        throw new Error('No active tab found for current job post scraping.');
    }
    if (!String(currentTab.url || '').startsWith(UPWORK_ROOT_URL)) {
        throw new Error('Current job post scraping requires an active Upwork tab.');
    }

    await waitForTabReady(currentTab.id, UPWORK_ROOT_URL);
    await ensureInjectedScraperHelpers(currentTab.id);
    await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        function: scrapeProposals,
        args: [{ scrapeCurrentJobPost: true }]
    });
}

async function ensureInjectedScraperHelpers(tabId, options = {}) {
    const injectMainWorldHelpers = options.injectMainWorldHelpers !== false;

    if (injectMainWorldHelpers) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                files: MAIN_WORLD_SCRAPER_HELPER_FILES
            });
        } catch (error) {
            console.warn('Failed to inject main-world scraper helpers:', error);
        }
    }

    await chrome.scripting.executeScript({
        target: { tabId },
        files: INJECTED_SCRAPER_HELPER_FILES
    });
}
