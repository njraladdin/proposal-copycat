function normalizeScrapeMode(value) {
    return value === 'all' ? 'all' : 'successful';
}

function showAuthWarning() {
    const warning = document.getElementById('authWarning');
    const startScrapingBtn = document.getElementById('startScraping');
    warning.style.display = 'block';
    startScrapingBtn.disabled = true;
}

function removeAuthWarning() {
    const warning = document.getElementById('authWarning');
    const startScrapingBtn = document.getElementById('startScraping');
    warning.style.display = 'none';
    startScrapingBtn.disabled = false;
}

async function checkUpworkAuth() {
    try {
        const upworkTabs = await chrome.tabs.query({ url: ['https://www.upwork.com/*'] });

        if (!upworkTabs.length) {
            removeAuthWarning();
            return true;
        }

        const tabToCheck = upworkTabs.find(tab => tab.active) || upworkTabs[0];
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

function renderRawJson(proposals) {
    const items = Array.isArray(proposals) ? proposals : [];
    document.getElementById('proposalCount').textContent = String(items.length);
    document.getElementById('rawJsonOutput').value = JSON.stringify(items, null, 2);
}

function buildExportFilename() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    return `proposals-${timestamp}.json`;
}

document.addEventListener('DOMContentLoaded', async () => {
    const data = await chrome.storage.local.get(['proposals', 'scrapeMode']);
    renderRawJson(data.proposals);
    document.getElementById('scrapeMode').value = normalizeScrapeMode(data.scrapeMode);
    await checkUpworkAuth();
});

document.getElementById('scrapeMode').addEventListener('change', async (event) => {
    const scrapeMode = normalizeScrapeMode(event.target.value);
    await chrome.storage.local.set({ scrapeMode });
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

document.getElementById('clearData').addEventListener('click', async () => {
    if (!confirm('Are you sure you want to clear all scraped proposals?')) {
        return;
    }

    await chrome.storage.local.remove(['proposals', 'prompt', 'promptEdited', 'portfolio', 'dataView']);
    renderRawJson([]);
});

document.getElementById('copyRawJson').addEventListener('click', async () => {
    const copyBtn = document.getElementById('copyRawJson');
    const originalText = copyBtn.textContent;
    await navigator.clipboard.writeText(document.getElementById('rawJsonOutput').value);
    copyBtn.textContent = 'Copied';
    setTimeout(() => {
        copyBtn.textContent = originalText;
    }, 1200);
});

document.getElementById('downloadRawJson').addEventListener('click', async () => {
    const downloadBtn = document.getElementById('downloadRawJson');
    const originalText = downloadBtn.textContent;

    try {
        const data = await chrome.storage.local.get('proposals');
        const proposals = Array.isArray(data.proposals) ? data.proposals : [];

        const blob = new Blob([JSON.stringify(proposals, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = buildExportFilename();
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);

        downloadBtn.textContent = 'Downloaded';
    } catch (error) {
        console.error('Failed to export proposals:', error);
        downloadBtn.textContent = 'Failed';
    }

    setTimeout(() => {
        downloadBtn.textContent = originalText;
    }, 1400);
});

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.proposals) {
        renderRawJson(changes.proposals.newValue);
    }
});
