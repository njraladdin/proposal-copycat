/**
 * Background controller for TikTok operations.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startTiktokMonitor') {
        handleStartTiktokMonitor(message.maxLimit, sendResponse);
        return true; // Keep message channel open for async response
    } else if (message.action === 'stopTiktokMonitor') {
        handleStopTiktokMonitor();
        sendResponse({ success: true });
    } else if (message.action === 'tiktokCommentsBatch') {
        handleIncomingComments(message.comments, message.maxLimit);
        // Optional to sendResponse back
    }
});

async function handleStartTiktokMonitor(maxLimit, sendResponse) {
    try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab || !activeTab.id || !activeTab.url || !activeTab.url.includes('tiktok.com')) {
            await chrome.storage.local.set({ 
                tiktokIsMonitoring: false, 
                tiktokMonitorStatus: 'Error: Active tab is not a TikTok page.' 
            });
            sendResponse({ success: false, error: 'Active tab is not a TikTok page.' });
            return;
        }

        // Send a test message to see if the content script is already injected
        let isAlreadyInjected = false;
        try {
            await chrome.tabs.sendMessage(activeTab.id, { action: 'pingTiktokScraper' });
            isAlreadyInjected = true;
        } catch (e) {
            // Script not injected or not responsive
            isAlreadyInjected = false;
        }

        if (!isAlreadyInjected) {
            // Inject the content script
            await chrome.scripting.executeScript({
                target: { tabId: activeTab.id },
                files: ['sites/tiktok/injected/scrape-comments.js']
            });
        }

        // Start the monitoring loop in the content script
        chrome.tabs.sendMessage(activeTab.id, { action: 'startMonitorLoop', maxLimit }, () => {
             if (chrome.runtime.lastError) console.error(chrome.runtime.lastError);
        });

        await chrome.storage.local.set({ tiktokMonitorStatus: 'Monitoring... scroll comments down manually.' });
        sendResponse({ success: true });

    } catch (error) {
        console.error('[TikTok Controller] Error starting monitor:', error);
        await chrome.storage.local.set({ 
            tiktokIsMonitoring: false, 
            tiktokMonitorStatus: 'Error: ' + error.message 
        });
        sendResponse({ success: false, error: error.toString() });
    }
}

async function handleStopTiktokMonitor() {
    await chrome.storage.local.set({ 
        tiktokIsMonitoring: false, 
        tiktokMonitorStatus: 'Stopped.' 
    });
    
    // Stop loop in the active tab
    try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab && activeTab.id) {
            chrome.tabs.sendMessage(activeTab.id, { action: 'stopMonitorLoop' }, () => {
                if (chrome.runtime.lastError) {} // Ignore
            });
        }
    } catch (e) {
        console.error(e);
    }
}

async function handleIncomingComments(newComments, maxLimit) {
    try {
        const isMonitoringObj = await chrome.storage.local.get('tiktokIsMonitoring');
        if (!isMonitoringObj.tiktokIsMonitoring) return; // Discard if stopped

        const storageData = await chrome.storage.local.get('tiktokComments');
        const existingComments = Array.isArray(storageData.tiktokComments) ? storageData.tiktokComments : [];
        
        let dedupedList = [...existingComments];
        let addedCount = 0;

        for (const newC of newComments) {
            const isDuplicate = dedupedList.some(c => c.username === newC.username && c.commentText === newC.commentText);
            if (!isDuplicate) {
                dedupedList.unshift(newC); // Add to top
                addedCount++;
            }
        }

        // Enforce max storage limit if we exceed it
        if (dedupedList.length > maxLimit) {
            dedupedList = dedupedList.slice(0, maxLimit);
            // Auto stop since limit reached
            await handleStopTiktokMonitor();
            await chrome.storage.local.set({ 
                tiktokMonitorStatus: `Stopped automatically after reaching limit of ${maxLimit} comments.` 
            });
        } else if (addedCount > 0) {
           await chrome.storage.local.set({ 
               tiktokMonitorStatus: `Harvested ${dedupedList.length} / ${maxLimit} comments... keep scrolling.` 
           });
        }

        if (addedCount > 0 || dedupedList.length !== existingComments.length) {
            await chrome.storage.local.set({ tiktokComments: dedupedList });
        }
    } catch (err) {
        console.error('Error handling incoming comments:', err);
    }
}
