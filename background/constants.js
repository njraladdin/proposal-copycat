const ARCHIVED_PROPOSALS_URL = 'https://www.upwork.com/nx/proposals/archived';
const UPWORK_ROOT_URL = 'https://www.upwork.com/';
const DEFAULT_SCRAPE_MODE = 'successful';

function normalizeScrapeMode(mode) {
    return mode === 'all' ? 'all' : DEFAULT_SCRAPE_MODE;
}

function waitForTabReady(tabId, expectedUrl) {
    return new Promise((resolve, reject) => {
        let timeoutId;

        const cleanup = () => {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            clearTimeout(timeoutId);
        };

        const onUpdated = (updatedTabId, changeInfo, tab) => {
            if (updatedTabId !== tabId) return;
            if (changeInfo.status !== 'complete') return;
            if (!tab?.url?.startsWith(expectedUrl)) return;
            cleanup();
            resolve();
        };

        timeoutId = setTimeout(() => {
            cleanup();
            reject(new Error('Timed out waiting for the archived proposals page to load.'));
        }, 45000);

        chrome.tabs.onUpdated.addListener(onUpdated);

        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError) {
                cleanup();
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }

            if (tab?.status === 'complete' && tab?.url?.startsWith(expectedUrl)) {
                cleanup();
                resolve();
            }
        });
    });
}