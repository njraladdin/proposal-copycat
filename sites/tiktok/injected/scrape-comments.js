/**
 * Content script injected into TikTok to extract comments.
 * It listens for a message to start scraping, then scrolls the comment container
 * to load more comments until the requested limit is reached or no more load.
 */

// Only add listener if not already added to prevent duplicates on multiple injections
if (!window._tiktokScraperListenerAdded) {
    window._tiktokScraperListenerAdded = true;

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'runTiktokScraper') {
            runScraper(message.maxLimit || 50).then(sendResponse);
            return true; // async response
        }
    });
}

async function runScraper(maxLimit) {
    console.log(`[TikTok Scraper] Starting extraction (limit: ${maxLimit})...`);

    try {
        const scrapedCommentsMap = new Map(); // Use map to deduplicate by username+text
        let previousCount = 0;
        let noNewItemsLoops = 0;
        const MAX_IDLE_LOOPS = 5; // Give up if we scroll 5 times and get no new items

        // The container that scrolls is usually the list container
        // Based on user snippet: .css-1i2ou4d-7937d88b--DivCommentListContainer
        const getListContainer = () => document.querySelector('div[class*="DivCommentListContainer"]') || document.documentElement;

        while (scrapedCommentsMap.size < maxLimit && noNewItemsLoops < MAX_IDLE_LOOPS) {
            
            // 1. Extract current DOM comments
            const commentWrappers = Array.from(document.querySelectorAll('div[class*="DivCommentItemWrapper"], div.epprvxn0'));
            
            for (const wrapper of commentWrappers) {
                if (scrapedCommentsMap.size >= maxLimit) break;

                const commentData = extractCommentData(wrapper);
                if (commentData && (commentData.username || commentData.commentText)) {
                    // Create a unique key for deduplication
                    const hashKey = `${commentData.username}:::${commentData.commentText}`;
                    if (!scrapedCommentsMap.has(hashKey)) {
                        scrapedCommentsMap.set(hashKey, commentData);
                    }
                }
            }

            // 2. Check if we reached the limit
            if (scrapedCommentsMap.size >= maxLimit) {
                console.log(`[TikTok Scraper] Reached requested limit of ${maxLimit}.`);
                break;
            }

            // 3. Scroll to load more
            const container = getListContainer();
            const currentCount = scrapedCommentsMap.size;
            
            if (currentCount === previousCount) {
                noNewItemsLoops++;
            } else {
                noNewItemsLoops = 0;
            }
            previousCount = currentCount;

            // Scroll down
            if (container === document.documentElement) {
                window.scrollTo(0, document.body.scrollHeight);
            } else {
                container.scrollTop = container.scrollHeight;
            }

            // Wait for network/DOM to update
            await new Promise(resolve => setTimeout(resolve, 1500));
        }

        const results = Array.from(scrapedCommentsMap.values());
        console.log(`[TikTok Scraper] Finished. Extracted ${results.length} unique comments.`);

        return {
            success: true,
            count: results.length,
            comments: results
        };

    } catch (err) {
        console.error('[TikTok Scraper] Error scraping:', err);
        return {
            success: false,
            error: err.toString()
        };
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
