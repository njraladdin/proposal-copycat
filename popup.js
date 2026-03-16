const UPWORK_JOB_POST_URL_PATTERN = /^https:\/\/www\.upwork\.com\/jobs\/[^/?#]+/i;
const POPUP_TAB_STORAGE_KEY = 'popupActiveTab';

let isAuthValid = true;
let isOnJobPostPage = false;
let latestProposalDetailsSummary = null;
const DATASET_CONFIG = {
    proposalList: {
        storageKey: 'proposalList',
        countId: 'proposalListCount',
        textareaId: 'proposalListJsonOutput',
        loadButtonId: 'loadProposalListJson'
    },
    proposals: {
        storageKey: 'proposals',
        countId: 'proposalCount',
        textareaId: 'rawJsonOutput',
        loadButtonId: 'loadRawJson'
    },
    activeJobPost: {
        storageKey: 'activeJobPost',
        countId: 'activeJobPostCount',
        textareaId: 'activeJobJsonOutput',
        loadButtonId: 'loadActiveJobJson'
    },
    jobPosts: {
        storageKey: 'jobPosts',
        countId: 'jobPostCount',
        textareaId: 'jobRawJsonOutput',
        loadButtonId: 'loadJobJson'
    }
};
const datasetState = {
    proposalList: { loaded: false, dirty: false },
    proposals: { loaded: false, dirty: false },
    activeJobPost: { loaded: false, dirty: false },
    jobPosts: { loaded: false, dirty: false }
};

function normalizeScrapeMode(value) {
    return value === 'all' ? 'all' : 'successful';
}

function normalizePopupTab(value) {
    return value === 'jobPostsPanel' ? 'jobPostsPanel' : 'proposalsPanel';
}

function isUpworkJobPostUrl(url) {
    return UPWORK_JOB_POST_URL_PATTERN.test(String(url || ''));
}

function updateActionButtonState() {
    const startScrapingBtn = document.getElementById('startScraping');
    const startListScrapingBtn = document.getElementById('startListScraping');
    const startJobScrapingBtn = document.getElementById('startJobScraping');
    const startJobFromListScrapingBtn = document.getElementById('startJobFromListScraping');
    const repairSavedJobUrlsBtn = document.getElementById('repairSavedJobUrls');
    startScrapingBtn.disabled = !isAuthValid;
    startListScrapingBtn.disabled = !isAuthValid;
    startJobFromListScrapingBtn.disabled = !isAuthValid;
    startJobScrapingBtn.disabled = !isAuthValid || !isOnJobPostPage;
    if (repairSavedJobUrlsBtn) {
        repairSavedJobUrlsBtn.disabled = false;
    }
}

function showAuthWarning() {
    const warning = document.getElementById('authWarning');
    warning.style.display = 'block';
    isAuthValid = false;
    updateActionButtonState();
}

function removeAuthWarning() {
    const warning = document.getElementById('authWarning');
    warning.style.display = 'none';
    isAuthValid = true;
    updateActionButtonState();
}

function setJobPageWarning(isVisible) {
    const warning = document.getElementById('jobPageWarning');
    warning.style.display = isVisible ? 'block' : 'none';
}

async function checkUpworkAuth() {
    try {
        const upworkTabs = await chrome.tabs.query({ url: ['https://www.upwork.com/*'] });

        if (!upworkTabs.length) {
            removeAuthWarning();
            return true;
        }

        const tabToCheck = upworkTabs.find((tab) => tab.active) || upworkTabs[0];
        if (!tabToCheck?.id) {
            removeAuthWarning();
            return true;
        }

        const [authCheck] = await chrome.scripting.executeScript({
            target: { tabId: tabToCheck.id },
            function: () => {
                const currentUrl = window.location.href.toLowerCase();
                const bodyText = (document.body?.innerText || '').toLowerCase();

                const isLoginPage =
                    currentUrl.includes('/ab/account-security/login') ||
                    currentUrl.includes('/login');

                const hasLoginPrompt =
                    bodyText.includes('log in to upwork') ||
                    bodyText.includes('continue with google') ||
                    bodyText.includes('forgot password');

                return { isLoginPage, hasLoginPrompt };
            }
        });

        if (authCheck?.result?.isLoginPage || authCheck?.result?.hasLoginPrompt) {
            showAuthWarning();
            return false;
        }

        removeAuthWarning();
        return true;
    } catch (error) {
        console.warn('Unable to verify auth automatically:', error);
        removeAuthWarning();
        return true;
    }
}

async function refreshJobPageState() {
    try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        isOnJobPostPage = isUpworkJobPostUrl(activeTab?.url);
        setJobPageWarning(!isOnJobPostPage);
    } catch (error) {
        console.warn('Unable to inspect active tab URL:', error);
        isOnJobPostPage = false;
        setJobPageWarning(true);
    }
    updateActionButtonState();
    return isOnJobPostPage;
}

