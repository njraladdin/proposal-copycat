/**
 * Background controller for TikTok operations.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startTiktokCommentScraping') {
        handleTiktokCommentScraping(message.maxLimit, sendResponse);
        return true; // Keep message channel open for async response
    }
});

async function handleTiktokCommentScraping(maxLimit, sendResponse) {
    try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab || !activeTab.id || !activeTab.url || !activeTab.url.includes('tiktok.com')) {
            sendResponse({ success: false, error: 'Active tab is not a TikTok page.' });
            return;
        }

        // Inject the content script, passing the target limit
        const [result] = await chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            files: ['sites/tiktok/injected/scrape-comments.js']
        });
        
        // After injection, we need to send a message to the newly injected script to start it with args
        const scraperResponse = await new Promise((resolve) => {
            chrome.tabs.sendMessage(activeTab.id, { action: 'runTiktokScraper', maxLimit }, (response) => {
                if (chrome.runtime.lastError) {
                    resolve({ success: false, error: chrome.runtime.lastError.message });
                } else {
                    resolve(response);
                }
            });
        });

        const scraperResponse = result?.result;
        if (!scraperResponse || !scraperResponse.success) {
            sendResponse({ success: false, error: scraperResponse?.error || 'Failed to extract comments.' });
            return;
        }

        // Save to storage
        const storageData = await chrome.storage.local.get('tiktokComments');
        const existingComments = Array.isArray(storageData.tiktokComments) ? storageData.tiktokComments : [];
        
        // Prepend new comments (avoiding exact duplicates where possible by checking username + text combo)
        const newComments = scraperResponse.comments;
        const dedupedList = [...existingComments];
        
        let addedCount = 0;
        for (const newC of newComments) {
            const isDuplicate = dedupedList.some(c => c.username === newC.username && c.commentText === newC.commentText);
            if (!isDuplicate) {
                dedupedList.unshift(newC); // Add to top
                addedCount++;
            }
        }

        await chrome.storage.local.set({ tiktokComments: dedupedList });

        sendResponse({ 
            success: true, 
            count: addedCount, 
            total: dedupedList.length 
        });

    } catch (error) {
        console.error('[TikTok Controller] Error querying tabs or parsing:', error);
        sendResponse({ success: false, error: error.toString() });
    }
}
