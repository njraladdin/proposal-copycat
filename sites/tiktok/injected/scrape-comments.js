/**
 * Content script injected into TikTok to extract comments.
 */

(function() {
    console.log('[TikTok Scraper] Injecting generic comment scraper...');

    try {
        // Find all comment wrappers
        // Based on user snippet: <div class="css-116ki3l-7937d88b--DivCommentItemWrapper epprvxn0">
        const commentWrappers = Array.from(document.querySelectorAll('div[class*="DivCommentItemWrapper"], div.epprvxn0'));
        console.log(`[TikTok Scraper] Found ${commentWrappers.length} comment wrappers.`);

        const scrapedComments = [];

        for (const wrapper of commentWrappers) {
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
            // <div data-e2e="comment-username-1">...<p class="TUXText...">username</p>
            const usernameWrapper = wrapper.querySelector('div[data-e2e^="comment-username"] p');
            if (usernameWrapper) {
                commentData.username = usernameWrapper.textContent.trim();
            } else {
                // Fallback username extraction
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
            // <span data-e2e="comment-level-1"><span class="TUXText...">...</span></span>
            const textSpan = wrapper.querySelector('span[data-e2e^="comment-level-"]');
            if (textSpan) {
                commentData.commentText = textSpan.textContent.trim();
            }

            // 5. Date
            // Usually in a sub-content wrapper, e.g. "1-27"
            const dateSpan = wrapper.querySelector('div[class*="DivCommentSubContentWrapper"] span');
            if (dateSpan) {
                commentData.date = dateSpan.textContent.trim();
            }

            // 6. Likes
            // <div class="css-2pcb7l-7937d88b--DivLikeContainer..."><svg.../><span class="TUXText...">1684</span></div>
            const likeContainer = wrapper.querySelector('div[class*="DivLikeContainer"]');
            if (likeContainer) {
                const likeSpan = likeContainer.querySelector('span');
                if (likeSpan) {
                    commentData.likes = likeSpan.textContent.trim();
                }
            }

            // Only add if we found at least a username and text
            if (commentData.username || commentData.commentText) {
                scrapedComments.push(commentData);
            }
        }

        // Return extracted data to the background script
        return {
            success: true,
            count: scrapedComments.length,
            comments: scrapedComments
        };

    } catch (err) {
        console.error('[TikTok Scraper] Error scraping:', err);
        return {
            success: false,
            error: err.toString()
        };
    }
})();
