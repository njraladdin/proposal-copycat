/**
 * Shared utilities used across all site modules.
 */

const SITE_REGISTRY = [
    { id: 'upwork', label: 'Upwork', icon: '💼' },
    { id: 'tiktok', label: 'TikTok', icon: '🎵' }
];

const ACTIVE_SITE_STORAGE_KEY = 'activeSiteTab';

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
            reject(new Error('Timed out waiting for the page to load.'));
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