function normalizeDatasetItems(value) {
    return Array.isArray(value) ? value : [];
}

function setDatasetCount(datasetKey, value) {
    const config = DATASET_CONFIG[datasetKey];
    if (!config) {
        return;
    }
    const items = normalizeDatasetItems(value);
    document.getElementById(config.countId).textContent = String(items.length);
}

function setDatasetPlaceholder(datasetKey, message) {
    const config = DATASET_CONFIG[datasetKey];
    if (!config) {
        return;
    }
    document.getElementById(config.textareaId).value = message;
}

function renderDatasetJson(datasetKey, value) {
    const config = DATASET_CONFIG[datasetKey];
    if (!config) {
        return;
    }
    const items = normalizeDatasetItems(value);
    setDatasetCount(datasetKey, items);
    document.getElementById(config.textareaId).value = JSON.stringify(items, null, 2);
    datasetState[datasetKey].loaded = true;
    datasetState[datasetKey].dirty = false;
}

async function loadDatasetJson(datasetKey, options = {}) {
    const config = DATASET_CONFIG[datasetKey];
    const state = datasetState[datasetKey];
    if (!config || !state) {
        return;
    }

    const force = options.force === true;
    if (!force && state.loaded && !state.dirty) {
        return;
    }

    const loadButton = document.getElementById(config.loadButtonId);
    const originalText = loadButton?.textContent || 'Load JSON';
    if (loadButton) {
        loadButton.disabled = true;
        loadButton.textContent = 'Loading...';
    }

    try {
        const storageData = await chrome.storage.local.get(config.storageKey);
        const items = normalizeDatasetItems(storageData[config.storageKey]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        renderDatasetJson(datasetKey, items);
    } catch (error) {
        console.error(`Failed to load ${config.storageKey} JSON:`, error);
        setDatasetPlaceholder(datasetKey, `Failed to load ${config.storageKey}. Check console.`);
    } finally {
        if (loadButton) {
            loadButton.disabled = false;
            loadButton.textContent = originalText;
        }
    }
}

async function ensureDatasetLoaded(datasetKey) {
    const state = datasetState[datasetKey];
    if (!state || (state.loaded && !state.dirty)) {
        return;
    }
    await loadDatasetJson(datasetKey, { force: true });
}

async function refreshCountsOnly() {
    const data = await chrome.storage.local.get(['proposalList', 'proposals', 'activeJobPost', 'jobPosts']);
    setDatasetCount('proposalList', data.proposalList);
    setDatasetCount('proposals', data.proposals);
    setDatasetCount('activeJobPost', data.activeJobPost);
    setDatasetCount('jobPosts', data.jobPosts);
}

function formatDateTime(value) {
    const ms = Date.parse(String(value || ''));
    if (!Number.isFinite(ms)) {
        return '-';
    }
    return new Date(ms).toLocaleString();
}

function formatDurationShort(ms) {
    if (!Number.isFinite(ms) || ms <= 0) {
        return '<1m';
    }
    const totalSeconds = Math.max(1, Math.round(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
}

function renderProposalDetailsSummary(summary) {
    const headlineEl = document.getElementById('detailsStatusHeadline');
    const countsEl = document.getElementById('detailsStatusCounts');
    const etaEl = document.getElementById('detailsStatusEta');
    const currentEl = document.getElementById('detailsStatusCurrent');
    const timesEl = document.getElementById('detailsStatusTimes');

    const safeSummary = summary && typeof summary === 'object' ? summary : null;
    latestProposalDetailsSummary = safeSummary;

    if (!safeSummary) {
        headlineEl.textContent = 'No recent run summary yet.';
        countsEl.textContent = 'Progress: -';
        etaEl.textContent = 'ETA: -';
        currentEl.textContent = 'Current: -';
        timesEl.textContent = 'Started: -';
        return;
    }

    const status = String(safeSummary.status || (safeSummary.inProgress ? 'running' : 'idle'));
    const total = Number.parseInt(String(safeSummary.totalPending || 0), 10) || 0;
    const currentIndex = Number.parseInt(String(safeSummary.currentIndex || 0), 10) || 0;
    const captured = Number.parseInt(String(safeSummary.captured || 0), 10) || 0;
    const timedOut = Number.parseInt(String(safeSummary.timedOut || 0), 10) || 0;
    const attempted = Math.max(captured + timedOut, Math.max(currentIndex - 1, 0));
    const remaining = Math.max(total - attempted, 0);

    headlineEl.textContent = safeSummary.inProgress
        ? `Status: running (${status})`
        : `Status: ${status}`;
    countsEl.textContent = `Progress: ${attempted}/${total} | Captured: ${captured} | Timed out: ${timedOut}`;
    currentEl.textContent = `Current: ${safeSummary.currentHref || '-'}`;

    const startedMs = Date.parse(String(safeSummary.startedAt || ''));
    const elapsedMs = Number.isFinite(startedMs) ? Math.max(Date.now() - startedMs, 0) : NaN;
    if (safeSummary.inProgress && attempted > 0 && Number.isFinite(elapsedMs) && remaining > 0) {
        const etaMs = (elapsedMs / attempted) * remaining;
        etaEl.textContent = `ETA: ${formatDurationShort(etaMs)}`;
    } else if (safeSummary.inProgress) {
        etaEl.textContent = 'ETA: calculating...';
    } else {
        etaEl.textContent = 'ETA: done';
    }

    timesEl.textContent = `Started: ${formatDateTime(safeSummary.startedAt)} | Finished: ${formatDateTime(safeSummary.finishedAt)}`;
}

function buildExportFilename(prefix) {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    return `${prefix}-${timestamp}.json`;
}

async function copyFromTextarea(buttonId, textareaId) {
    const button = document.getElementById(buttonId);
    const originalText = button.textContent;
    await navigator.clipboard.writeText(document.getElementById(textareaId).value);
    button.textContent = 'Copied';
    setTimeout(() => {
        button.textContent = originalText;
    }, 1200);
}

async function downloadJson(buttonId, storageKey, filenamePrefix) {
    const button = document.getElementById(buttonId);
    const originalText = button.textContent;

    try {
        const data = await chrome.storage.local.get(storageKey);
        const payload = Array.isArray(data[storageKey]) ? data[storageKey] : [];

        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = buildExportFilename(filenamePrefix);
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);

        button.textContent = 'Downloaded';
    } catch (error) {
        console.error(`Failed to export ${storageKey}:`, error);
        button.textContent = 'Failed';
    }

    setTimeout(() => {
        button.textContent = originalText;
    }, 1400);
}

function activateTab(panelId) {
    const nextPanelId = normalizePopupTab(panelId);
    const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
    const tabPanels = Array.from(document.querySelectorAll('.tab-panel'));

    for (const button of tabButtons) {
        button.classList.toggle('active', button.dataset.tab === nextPanelId);
    }
    for (const panel of tabPanels) {
        panel.classList.toggle('active', panel.id === nextPanelId);
    }

    chrome.storage.local.set({ [POPUP_TAB_STORAGE_KEY]: nextPanelId }).catch((error) => {
        console.warn('Failed to persist popup tab state:', error);
    });
}

async function initializePopup() {
    const data = await chrome.storage.local.get([
        'proposalDetailsCaptureSummary',
        'scrapeMode',
        POPUP_TAB_STORAGE_KEY
    ]);

    setDatasetPlaceholder('proposalList', 'JSON not loaded yet. Click "Load JSON".');
    setDatasetPlaceholder('proposals', 'JSON not loaded yet. Click "Load JSON".');
    setDatasetPlaceholder('activeJobPost', 'JSON not loaded yet. Click "Load JSON".');
    setDatasetPlaceholder('jobPosts', 'JSON not loaded yet. Click "Load JSON".');
    renderProposalDetailsSummary(data.proposalDetailsCaptureSummary);
    document.getElementById('scrapeMode').value = normalizeScrapeMode(data.scrapeMode);
    activateTab(normalizePopupTab(data[POPUP_TAB_STORAGE_KEY]));

    await checkUpworkAuth();
    await refreshJobPageState();

    setTimeout(() => {
        refreshCountsOnly().catch((error) => {
            console.warn('Failed to refresh dataset counts:', error);
        });
    }, 0);
}

document.addEventListener('DOMContentLoaded', () => {
    initializePopup().catch((error) => {
        console.error('Popup initialization failed:', error);
    });
});

document.getElementById('tabProposals').addEventListener('click', () => {
    activateTab('proposalsPanel');
});

document.getElementById('tabJobPosts').addEventListener('click', async () => {
    activateTab('jobPostsPanel');
    await refreshJobPageState();
});

document.getElementById('scrapeMode').addEventListener('change', async (event) => {
    const scrapeMode = normalizeScrapeMode(event.target.value);
    await chrome.storage.local.set({ scrapeMode });
});

document.getElementById('startListScraping').addEventListener('click', async () => {
    const canProceed = await checkUpworkAuth();
    if (!canProceed) {
        return;
    }

    const scrapeMode = normalizeScrapeMode(document.getElementById('scrapeMode').value);
    await chrome.storage.local.set({ scrapeMode });
    chrome.runtime.sendMessage({ action: 'startArchivedListScraping', scrapeMode });
    window.close();
});

document.getElementById('startScraping').addEventListener('click', async () => {
    const canProceed = await checkUpworkAuth();
    if (!canProceed) {
        return;
    }

    const scrapeMode = normalizeScrapeMode(document.getElementById('scrapeMode').value);
    await chrome.storage.local.set({ scrapeMode });
    chrome.runtime.sendMessage({ action: 'startScraping', scrapeMode });
    renderProposalDetailsSummary({
        inProgress: true,
        status: 'starting',
        totalPending: latestProposalDetailsSummary?.totalPending || 0,
        captured: 0,
        timedOut: 0,
        currentIndex: 0,
        currentHref: '',
        startedAt: new Date().toISOString(),
        finishedAt: null
    });
});

document.getElementById('startJobScraping').addEventListener('click', async () => {
    const canProceed = await checkUpworkAuth();
    if (!canProceed) {
        return;
    }

    const isValidJobPage = await refreshJobPageState();
    if (!isValidJobPage) {
        return;
    }

    chrome.runtime.sendMessage({ action: 'startCurrentJobPostScraping' });
    window.close();
});

document.getElementById('startJobFromListScraping').addEventListener('click', async () => {
    const canProceed = await checkUpworkAuth();
    if (!canProceed) {
        return;
    }

    const scrapeMode = normalizeScrapeMode(document.getElementById('scrapeMode').value);
    await chrome.storage.local.set({ scrapeMode });
    chrome.runtime.sendMessage({ action: 'startJobPostsFromSavedListScraping', scrapeMode });
    window.close();
});

document.getElementById('repairSavedJobUrls').addEventListener('click', async () => {
    const button = document.getElementById('repairSavedJobUrls');
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Repairing...';

    try {
        const result = await chrome.runtime.sendMessage({ action: 'repairSavedJobPostUrls' });
        if (!result?.ok) {
            throw new Error(result?.error || 'Unknown repair failure');
        }

        const summary = result.summary || {};
        await refreshCountsOnly();

        for (const datasetKey of ['proposalList', 'proposals', 'activeJobPost', 'jobPosts']) {
            if (datasetState[datasetKey]) {
                datasetState[datasetKey].loaded = false;
                datasetState[datasetKey].dirty = true;
                setDatasetPlaceholder(datasetKey, 'Data changed. Click "Load JSON" to refresh.');
            }
        }

        alert(
            'Repair complete.\n' +
            `Proposal list: ${summary.proposalListCount || 0}\n` +
            `Detailed proposals: ${summary.proposalsCount || 0}\n` +
            `With raw GraphQL: ${summary.proposalsWithRawGraphql || 0}\n` +
            `Updated proposal URLs: ${summary.proposalsUpdated || 0}\n` +
            `Missing derived URL: ${summary.proposalsDerivedUrlMissing || 0}\n` +
            `Unique job URLs now: ${summary.uniqueJobUrlsAfterRepair || 0}\n` +
            `Updated existing job posts: ${summary.jobPostsUpdated || 0}`
        );
    } catch (error) {
        alert(`Repair failed: ${error?.message || 'unknown error'}`);
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
});

document.getElementById('clearData').addEventListener('click', async () => {
    if (!confirm('Are you sure you want to clear all scraped proposals?')) {
        return;
    }

    await chrome.storage.local.remove(['proposals', 'prompt', 'promptEdited', 'portfolio', 'dataView']);
    renderDatasetJson('proposals', []);
});

document.getElementById('clearProposalList').addEventListener('click', async () => {
    if (!confirm('Are you sure you want to clear archived proposal list data?')) {
        return;
    }

    await chrome.storage.local.remove(['proposalList']);
    renderDatasetJson('proposalList', []);
});

document.getElementById('clearProposalDetails').addEventListener('click', async () => {
    if (!confirm('Are you sure you want to clear captured proposal details data?')) {
        return;
    }

    await chrome.storage.local.remove(['proposals', 'proposalDetailsCaptureSummary']);
    renderDatasetJson('proposals', []);
    renderProposalDetailsSummary(null);
});

document.getElementById('clearCurrentJobPost').addEventListener('click', async () => {
    if (!confirm('Are you sure you want to clear the active job page data?')) {
        return;
    }

    await chrome.storage.local.remove(['activeJobPost']);
    renderDatasetJson('activeJobPost', []);
});

document.getElementById('clearJobPosts').addEventListener('click', async () => {
    if (!confirm('Are you sure you want to clear saved job post data?')) {
        return;
    }

    await chrome.storage.local.remove(['jobPosts']);
    renderDatasetJson('jobPosts', []);
});

document.getElementById('copyRawJson').addEventListener('click', async () => {
    await ensureDatasetLoaded('proposals');
    await copyFromTextarea('copyRawJson', 'rawJsonOutput');
});

document.getElementById('copyProposalListJson').addEventListener('click', async () => {
    await ensureDatasetLoaded('proposalList');
    await copyFromTextarea('copyProposalListJson', 'proposalListJsonOutput');
});

document.getElementById('copyActiveJobJson').addEventListener('click', async () => {
    await ensureDatasetLoaded('activeJobPost');
    await copyFromTextarea('copyActiveJobJson', 'activeJobJsonOutput');
});

document.getElementById('copyJobJson').addEventListener('click', async () => {
    await ensureDatasetLoaded('jobPosts');
    await copyFromTextarea('copyJobJson', 'jobRawJsonOutput');
});

document.getElementById('loadRawJson').addEventListener('click', async () => {
    await loadDatasetJson('proposals', { force: true });
});

document.getElementById('loadProposalListJson').addEventListener('click', async () => {
    await loadDatasetJson('proposalList', { force: true });
});

document.getElementById('loadActiveJobJson').addEventListener('click', async () => {
    await loadDatasetJson('activeJobPost', { force: true });
});

document.getElementById('loadJobJson').addEventListener('click', async () => {
    await loadDatasetJson('jobPosts', { force: true });
});

document.getElementById('downloadProposalListJson').addEventListener('click', async () => {
    await downloadJson('downloadProposalListJson', 'proposalList', 'proposal-list');
});

document.getElementById('downloadRawJson').addEventListener('click', async () => {
    await downloadJson('downloadRawJson', 'proposals', 'proposals');
});

document.getElementById('downloadActiveJobJson').addEventListener('click', async () => {
    await downloadJson('downloadActiveJobJson', 'activeJobPost', 'active-job-post');
});

document.getElementById('downloadJobJson').addEventListener('click', async () => {
    await downloadJson('downloadJobJson', 'jobPosts', 'job-posts');
});

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'local') {
        return;
    }

    if (changes.proposals) {
        setDatasetCount('proposals', changes.proposals.newValue);
        if (datasetState.proposals.loaded) {
            datasetState.proposals.loaded = false;
            datasetState.proposals.dirty = true;
            setDatasetPlaceholder('proposals', 'Data changed. Click "Load JSON" to refresh.');
        }
    }
    if (changes.proposalList) {
        setDatasetCount('proposalList', changes.proposalList.newValue);
        if (datasetState.proposalList.loaded) {
            datasetState.proposalList.loaded = false;
            datasetState.proposalList.dirty = true;
            setDatasetPlaceholder('proposalList', 'Data changed. Click "Load JSON" to refresh.');
        }
    }
    if (changes.activeJobPost) {
        setDatasetCount('activeJobPost', changes.activeJobPost.newValue);
        if (datasetState.activeJobPost.loaded) {
            datasetState.activeJobPost.loaded = false;
            datasetState.activeJobPost.dirty = true;
            setDatasetPlaceholder('activeJobPost', 'Data changed. Click "Load JSON" to refresh.');
        }
    }
    if (changes.jobPosts) {
        setDatasetCount('jobPosts', changes.jobPosts.newValue);
        if (datasetState.jobPosts.loaded) {
            datasetState.jobPosts.loaded = false;
            datasetState.jobPosts.dirty = true;
            setDatasetPlaceholder('jobPosts', 'Data changed. Click "Load JSON" to refresh.');
        }
    }
    if (changes.proposalDetailsCaptureSummary) {
        renderProposalDetailsSummary(changes.proposalDetailsCaptureSummary.newValue);
    }
});
