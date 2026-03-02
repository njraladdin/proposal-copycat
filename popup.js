const UPWORK_JOB_POST_URL_PATTERN = /^https:\/\/www\.upwork\.com\/jobs\/[^/?#]+/i;
const POPUP_TAB_STORAGE_KEY = 'popupActiveTab';

let isAuthValid = true;
let isOnJobPostPage = false;

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
    startScrapingBtn.disabled = !isAuthValid;
    startListScrapingBtn.disabled = !isAuthValid;
    startJobScrapingBtn.disabled = !isAuthValid || !isOnJobPostPage;
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

function renderProposalJson(proposals) {
    const items = Array.isArray(proposals) ? proposals : [];
    document.getElementById('proposalCount').textContent = String(items.length);
    document.getElementById('rawJsonOutput').value = JSON.stringify(items, null, 2);
}

function renderProposalListJson(proposalList) {
    const items = Array.isArray(proposalList) ? proposalList : [];
    document.getElementById('proposalListCount').textContent = String(items.length);
    document.getElementById('proposalListJsonOutput').value = JSON.stringify(items, null, 2);
}

function renderJobPostJson(jobPosts) {
    const items = Array.isArray(jobPosts) ? jobPosts : [];
    document.getElementById('jobPostCount').textContent = String(items.length);
    document.getElementById('jobRawJsonOutput').value = JSON.stringify(items, null, 2);
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
        'proposalList',
        'proposals',
        'jobPosts',
        'scrapeMode',
        POPUP_TAB_STORAGE_KEY
    ]);

    renderProposalListJson(data.proposalList);
    renderProposalJson(data.proposals);
    renderJobPostJson(data.jobPosts);
    document.getElementById('scrapeMode').value = normalizeScrapeMode(data.scrapeMode);
    activateTab(normalizePopupTab(data[POPUP_TAB_STORAGE_KEY]));

    await checkUpworkAuth();
    await refreshJobPageState();
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
    window.close();
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

document.getElementById('clearData').addEventListener('click', async () => {
    if (!confirm('Are you sure you want to clear all scraped proposals?')) {
        return;
    }

    await chrome.storage.local.remove(['proposals', 'prompt', 'promptEdited', 'portfolio', 'dataView']);
    renderProposalJson([]);
});

document.getElementById('clearProposalList').addEventListener('click', async () => {
    if (!confirm('Are you sure you want to clear archived proposal list data?')) {
        return;
    }

    await chrome.storage.local.remove(['proposalList']);
    renderProposalListJson([]);
});

document.getElementById('clearJobPosts').addEventListener('click', async () => {
    if (!confirm('Are you sure you want to clear all scraped job posts?')) {
        return;
    }

    await chrome.storage.local.remove(['jobPosts']);
    renderJobPostJson([]);
});

document.getElementById('copyRawJson').addEventListener('click', async () => {
    await copyFromTextarea('copyRawJson', 'rawJsonOutput');
});

document.getElementById('copyProposalListJson').addEventListener('click', async () => {
    await copyFromTextarea('copyProposalListJson', 'proposalListJsonOutput');
});

document.getElementById('copyJobJson').addEventListener('click', async () => {
    await copyFromTextarea('copyJobJson', 'jobRawJsonOutput');
});

document.getElementById('downloadProposalListJson').addEventListener('click', async () => {
    await downloadJson('downloadProposalListJson', 'proposalList', 'proposal-list');
});

document.getElementById('downloadRawJson').addEventListener('click', async () => {
    await downloadJson('downloadRawJson', 'proposals', 'proposals');
});

document.getElementById('downloadJobJson').addEventListener('click', async () => {
    await downloadJson('downloadJobJson', 'jobPosts', 'job-posts');
});

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'local') {
        return;
    }

    if (changes.proposals) {
        renderProposalJson(changes.proposals.newValue);
    }
    if (changes.proposalList) {
        renderProposalListJson(changes.proposalList.newValue);
    }
    if (changes.jobPosts) {
        renderJobPostJson(changes.jobPosts.newValue);
    }
});
