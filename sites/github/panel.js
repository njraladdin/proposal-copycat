window.mountGithubPanel = function() {
    const SNAPSHOT_STORAGE_KEY = 'githubProfileSnapshot';
    const STATUS_STORAGE_KEY = 'githubProfileStatus';
    const LOADING_STORAGE_KEY = 'githubProfileIsLoading';

    const btnFetch = document.getElementById('startGithubScraping');
    const btnClear = document.getElementById('clearGithubData');
    const btnLoad = document.getElementById('loadGithubJson');
    const btnDownload = document.getElementById('downloadGithubJson');
    const btnCopy = document.getElementById('copyGithubJson');
    const warningEl = document.getElementById('githubProfileWarning');
    const statusEl = document.getElementById('githubStatusHeadline');
    const profileEl = document.getElementById('githubProfileHeadline');
    const rateLimitEl = document.getElementById('githubRateLimitHeadline');
    const repoCountEl = document.getElementById('githubRepoCount');
    const textareaEl = document.getElementById('githubJsonOutput');

    let isJsonLoaded = false;
    let latestSnapshot = null;

    function buildExportFilename(snapshot) {
        const now = new Date();
        const pad = (value) => String(value).padStart(2, '0');
        const login = snapshot?.profile?.login || 'github-profile';
        return `github-public-profile-${login}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}.json`;
    }

    function parseGithubProfileTab(url) {
        if (!url) return null;

        let parsed;
        try {
            parsed = new URL(url);
        } catch (_error) {
            return null;
        }

        const hostname = String(parsed.hostname || '').toLowerCase();
        if (hostname !== 'github.com' && hostname !== 'www.github.com') {
            return null;
        }

        const segments = parsed.pathname.split('/').filter(Boolean);
        return segments.length === 1 ? segments[0] : null;
    }

    function updateRepoCount(snapshot) {
        const repoCount = Array.isArray(snapshot?.repos) ? snapshot.repos.length : 0;
        if (repoCountEl) repoCountEl.textContent = String(repoCount);
    }

    function renderSnapshotSummary(snapshot) {
        latestSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : null;
        updateRepoCount(latestSnapshot);

        if (!profileEl || !rateLimitEl) {
            return;
        }

        if (!latestSnapshot) {
            profileEl.textContent = 'No GitHub snapshot saved yet.';
            rateLimitEl.textContent = 'GitHub public API rate limit details will appear after a run.';
            return;
        }

        const profile = latestSnapshot.profile || {};
        const summary = latestSnapshot.summary || {};
        const readmesFetched = Number(summary.readmesFetched || 0);
        const readmesMissing = Number(summary.readmesMissing || 0);
        const readmesErrored = Number(summary.readmesErrored || 0);
        const readmesSkipped = Number(summary.readmesSkipped || 0);
        const readmesFetchedThisRun = Number(summary.readmesFetchedThisRun || 0);
        const readmesReused = Number(summary.readmesReused || 0);
        const repoCount = Array.isArray(latestSnapshot.repos) ? latestSnapshot.repos.length : 0;

        profileEl.textContent = `${profile.login || 'Unknown profile'} (${profile.type || 'User'}) - ${repoCount} public repos, ${readmesFetched} READMEs fetched, ${readmesMissing} missing, ${readmesErrored} errored, ${readmesSkipped} skipped. This run: ${readmesFetchedThisRun} fetched, ${readmesReused} reused from cache.`;

        const rateLimit = summary.rateLimit || {};
        if (Number.isFinite(rateLimit.remaining) && Number.isFinite(rateLimit.limit)) {
            const resetLabel = rateLimit.resetAt
                ? new Date(rateLimit.resetAt).toLocaleString()
                : 'unknown';
            rateLimitEl.textContent = `GitHub public API remaining: ${rateLimit.remaining}/${rateLimit.limit}. Reset: ${resetLabel}.`;
        } else {
            rateLimitEl.textContent = 'GitHub did not return readable rate limit headers for the last run.';
        }
    }

    function renderSnapshotJson(snapshot) {
        if (!textareaEl) return;
        textareaEl.value = JSON.stringify(snapshot || {}, null, 2);
        isJsonLoaded = true;
    }

    function setJsonPlaceholder(message) {
        if (textareaEl) textareaEl.value = message;
        isJsonLoaded = false;
    }

    async function syncActiveTabWarning() {
        try {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const login = parseGithubProfileTab(activeTab?.url);
            if (warningEl) {
                warningEl.style.display = login ? 'none' : 'block';
            }
        } catch (_error) {
            if (warningEl) warningEl.style.display = 'none';
        }
    }

    function syncLoadingState(isLoading) {
        if (btnFetch) {
            btnFetch.disabled = isLoading;
            btnFetch.textContent = isLoading ? 'Fetching...' : 'Fetch Public Repos';
        }
        if (btnClear) {
            btnClear.disabled = isLoading;
        }
    }

    async function loadSnapshot(force = false) {
        if (!force && isJsonLoaded && latestSnapshot) return;

        try {
            if (btnLoad) {
                btnLoad.disabled = true;
                btnLoad.textContent = 'Loading...';
            }

            const data = await chrome.storage.local.get([SNAPSHOT_STORAGE_KEY, STATUS_STORAGE_KEY, LOADING_STORAGE_KEY]);
            renderSnapshotSummary(data[SNAPSHOT_STORAGE_KEY]);
            renderSnapshotJson(data[SNAPSHOT_STORAGE_KEY] || {});
            if (statusEl && data[STATUS_STORAGE_KEY]) {
                statusEl.textContent = data[STATUS_STORAGE_KEY];
            }
            syncLoadingState(data[LOADING_STORAGE_KEY] === true);
        } catch (error) {
            console.error('Failed to load GitHub snapshot:', error);
            setJsonPlaceholder('Failed to load GitHub JSON.');
        } finally {
            if (btnLoad) {
                btnLoad.disabled = false;
                btnLoad.textContent = 'Load JSON';
            }
        }
    }

    if (btnFetch) {
        btnFetch.addEventListener('click', async () => {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const login = parseGithubProfileTab(activeTab?.url);
            if (!login) {
                if (warningEl) warningEl.style.display = 'block';
                if (statusEl) statusEl.textContent = 'Error: open a GitHub profile page first.';
                return;
            }

            if (warningEl) warningEl.style.display = 'none';
            syncLoadingState(true);
            if (statusEl) statusEl.textContent = `Starting GitHub fetch for ${login}...`;

            try {
                chrome.runtime.sendMessage({ action: 'startGithubProfileScrape' }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.error(chrome.runtime.lastError);
                        if (statusEl) statusEl.textContent = 'Error: failed to start GitHub scrape.';
                        syncLoadingState(false);
                        return;
                    }

                    if (response && response.success === false && statusEl) {
                        statusEl.textContent = `Error: ${response.error || 'GitHub scrape failed.'}`;
                        syncLoadingState(false);
                    }
                });
            } catch (error) {
                console.error('Failed to start GitHub scrape:', error);
                if (statusEl) statusEl.textContent = `Error: ${error.message || String(error)}`;
                syncLoadingState(false);
            }
        });
    }

    if (btnClear) {
        btnClear.addEventListener('click', async () => {
            if (!confirm('Clear the saved GitHub snapshot?')) {
                return;
            }

            try {
                chrome.runtime.sendMessage({ action: 'clearGithubProfileData' }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.error(chrome.runtime.lastError);
                        if (statusEl) statusEl.textContent = 'Error: failed to clear GitHub data.';
                        return;
                    }

                    if (response?.success === false && statusEl) {
                        statusEl.textContent = `Error: ${response.error || 'Could not clear GitHub data.'}`;
                    }
                });
                renderSnapshotSummary(null);
                setJsonPlaceholder('JSON not loaded yet. Click "Load JSON".');
            } catch (error) {
                console.error('Failed to clear GitHub data:', error);
            }
        });
    }

    if (btnLoad) {
        btnLoad.addEventListener('click', () => {
            loadSnapshot(true);
        });
    }

    if (btnCopy) {
        btnCopy.addEventListener('click', async () => {
            if (!isJsonLoaded) {
                await loadSnapshot(true);
            }

            if (textareaEl && textareaEl.value) {
                await navigator.clipboard.writeText(textareaEl.value);
                const originalText = btnCopy.textContent;
                btnCopy.textContent = 'Copied!';
                setTimeout(() => {
                    btnCopy.textContent = originalText;
                }, 1500);
            }
        });
    }

    if (btnDownload) {
        btnDownload.addEventListener('click', async () => {
            try {
                const data = await chrome.storage.local.get(SNAPSHOT_STORAGE_KEY);
                const snapshot = data[SNAPSHOT_STORAGE_KEY] || {};
                const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = buildExportFilename(snapshot);
                document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1500);
            } catch (error) {
                console.error('Download failed:', error);
                alert('Download failed.');
            }
        });
    }

    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace !== 'local') {
            return;
        }

        if (changes[STATUS_STORAGE_KEY] && statusEl) {
            statusEl.textContent = changes[STATUS_STORAGE_KEY].newValue || 'Ready.';
        }

        if (changes[LOADING_STORAGE_KEY]) {
            syncLoadingState(changes[LOADING_STORAGE_KEY].newValue === true);
        }

        if (changes[SNAPSHOT_STORAGE_KEY]) {
            renderSnapshotSummary(changes[SNAPSHOT_STORAGE_KEY].newValue || null);

            if (isJsonLoaded) {
                renderSnapshotJson(changes[SNAPSHOT_STORAGE_KEY].newValue || {});
            } else {
                setJsonPlaceholder('Data changed. Click "Load JSON" to refresh.');
            }
        }
    });

    async function init() {
        setJsonPlaceholder('JSON not loaded yet. Click "Load JSON".');
        await syncActiveTabWarning();

        try {
            const data = await chrome.storage.local.get([SNAPSHOT_STORAGE_KEY, STATUS_STORAGE_KEY, LOADING_STORAGE_KEY]);
            renderSnapshotSummary(data[SNAPSHOT_STORAGE_KEY] || null);
            if (statusEl && data[STATUS_STORAGE_KEY]) {
                statusEl.textContent = data[STATUS_STORAGE_KEY];
            }
            syncLoadingState(data[LOADING_STORAGE_KEY] === true);
        } catch (error) {
            console.error('GitHub panel init failed:', error);
        }
    }

    init();
};
