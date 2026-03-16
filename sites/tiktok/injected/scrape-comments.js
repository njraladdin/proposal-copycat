/**
 * Content script injected into TikTok to extract comments.
 * It continually monitors the DOM on an interval and sends batches to the background.
 */

// Global state to prevent duplicate injections
if (!window._tiktokScraperListenerAdded) {
    window._tiktokScraperListenerAdded = true;
    window._tiktokMonitorIntervalId = null;
    window._tiktokScrapedSet = new Set(); // Local Set to avoid sending redundant comments over message passing repeatedly

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'pingTiktokScraper') {
            sendResponse({ ready: true });
        } else if (message.action === 'startMonitorLoop') {
            startMonitoring(message.maxLimit);
            sendResponse({ started: true });
        } else if (message.action === 'stopMonitorLoop') {
            stopMonitoring();
            sendResponse({ stopped: true });
        }
    });
}

function startMonitoring(maxLimit) {
    console.log(`[TikTok Scraper] Starting DOM monitor loop (limit: ${maxLimit})...`);
    stopMonitoring(); // Clear any existing
    window._tiktokScrapedSet.clear();

    // Poll the DOM every 1000ms
    window._tiktokMonitorIntervalId = setInterval(() => {
        extractAndSendComments(maxLimit);
    }, 1000);
    
    // Initial run immediately
    extractAndSendComments(maxLimit);
}

function stopMonitoring() {
    if (window._tiktokMonitorIntervalId) {
        clearInterval(window._tiktokMonitorIntervalId);
        window._tiktokMonitorIntervalId = null;
        console.log('[TikTok Scraper] Monitoring stopped.');
    }
}

function extractAndSendComments(maxLimit) {
    try {
        const commentWrappers = Array.from(document.querySelectorAll('div[class*="DivCommentItemWrapper"], div.epprvxn0'));
        const newCommentsBatch = [];

        for (const wrapper of commentWrappers) {
            const commentData = extractCommentData(wrapper);
            if (commentData && (commentData.username || commentData.commentText)) {
                
                const hashKey = `${commentData.username}:::${commentData.commentText}`;
                
                // If we haven't sent this exact comment back to the background script yet
                if (!window._tiktokScrapedSet.has(hashKey)) {
                    window._tiktokScrapedSet.add(hashKey);
                    newCommentsBatch.push(commentData);
                }
            }
        }

        // Send batch to background script for storage and global deduplication
        if (newCommentsBatch.length > 0) {
            chrome.runtime.sendMessage({ 
                action: 'tiktokCommentsBatch', 
                comments: newCommentsBatch,
                maxLimit: maxLimit 
            });
        }

    } catch (err) {
        console.error('[TikTok Scraper] Error in monitor loop:', err);
    }
}

function extractCommentData(wrapper) {
    const commentData = {
        username: '',
        profileUrl: '',
        avatarUrl: '',
        commentText: '',
        date: '',
        likes: '',
        scrapedAt: new Date().toISOString()
    };

    // 1. Username
    const usernameWrapper = wrapper.querySelector('div[data-e2e^="comment-username"] p');
    if (usernameWrapper) {
        commentData.username = usernameWrapper.textContent.trim();
    } else {
        const userLink = wrapper.querySelector('a[href^="/@"]');
        if (userLink && userLink.textContent.trim()) {
            commentData.username = userLink.textContent.trim();
        }
    }

    // 2. Profile URL
    const userLink = wrapper.querySelector('a[href^="/@"]');
    if (userLink) {
        commentData.profileUrl = 'https://www.tiktok.com' + userLink.getAttribute('href');
    }

    // 3. Avatar Image
    const avatarImg = wrapper.querySelector('img[class*="ImgAvatar"]');
    if (avatarImg) {
        commentData.avatarUrl = avatarImg.getAttribute('src') || '';
    }

    // 4. Comment Text
    const textSpan = wrapper.querySelector('span[data-e2e^="comment-level-"]');
    if (textSpan) {
        commentData.commentText = textSpan.textContent.trim();
    }

    // 5. Date
    const dateSpan = wrapper.querySelector('div[class*="DivCommentSubContentWrapper"] span');
    if (dateSpan) {
        commentData.date = dateSpan.textContent.trim();
    }

    // 6. Likes
    const likeContainer = wrapper.querySelector('div[class*="DivLikeContainer"]');
    if (likeContainer) {
        const likeSpan = likeContainer.querySelector('span');
        if (likeSpan) {
            commentData.likes = likeSpan.textContent.trim();
        }
    }

    return commentData;
}
