const ARCHIVED_PROPOSALS_URL = 'https://www.upwork.com/nx/proposals/archived';
const DEFAULT_SCRAPE_MODE = 'successful';

function normalizeScrapeMode(mode) {
    return mode === 'all' ? 'all' : DEFAULT_SCRAPE_MODE;
}

chrome.runtime.onMessage.addListener((request) => {
    if (request.action !== 'startScraping') return;

    const scrapeMode = normalizeScrapeMode(request.scrapeMode);
    startScrapingFlow(scrapeMode).catch((error) => {
        console.error('Failed to start scraping:', error);
    });
});

async function startScrapingFlow(scrapeMode = DEFAULT_SCRAPE_MODE) {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    let targetTabId;
    if (currentTab?.url?.startsWith(ARCHIVED_PROPOSALS_URL)) {
        targetTabId = currentTab.id;
    } else {
        const newTab = await chrome.tabs.create({ url: ARCHIVED_PROPOSALS_URL });
        targetTabId = newTab.id;
    }

    await waitForTabReady(targetTabId, ARCHIVED_PROPOSALS_URL);
    await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        function: scrapeProposals,
        args: [{ scrapeMode }]
    });
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

async function scrapeProposals(options = {}) {
    if (document.getElementById('proposal-copycat-status-popup')) {
        return;
    }

    const scrapeMode = options?.scrapeMode === 'all' ? 'all' : 'successful';
    const includeRawNuxtScript = options?.includeRawNuxtScript === true;
    const statusTitle = scrapeMode === 'all' ? 'Collecting Proposals' : 'Collecting Successful Proposals';
    const modeBadgeText = scrapeMode === 'all' ? 'All Proposals' : 'Successful Only';
    const modeSummaryText = scrapeMode === 'all' ? 'all proposals' : 'successful proposals';

    // Get existing proposals from storage
    const storageData = await chrome.storage.local.get('proposals');
    const existingProposals = storageData.proposals || [];
    const existingUrls = new Set(
        existingProposals
            .map((proposal) => (
                proposal?.proposalDetailsPage?.data?.proposal?.proposalUrl ||
                proposal?.proposal?.proposalUrl ||
                proposal?.proposalListPage?.href ||
                proposal?.href
            ))
            .filter(Boolean)
    );
    
    let allLinks = [];
    let tableData = [];
    let isPaused = false;
    let lastActiveAction = 'Starting scraper...';
    
    const statusPopup = document.createElement('div');
    statusPopup.id = 'proposal-copycat-status-popup';
    statusPopup.style.cssText = `
        position: fixed;
        top: 24px;
        right: 24px;
        background: #ffffff;
        color: #1a1f36;
        padding: 32px;
        border-radius: 16px;
        z-index: 10000;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
        width: 420px;
        height: auto;
        max-height: 85vh;
        overflow-y: auto;
        box-shadow: 
            0 24px 48px -12px rgba(0, 0, 0, 0.18),
            0 0 1px rgba(0, 0, 0, 0.1);
        backdrop-filter: blur(8px);
        border: 1px solid rgba(230, 232, 235, 0.8);
    `;
    
    const progressState = {
        action: 'Starting scraper...',
        listCurrent: '',
        listTotal: '',
        itemCurrent: 0,
        itemTotal: 0
    };
    const errorState = {
        total: 0,
        byType: {},
        recent: []
    };
    const runMetrics = {
        startedAtMs: Date.now(),
        processedItems: 0,
        completedPages: 0,
        observedItemsInPages: 0
    };
    const MAX_RECENT_ERRORS = 5;

    const escapeHtml = (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const parsePositiveInteger = (value) => {
        const parsed = Number.parseInt(String(value || ''), 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };
    const formatDurationShort = (milliseconds) => {
        if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
            return '<1m';
        }

        const totalSeconds = Math.max(1, Math.round(milliseconds / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        }
        if (minutes > 0) {
            return `${minutes}m`;
        }
        return `${seconds}s`;
    };
    const estimateRemainingMs = () => {
        const elapsedMs = Date.now() - runMetrics.startedAtMs;
        if (runMetrics.processedItems < 3 || elapsedMs < 10000) {
            return null;
        }

        const currentPage = parsePositiveInteger(progressState.listCurrent);
        const totalPages = parsePositiveInteger(progressState.listTotal);
        const currentItem = Number.isFinite(progressState.itemCurrent) ? progressState.itemCurrent : 0;
        const totalItemsOnPage = Number.isFinite(progressState.itemTotal) ? progressState.itemTotal : 0;

        let remainingItems = Math.max(totalItemsOnPage - currentItem, 0);
        if (currentPage && totalPages && totalPages >= currentPage) {
            const pagesRemaining = totalPages - currentPage;
            const averageItemsPerPage = runMetrics.completedPages > 0
                ? (runMetrics.observedItemsInPages / runMetrics.completedPages)
                : (totalItemsOnPage > 0 ? totalItemsOnPage : 0);

            if (pagesRemaining > 0 && averageItemsPerPage > 0) {
                remainingItems += pagesRemaining * averageItemsPerPage;
            }
        }

        if (remainingItems <= 0) {
            return 0;
        }

        const avgMsPerItem = elapsedMs / runMetrics.processedItems;
        if (!Number.isFinite(avgMsPerItem) || avgMsPerItem <= 0) {
            return null;
        }

        return remainingItems * avgMsPerItem;
    };

    const updateStatus = (updates = {}) => {
        Object.assign(progressState, updates);

        if (updates.action && updates.action !== 'Paused') {
            lastActiveAction = updates.action;
        }

        const listProgressText = progressState.listCurrent
            ? `Page ${progressState.listCurrent}${progressState.listTotal ? ` of ${progressState.listTotal}` : ''}`
            : 'Loading page info...';

        const pageProgressText = progressState.itemTotal > 0
            ? `${progressState.itemCurrent}/${progressState.itemTotal}`
            : 'None on this page';
        const etaRemainingMs = estimateRemainingMs();
        const etaText = etaRemainingMs === null
            ? 'Calculating...'
            : formatDurationShort(etaRemainingMs);
        const sortedErrorEntries = Object.entries(errorState.byType)
            .sort((a, b) => b[1] - a[1]);
        const errorTypeSummary = sortedErrorEntries
            .slice(0, 3)
            .map(([type, count]) => `${type}: ${count}`)
            .join(', ');
        const recentErrorRows = errorState.recent
            .slice(0, 3)
            .map((entry) => `
                <div style="font-size: 11px; color: #495057; line-height: 1.35;">
                    <span style="font-weight: 700; color: #b02a37;">${escapeHtml(entry.type)}</span>
                    <span>: ${escapeHtml(entry.message)}</span>
                    ${entry.source ? `<div style="color: #6c757d; margin-top: 2px;">${escapeHtml(entry.source)}</div>` : ''}
                </div>
            `)
            .join('');

        statusPopup.innerHTML = `
            <div style="margin-bottom: 16px;">
                <h3 style="
                    margin: 0 0 8px 0;
                    font-size: 20px;
                    font-weight: 700;
                    color: #1a1f36;
                    letter-spacing: -0.2px;
                ">
                    ${statusTitle}
                </h3>
                <div style="font-size: 12px; color: #697386; font-weight: 600;">
                    ${modeBadgeText}
                </div>
            </div>

            <div style="
                background: #f8fafc;
                border-radius: 12px;
                padding: 16px;
                margin-bottom: 16px;
                border: 1px solid rgba(230, 232, 235, 0.9);
            ">
                <div style="font-size: 13px; color: #1a1f36; font-weight: 600; margin-bottom: 10px;">
                    ${progressState.action}
                </div>
                <div style="
                    display: grid;
                    grid-template-columns: 108px 1fr;
                    row-gap: 8px;
                    column-gap: 10px;
                    align-items: start;
                ">
                    <div style="
                        font-size: 11px;
                        color: #697386;
                        text-transform: uppercase;
                        letter-spacing: 0.4px;
                        font-weight: 600;
                    ">List Progress</div>
                    <div style="font-size: 13px; color: #1a1f36; font-weight: 600;">
                        ${listProgressText}
                    </div>

                    <div style="
                        font-size: 11px;
                        color: #697386;
                        text-transform: uppercase;
                        letter-spacing: 0.4px;
                        font-weight: 600;
                    ">Page Progress</div>
                    <div style="font-size: 13px; color: #1a1f36; font-weight: 600;">
                        ${pageProgressText}
                    </div>

                    <div style="
                        font-size: 11px;
                        color: #697386;
                        text-transform: uppercase;
                        letter-spacing: 0.4px;
                        font-weight: 600;
                    ">Total Saved</div>
                    <div style="font-size: 13px; color: #1a1f36; font-weight: 600;">
                        ${tableData.length}
                    </div>

                    <div style="
                        font-size: 11px;
                        color: #697386;
                        text-transform: uppercase;
                        letter-spacing: 0.4px;
                        font-weight: 600;
                    ">ETA</div>
                    <div style="font-size: 13px; color: #1a1f36; font-weight: 600;">
                        ${etaText}
                    </div>

                    <div style="
                        font-size: 11px;
                        color: #697386;
                        text-transform: uppercase;
                        letter-spacing: 0.4px;
                        font-weight: 600;
                    ">Errors</div>
                    <div style="font-size: 13px; color: ${errorState.total > 0 ? '#b02a37' : '#1a1f36'}; font-weight: 700;">
                        ${errorState.total}${errorTypeSummary ? ` (${escapeHtml(errorTypeSummary)})` : ''}
                    </div>
                </div>

                ${errorState.recent.length > 0 ? `
                    <div style="
                        margin-top: 12px;
                        padding-top: 12px;
                        border-top: 1px solid rgba(230, 232, 235, 0.9);
                    ">
                        <div style="
                            font-size: 10px;
                            color: #697386;
                            text-transform: uppercase;
                            letter-spacing: 0.4px;
                            font-weight: 700;
                            margin-bottom: 6px;
                        ">Recent Errors</div>
                        <div style="display: flex; flex-direction: column; gap: 6px;">
                            ${recentErrorRows}
                        </div>
                    </div>
                ` : ''}
            </div>

            <button id="pauseButton" style="
                background: ${isPaused ? '#635bff' : '#dc3545'};
                border: none;
                color: white;
                padding: 12px 24px;
                border-radius: 12px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 500;
                width: 100%;
                margin-bottom: 24px;
                transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                box-shadow: 
                    0 1px 2px rgba(0,0,0,0.05),
                    0 0 1px rgba(0,0,0,0.1);
                letter-spacing: -0.1px;
            ">
                ${isPaused ? 'Resume Collection' : 'Pause Collection'}
            </button>
        `;

        // Enhanced hover effect for pause button
        const pauseButton = document.getElementById('pauseButton');
        pauseButton.addEventListener('mouseover', () => {
            pauseButton.style.transform = 'translateY(-1px) scale(1.02)';
            pauseButton.style.boxShadow = `
                0 4px 12px ${isPaused ? 'rgba(99,91,255,0.2)' : 'rgba(220,53,69,0.2)'},
                0 0 1px rgba(0,0,0,0.1)
            `;
        });
        pauseButton.addEventListener('mouseout', () => {
            pauseButton.style.transform = 'none';
            pauseButton.style.boxShadow = '0 1px 2px rgba(0,0,0,0.05), 0 0 1px rgba(0,0,0,0.1)';
        });

        // Add active state
        pauseButton.addEventListener('mousedown', () => {
            pauseButton.style.transform = 'translateY(0) scale(0.98)';
        });

        pauseButton.addEventListener('mouseup', () => {
            pauseButton.style.transform = 'translateY(-1px) scale(1.02)';
        });

        pauseButton.addEventListener('click', () => {
            isPaused = !isPaused;
            if (isPaused) {
                updateStatus({ action: 'Paused' });
            } else {
                updateStatus({ action: lastActiveAction || 'Resuming...' });
            }
        });
    };

    const recordError = (type, details = {}) => {
        const normalizedType = typeof type === 'string' && type.trim()
            ? type.trim()
            : 'unknown_error';
        const message = details?.message ? String(details.message) : 'Unknown error';
        const source = details?.sourceUrl ? String(details.sourceUrl) : '';

        errorState.total += 1;
        errorState.byType[normalizedType] = (errorState.byType[normalizedType] || 0) + 1;
        errorState.recent.unshift({
            type: normalizedType,
            message,
            source
        });
        if (errorState.recent.length > MAX_RECENT_ERRORS) {
            errorState.recent.length = MAX_RECENT_ERRORS;
        }

        updateStatus();
    };

    const debugLog = (...args) => {
        console.log('[ProposalCopycat]', ...args);
    };

    const SANDBOX_BRIDGE_SOURCE = 'proposal-copycat-nuxt-sandbox';
    const SANDBOX_REQUEST_TYPE = 'parse-nuxt';
    const SANDBOX_RESPONSE_TYPE = 'parse-nuxt-result';
    const SANDBOX_FRAME_ID = 'proposal-copycat-nuxt-sandbox-frame';
    const SANDBOX_REQUEST_TIMEOUT_MS = 5000;

    let sandboxFramePromise = null;
    let sandboxRequestCounter = 0;
    let sandboxBridgeState = 'unknown';
    const pendingSandboxRequests = new Map();

    const settleSandboxRequest = (requestId, result) => {
        if (!pendingSandboxRequests.has(requestId)) {
            return;
        }

        const pending = pendingSandboxRequests.get(requestId);
        pendingSandboxRequests.delete(requestId);
        clearTimeout(pending.timeoutId);
        pending.resolve(result);
    };

    const sandboxMessageHandler = (event) => {
        const data = event?.data;
        if (!data || data.source !== SANDBOX_BRIDGE_SOURCE || data.type !== SANDBOX_RESPONSE_TYPE) {
            return;
        }

        const sandboxFrame = document.getElementById(SANDBOX_FRAME_ID);
        if (!sandboxFrame || event.source !== sandboxFrame.contentWindow) {
            return;
        }

        if (!pendingSandboxRequests.has(data.requestId)) {
            return;
        }

        if (!data.ok) {
            sandboxBridgeState = 'ready';
            settleSandboxRequest(data.requestId, {
                ok: false,
                error: data.error || 'sandbox parser returned an error'
            });
            return;
        }

        sandboxBridgeState = 'ready';
        settleSandboxRequest(data.requestId, {
            ok: true,
            payload: data.payload || null
        });
    };

    window.addEventListener('message', sandboxMessageHandler);

    const ensureSandboxFrame = async () => {
        if (sandboxFramePromise) {
            return sandboxFramePromise;
        }

        sandboxFramePromise = new Promise((resolve, reject) => {
            const existingFrame = document.getElementById(SANDBOX_FRAME_ID);
            if (existingFrame) {
                resolve(existingFrame);
                return;
            }

            const sandboxFrame = document.createElement('iframe');
            sandboxFrame.id = SANDBOX_FRAME_ID;
            sandboxFrame.style.display = 'none';
            sandboxFrame.setAttribute('aria-hidden', 'true');
            sandboxFrame.src = chrome.runtime.getURL('sandbox.html');

            sandboxFrame.addEventListener('load', () => {
                debugLog('[Nuxt] sandbox frame loaded.');
                resolve(sandboxFrame);
            }, { once: true });

            sandboxFrame.addEventListener('error', () => {
                sandboxBridgeState = 'disabled';
                sandboxFramePromise = null;
                reject(new Error('Failed to load sandbox parser frame.'));
            }, { once: true });

            const hostNode = document.documentElement || document.body;
            if (!hostNode) {
                sandboxFramePromise = null;
                reject(new Error('Could not mount sandbox frame (missing root node).'));
                return;
            }

            hostNode.appendChild(sandboxFrame);
        });

        return sandboxFramePromise;
    };

    const parseNuxtScalarsInSandbox = async (scriptText, sourceUrl = '') => {
        if (!scriptText) {
            return null;
        }

        if (sandboxBridgeState === 'disabled') {
            return null;
        }

        let sandboxFrame;
        try {
            sandboxFrame = await ensureSandboxFrame();
        } catch (error) {
            sandboxBridgeState = 'disabled';
            debugLog(`[Nuxt] ${sourceUrl || 'unknown-url'}: sandbox unavailable (${error.message}).`);
            return null;
        }

        if (!sandboxFrame?.contentWindow) {
            debugLog(`[Nuxt] ${sourceUrl || 'unknown-url'}: sandbox frame has no contentWindow.`);
            return null;
        }

        const sandboxResponse = await new Promise((resolve) => {
            const requestId = `nuxt-${Date.now()}-${sandboxRequestCounter++}`;
            const timeoutId = setTimeout(() => {
                sandboxBridgeState = 'disabled';
                settleSandboxRequest(requestId, {
                    ok: false,
                    error: 'sandbox parser timed out'
                });
            }, SANDBOX_REQUEST_TIMEOUT_MS);

            pendingSandboxRequests.set(requestId, { resolve, timeoutId });

            sandboxFrame.contentWindow.postMessage({
                source: SANDBOX_BRIDGE_SOURCE,
                type: SANDBOX_REQUEST_TYPE,
                requestId,
                sourceUrl,
                scriptText
            }, '*');
        });

        if (!sandboxResponse?.ok) {
            return null;
        }

        return sandboxResponse.payload || null;
    };

    const teardownSandboxBridge = async () => {
        window.removeEventListener('message', sandboxMessageHandler);

        for (const [requestId, pending] of pendingSandboxRequests.entries()) {
            clearTimeout(pending.timeoutId);
            pending.resolve(null);
            pendingSandboxRequests.delete(requestId);
        }

        try {
            const sandboxFrame = await sandboxFramePromise;
            if (sandboxFrame?.remove) {
                sandboxFrame.remove();
            }
        } catch (error) {
            // Ignore teardown errors from failed sandbox frame initialization.
        } finally {
            sandboxFramePromise = null;
        }
    };

    debugLog(`Loaded ${existingProposals.length} existing proposals from storage. Mode: ${scrapeMode}`);
    
    document.body.appendChild(statusPopup);
    updateStatus({ action: 'Starting scraper...' });

    const getElementLabel = (element) => {
        const labelledBy = (element.getAttribute('aria-labelledby') || '')
            .split(/\s+/)
            .filter(Boolean)
            .map(id => document.getElementById(id)?.textContent || '')
            .join(' ');

        return [
            element.textContent || '',
            element.getAttribute('aria-label') || '',
            labelledBy,
            element.getAttribute('title') || '',
            element.getAttribute('data-test') || '',
            element.getAttribute('data-ev-label') || ''
        ].join(' ')
            .replace(/\s+/g, ' ')
            .trim();
    };

    const isElementDisabled = (element) => {
        if (!element) return true;
        if (element.disabled) return true;
        if (element.getAttribute('aria-disabled') === 'true') return true;
        if (element.classList?.contains('disabled')) return true;
        return false;
    };

    const isReasonAllowed = (reason) => {
        if (scrapeMode === 'all') {
            return true;
        }

        return String(reason).trim().toLowerCase() === 'hired';
    };

    const extractSubmissionTime = (timeCell) => {
        if (!timeCell) {
            return null;
        }

        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const mainRow = timeCell.querySelector('.cell-content-wrapper > div') || timeCell.querySelector('div');
        const dateNode = mainRow?.querySelector('span.nowrap');
        const dateText = normalize(dateNode?.textContent);

        if (dateText) {
            const parsedFromDateNode = Date.parse(dateText);
            if (Number.isFinite(parsedFromDateNode)) {
                return parsedFromDateNode;
            }
        }

        const fallbackText = normalize(timeCell.textContent);
        const dateMatch = fallbackText.match(/\b[A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}\b/);
        if (dateMatch) {
            const parsedFromFallback = Date.parse(dateMatch[0]);
            if (Number.isFinite(parsedFromFallback)) {
                return parsedFromFallback;
            }
        }

        return null;
    };

    const parsePaginationState = (proposalsDiv) => {
        const scopedControls = proposalsDiv
            ? Array.from(proposalsDiv.querySelectorAll('button, a[role="button"], a[href]'))
            : [];
        const globalControls = Array.from(document.querySelectorAll('button, a[role="button"], a[href]'));
        const controls = Array.from(new Set([...scopedControls, ...globalControls]));

        let currentPage = '';
        let totalPages = '';

        const ariaCurrentPage = (proposalsDiv?.querySelector('[aria-current="page"]') || document.querySelector('[aria-current="page"]'));
        if (ariaCurrentPage) {
            const pageMatch = (ariaCurrentPage.textContent || '').match(/\d+/);
            if (pageMatch) {
                [currentPage] = pageMatch;
            }
        }

        const currentPageButton = controls.find(button => {
            const label = getElementLabel(button);
            return /current page/i.test(label) || /page\s+\d+\s+of\s+\d+/i.test(label);
        });

        if (currentPageButton) {
            const paginationText = getElementLabel(currentPageButton);
            const match = paginationText.match(/(?:current page\s*)?(\d+)\s+of\s+(\d+)/i);
            if (match) {
                [, currentPage, totalPages] = match;
            }
        }

        if (!totalPages) {
            for (const control of controls) {
                const label = getElementLabel(control);
                const ofMatch = label.match(/\bof\s+(\d+)\b/i);
                if (ofMatch) {
                    [, totalPages] = ofMatch;
                    break;
                }
            }
        }

        let nextButton = (
            proposalsDiv?.querySelector('button[data-test="next-page"], a[data-test="next-page"], button[data-ev-label="pagination_next_page"], a[data-ev-label="pagination_next_page"]') ||
            document.querySelector('button[data-test="next-page"], a[data-test="next-page"], button[data-ev-label="pagination_next_page"], a[data-ev-label="pagination_next_page"]')
        );

        if (!nextButton) {
            nextButton = controls.find(button => {
                const label = getElementLabel(button);
                return /\bnext\b/i.test(label) || /go to next/i.test(label);
            });
        }

        if (!nextButton) {
            nextButton = controls.find(button => {
                const label = getElementLabel(button);
                return /pagination_next_page/i.test(label) || /next-page/i.test(label);
            });
        }

        if (!nextButton && currentPage && totalPages) {
            const nextPageNumber = String(Number(currentPage) + 1);
            if (Number(nextPageNumber) <= Number(totalPages)) {
                nextButton = controls.find(button => {
                    const label = getElementLabel(button);
                    return (
                        new RegExp(`\\bpage\\s*${nextPageNumber}\\b`, 'i').test(label) ||
                        new RegExp(`^${nextPageNumber}$`).test((button.textContent || '').trim())
                    );
                });
            }
        }

        const nextButtonLabel = nextButton
            ? (getElementLabel(nextButton) || nextButton.outerHTML.slice(0, 120))
            : '';
        const isNextDisabled = isElementDisabled(nextButton);

        return { currentPage, totalPages, nextButton, nextButtonLabel, isNextDisabled };
    };

    const scrapeCurrentPage = () => {
        const allDivs = document.querySelectorAll('div[data-qa="card-archived-proposals"]');
        const proposalsDiv = Array.from(allDivs).find(div => {
            const h2 = div.querySelector('h2');
            return h2 && h2.textContent.includes('Archived proposals');
        });

        if (!proposalsDiv) return null;
        
        const h2 = proposalsDiv.querySelector('h2');
        debugLog('Section heading:', h2 ? h2.textContent.trim() : 'No h2 found');
        
        const table = proposalsDiv.querySelector('table');
        if (!table) return null;

        const tableSignature = Array.from(table.querySelectorAll('tr a[href]'))
            .slice(0, 5)
            .map(a => a.href)
            .join('|');
        
        // Filter out already scraped proposals
        const links = Array.from(table.querySelectorAll('tr')).map(row => {
            const reasonCell = row.querySelector('td[data-qa="reason-slot"]');
            const link = row.querySelector('a[href]');
            if (!reasonCell || !link) return null;
            
            const reason = reasonCell.textContent.trim();
            
            // Skip rows outside the selected mode and already scraped URLs.
            if (!isReasonAllowed(reason)) return null;
            if (existingUrls.has(link.href)) return null;
            
            const title = (link.textContent || '').trim();
            const timeCell = row.querySelector('td[data-cy="time-slot"]');
            return {
                href: link.href,
                text: title,
                reason: row.querySelector('td[data-qa="reason-slot"]').textContent.trim(),
                submissionTime: extractSubmissionTime(timeCell)
            };
        }).filter(Boolean);

        const paginationState = parsePaginationState(proposalsDiv);
        
        return { 
            links, 
            proposalsDiv, 
            tableSignature, 
            currentPage: paginationState.currentPage, 
            totalPages: paginationState.totalPages, 
            nextButton: paginationState.nextButton, 
            nextButtonLabel: paginationState.nextButtonLabel,
            isNextDisabled: paginationState.isNextDisabled
        };
    };

    const waitForTable = () => {
        updateStatus({ action: 'Waiting for proposals table...' });
        debugLog('Waiting for archived proposals table...');
        return new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                const result = scrapeCurrentPage();
                if (result) {
                    clearInterval(checkInterval);
                    debugLog(`Table loaded. Page ${result.currentPage || '?'} of ${result.totalPages || '?'}. Eligible links: ${result.links.length}`);
                    resolve(result);
                }
            }, 1000);

            setTimeout(() => {
                clearInterval(checkInterval);
                debugLog('Timed out waiting for archived proposals table.');
                resolve(null);
            }, 30000);
        });
    };

    const waitForNextPageLoad = (previousPage, previousTableSignature) => {
        return new Promise((resolve) => {
            let stableChangeCount = 0;

            const checkInterval = setInterval(() => {
                const result = scrapeCurrentPage();
                if (!result) return;

                const pageChanged =
                    previousPage &&
                    result.currentPage &&
                    result.currentPage !== previousPage;

                const tableChanged =
                    previousTableSignature &&
                    result.tableSignature &&
                    result.tableSignature !== previousTableSignature;

                if (pageChanged || tableChanged) {
                    stableChangeCount += 1;
                    if (stableChangeCount >= 2) {
                        clearInterval(checkInterval);
                        clearTimeout(timeoutId);
                        debugLog(
                            `Detected next page. Previous page/signature: ${previousPage || '?'} / ${previousTableSignature || 'none'} -> ` +
                            `${result.currentPage || '?'} / ${result.tableSignature || 'none'}`
                        );
                        resolve(result);
                    }
                } else {
                    stableChangeCount = 0;
                }
            }, 700);

            const timeoutId = setTimeout(() => {
                clearInterval(checkInterval);
                debugLog('Timed out waiting for next page content.');
                resolve(null);
            }, 20000);
        });
    };

    const extractNuxtScalarData = async (scriptText, sourceUrl = '') => {
        if (!scriptText) {
            return {
                aliases: {},
                fields: {},
                assignments: {},
                rawParsedData: null
            };
        }

        const sandboxResult = await parseNuxtScalarsInSandbox(scriptText, sourceUrl);
        const sandboxFields = sandboxResult?.fields;
        const sandboxRawParsedData = sandboxResult?.rawParsedData || null;
        const hasFieldData = (
            sandboxFields &&
            typeof sandboxFields === 'object' &&
            Object.keys(sandboxFields).length > 0
        );

        if (hasFieldData || sandboxRawParsedData) {
            debugLog(
                `[Nuxt] ${sourceUrl || 'unknown-url'}: sandbox extraction succeeded with ` +
                `${hasFieldData ? Object.keys(sandboxFields).length : 0} field key(s).`
            );
            return {
                aliases: {},
                fields: hasFieldData ? sandboxFields : {},
                assignments: {},
                rawParsedData: sandboxRawParsedData
            };
        }

        debugLog(`[Nuxt] ${sourceUrl || 'unknown-url'}: sandbox extraction failed, returning empty scalar data.`);
        return {
            aliases: {},
            fields: {},
            assignments: {},
            rawParsedData: null
        };
    };

    const setIfPresent = (target, key, value) => {
        if (value === undefined || value === null) {
            return;
        }

        if (Array.isArray(value) && value.length === 0) {
            return;
        }

        if (
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.keys(value).length === 0
        ) {
            return;
        }

        target[key] = value;
    };

    const removeEmptySections = (obj) => {
        const cleaned = { ...obj };
        for (const [sectionKey, sectionValue] of Object.entries(cleaned)) {
            if (!sectionValue || typeof sectionValue !== 'object' || Array.isArray(sectionValue)) {
                continue;
            }

            if (!Object.keys(sectionValue).length) {
                delete cleaned[sectionKey];
            }
        }
        return cleaned;
    };

    const buildCleanNuxtDataFromRawParsedData = (rawParsedData, linkData) => {
        const state = rawParsedData?.state || {};
        const proposalDetails = state['proposal-details']?.proposalDetailsV3Response || {};
        const application = proposalDetails.application || {};
        const jobDetails = proposalDetails.jobDetails || {};
        const job = jobDetails.opening?.job || {};
        const buyer = jobDetails.buyer || {};
        const buyerInfo = buyer.info || {};
        const currentOrg = state.orgs?.current || {};

        const freelancer = {};
        setIfPresent(freelancer, 'id', proposalDetails.applicant?.personUid);
        setIfPresent(freelancer, 'firstName', proposalDetails.applicant?.person?.personName?.firstName);
        setIfPresent(freelancer, 'lastName', proposalDetails.applicant?.person?.personName?.lastName);
        setIfPresent(freelancer, 'profileRate', proposalDetails.applicantsProfileRate);
        setIfPresent(freelancer, 'title', currentOrg.title);
        setIfPresent(freelancer, 'photoUrl', currentOrg.portrait100);
        setIfPresent(freelancer, 'agencyOrSolo', currentOrg.typeTitle);

        const clientLocation = {};
        setIfPresent(clientLocation, 'country', buyerInfo.location?.country);
        setIfPresent(clientLocation, 'city', buyerInfo.location?.city);
        setIfPresent(clientLocation, 'state', buyerInfo.location?.state);
        setIfPresent(clientLocation, 'timezone', buyerInfo.location?.countryTimezone);

        const historyStats = {};
        setIfPresent(historyStats, 'totalSpent', buyerInfo.stats?.totalCharges?.amount);
        setIfPresent(historyStats, 'feedbackCount', buyerInfo.stats?.feedbackCount);
        setIfPresent(historyStats, 'ratingScore', buyerInfo.stats?.score);
        setIfPresent(historyStats, 'totalJobsPosted', buyerInfo.jobs?.postedCount);
        setIfPresent(historyStats, 'totalJobsWithHires', buyerInfo.stats?.totalJobsWithHires);
        setIfPresent(historyStats, 'activeAssignments', buyerInfo.stats?.activeAssignmentsCount);

        const client = {};
        setIfPresent(client, 'companyId', buyerInfo.company?.companyUid);
        setIfPresent(client, 'location', clientLocation);
        setIfPresent(client, 'historyStats', historyStats);
        setIfPresent(client, 'isPaymentVerified', buyer.isPaymentMethodVerified);
        setIfPresent(client, 'isEnterprise', buyer.isEnterprise);
        setIfPresent(client, 'memberSince', buyerInfo.company?.contractDate);

        const budget = {};
        const budgetAmount = job.budget?.amount;
        const hasHourlyBudgetInfo = (
            job.extendedBudgetInfo?.hourlyBudgetMin !== undefined ||
            job.extendedBudgetInfo?.hourlyBudgetMax !== undefined
        );
        let budgetType = null;
        if (typeof budgetAmount === 'number') {
            budgetType = budgetAmount === 0 ? 'Hourly' : 'Fixed';
        } else if (hasHourlyBudgetInfo) {
            budgetType = 'Hourly';
        }
        setIfPresent(budget, 'type', budgetType);
        setIfPresent(budget, 'amount', budgetAmount);
        setIfPresent(budget, 'hourlyMin', job.extendedBudgetInfo?.hourlyBudgetMin);
        setIfPresent(budget, 'hourlyMax', job.extendedBudgetInfo?.hourlyBudgetMax);

        const skillsAndExpertise = {};
        setIfPresent(skillsAndExpertise, 'occupation', job.sandsData?.occupation?.prefLabel);
        setIfPresent(
            skillsAndExpertise,
            'additionalSkills',
            (job.sandsData?.additionalSkills || []).map((skill) => skill?.prefLabel).filter(Boolean)
        );
        setIfPresent(
            skillsAndExpertise,
            'ontologySkills',
            (job.sandsData?.ontologySkills || []).map((skill) => skill?.prefLabel).filter(Boolean)
        );

        const clientActivityOnJob = {};
        setIfPresent(clientActivityOnJob, 'invitationsSent', job.clientActivity?.invitationsSent);
        setIfPresent(clientActivityOnJob, 'totalInvitedToInterview', job.clientActivity?.totalInvitedToInterview);
        setIfPresent(clientActivityOnJob, 'unansweredInvites', job.clientActivity?.unansweredInvites);
        setIfPresent(clientActivityOnJob, 'totalApplicants', job.clientActivity?.totalApplicants);
        setIfPresent(clientActivityOnJob, 'totalHired', job.clientActivity?.totalHired);
        setIfPresent(clientActivityOnJob, 'lastBuyerActivity', job.clientActivity?.lastBuyerActivity);

        const clientRequirements = {};
        setIfPresent(clientRequirements, 'minHoursWeek', jobDetails.qualifications?.minHoursWeek);
        setIfPresent(clientRequirements, 'minJobSuccessScore', jobDetails.qualifications?.minJobSuccessScore);
        setIfPresent(clientRequirements, 'englishSkillLevel', jobDetails.qualifications?.prefEnglishSkill);
        if (jobDetails.qualifications?.localMarket !== undefined) {
            setIfPresent(
                clientRequirements,
                'locationPreference',
                jobDetails.qualifications.localMarket ? 'Local/Specific' : 'Worldwide'
            );
        }

        const jobPost = {};
        setIfPresent(jobPost, 'jobId', job.openingUid);
        setIfPresent(jobPost, 'url', job.info?.ciphertext ? `https://www.upwork.com/jobs/${job.info.ciphertext}` : null);
        setIfPresent(jobPost, 'title', job.info?.title);
        setIfPresent(jobPost, 'description', job.description);
        setIfPresent(jobPost, 'category', job.category?.name);
        setIfPresent(jobPost, 'postedOn', job.postedOn);
        setIfPresent(jobPost, 'workload', job.workload);
        setIfPresent(jobPost, 'duration', job.engagementDuration?.label);
        setIfPresent(jobPost, 'tier', job.contractorTier);
        setIfPresent(jobPost, 'budget', budget);
        setIfPresent(jobPost, 'skillsAndExpertise', skillsAndExpertise);
        setIfPresent(jobPost, 'clientActivityOnJob', clientActivityOnJob);
        setIfPresent(jobPost, 'clientRequirements', clientRequirements);
        setIfPresent(
            jobPost,
            'screeningQuestions',
            (jobDetails.qualifications?.questions || []).map((item) => item?.question).filter(Boolean)
        );

        const terms = {};
        setIfPresent(terms, 'proposedRate', application.terms?.chargeRate?.amount);
        setIfPresent(terms, 'connectsSpent', application.terms?.connectsBid);

        const competitionStats = {};
        setIfPresent(competitionStats, 'hired', proposalDetails.jobApplicationsCount?.hired?.count || 0);
        setIfPresent(competitionStats, 'archived', proposalDetails.jobApplicationsCount?.archived?.count || 0);
        setIfPresent(competitionStats, 'declined', proposalDetails.jobApplicationsCount?.declined?.count || 0);
        setIfPresent(competitionStats, 'withdrawn', proposalDetails.jobApplicationsCount?.withdrawn?.count || 0);

        const proposal = {};
        setIfPresent(proposal, 'applicationId', application.applicationUID);
        setIfPresent(proposal, 'submittedOn', linkData?.submissionTime || job.postedOn || null);
        setIfPresent(proposal, 'coverLetter', application.coverLetter);
        setIfPresent(proposal, 'proposalUrl', linkData?.href || null);
        setIfPresent(proposal, 'terms', terms);
        setIfPresent(
            proposal,
            'answersToQuestions',
            (application.questionsAnswers || []).map((item) => ({
                question: item?.question || null,
                answer: item?.answer || null
            }))
        );
        setIfPresent(proposal, 'competitionStats', competitionStats);

        return removeEmptySections({
            freelancer,
            client,
            jobPost,
            proposal
        });
    };

    const buildCleanNuxtData = (rawNuxtData, linkData) => (
        buildCleanNuxtDataFromRawParsedData(rawNuxtData?.rawParsedData, linkData)
    );

    const extractNuxtData = async (parsedDoc, sourceUrl = '') => {
        const scripts = Array.from(parsedDoc.querySelectorAll('script'));
        debugLog(`[Nuxt] ${sourceUrl || 'unknown-url'}: found ${scripts.length} script tags.`);

        const nuxtCandidates = scripts.filter((script) => {
            const content = script?.textContent || '';
            return content.includes('window.__NUXT__=');
        });

        if (!nuxtCandidates.length) {
            debugLog(`[Nuxt] ${sourceUrl || 'unknown-url'}: window.__NUXT__ script not found.`);
            return null;
        }

        debugLog(
            `[Nuxt] ${sourceUrl || 'unknown-url'}: found ${nuxtCandidates.length} __NUXT__ candidate script(s).`
        );

        let selectedScript = null;
        let selectedIndex = -1;

        for (let index = 0; index < nuxtCandidates.length; index += 1) {
            const scriptText = (nuxtCandidates[index]?.textContent || '').trim();
            if (!scriptText) {
                debugLog(
                    `[Nuxt] ${sourceUrl || 'unknown-url'}: candidate ${index + 1}/${nuxtCandidates.length} is empty.`
                );
                continue;
            }

            const assignmentIndex = scriptText.indexOf('window.__NUXT__=');
            if (assignmentIndex < 0) {
                debugLog(
                    `[Nuxt] ${sourceUrl || 'unknown-url'}: candidate ${index + 1}/${nuxtCandidates.length} ` +
                    'does not contain window.__NUXT__ assignment.'
                );
                continue;
            }

            const nuxtScript = scriptText.slice(assignmentIndex);

            debugLog(
                `[Nuxt] ${sourceUrl || 'unknown-url'}: candidate ${index + 1}/${nuxtCandidates.length} ` +
                `has ${nuxtScript.length} chars from assignment.`
            );

            if (!selectedScript || nuxtScript.length > selectedScript.length) {
                selectedScript = nuxtScript;
                selectedIndex = index + 1;
            }
        }

        if (!selectedScript) {
            debugLog(`[Nuxt] ${sourceUrl || 'unknown-url'}: no usable __NUXT__ script candidate found.`);
            return null;
        }

        debugLog(
            `[Nuxt] ${sourceUrl || 'unknown-url'}: selected candidate ${selectedIndex}/${nuxtCandidates.length} ` +
            `(${selectedScript.length} chars).`
        );
        return selectedScript;
    };

    const extractNuxtDataJsonPayload = (parsedDoc, sourceUrl = '') => {
        const nuxtDataScript = parsedDoc.querySelector('script#__NUXT_DATA__');
        if (!nuxtDataScript) {
            debugLog(`[JobPost] ${sourceUrl || 'unknown-url'}: missing script#__NUXT_DATA__.`);
            return null;
        }

        const jsonText = (nuxtDataScript.textContent || '').trim();
        if (!jsonText) {
            debugLog(`[JobPost] ${sourceUrl || 'unknown-url'}: script#__NUXT_DATA__ is empty.`);
            return null;
        }

        try {
            const parsed = JSON.parse(jsonText);
            debugLog(
                `[JobPost] ${sourceUrl || 'unknown-url'}: parsed __NUXT_DATA__ JSON ` +
                `(${jsonText.length} chars, root=${Array.isArray(parsed) ? 'array' : typeof parsed}).`
            );
            return parsed;
        } catch (error) {
            debugLog(
                `[JobPost] ${sourceUrl || 'unknown-url'}: failed to parse __NUXT_DATA__ JSON ` +
                `(${error?.message || 'unknown error'}).`
            );
            return null;
        }
    };

    const parseNuxtPayload = (nuxtDataArray, sourceUrl = '') => {
        if (!Array.isArray(nuxtDataArray) || nuxtDataArray.length === 0) {
            debugLog(`[JobPost] ${sourceUrl || 'unknown-url'}: invalid nuxtData payload array.`);
            return null;
        }

        const resolvedMap = new Map();

        const resolveRef = (ref) => {
            if (typeof ref !== 'number') {
                return ref;
            }

            if (ref < 0 || ref >= nuxtDataArray.length) {
                return undefined;
            }

            if (resolvedMap.has(ref)) {
                return resolvedMap.get(ref);
            }

            const value = nuxtDataArray[ref];

            if (value === null || typeof value !== 'object') {
                return value;
            }

            if (Array.isArray(value)) {
                if (value.length === 2 && value[0] === 'Reactive') {
                    return resolveRef(value[1]);
                }

                const resolvedArray = [];
                resolvedMap.set(ref, resolvedArray);
                for (const item of value) {
                    resolvedArray.push(resolveRef(item));
                }
                return resolvedArray;
            }

            const resolvedObject = {};
            resolvedMap.set(ref, resolvedObject);
            for (const [key, childRef] of Object.entries(value)) {
                resolvedObject[key] = resolveRef(childRef);
            }
            return resolvedObject;
        };

        try {
            // Nuxt 3 payload hydration root is typically at index 1.
            return resolveRef(1);
        } catch (error) {
            debugLog(
                `[JobPost] ${sourceUrl || 'unknown-url'}: dereference failed ` +
                `(${error?.message || 'unknown error'}).`
            );
            return null;
        }
    };

    const extractCleanJobPostData = (jobPostRawData, sourceUrl = '') => {
        const nuxtData = jobPostRawData?.nuxtData;
        const fullPayload = parseNuxtPayload(nuxtData, sourceUrl);
        if (!fullPayload || typeof fullPayload !== 'object') {
            debugLog(`[JobPost] ${sourceUrl || 'unknown-url'}: no dereferenced payload produced.`);
            return null;
        }

        const statePayload = fullPayload.state && typeof fullPayload.state === 'object'
            ? fullPayload.state
            : {};
        const vuexPayload = fullPayload.vuex && typeof fullPayload.vuex === 'object'
            ? fullPayload.vuex
            : {};
        const appState = { ...statePayload, ...vuexPayload };

        const jobDetails = appState.jobDetails || {};
        const job = jobDetails.job || {};
        const buyer = jobDetails.buyer || {};
        const buyerStats = buyer.stats || {};
        const buyerLocation = buyer.location || {};
        const buyerCompany = buyer.company || {};
        const buyerJobsStats = buyer.jobs || {};
        const viewer = appState.user || {};
        const viewerCurrent = viewer.current || appState.orgs?.current || {};

        const jobPost = {};
        const budget = {};
        const skills = (job.segmentationData?.customFields || [])
            .map((field) => field?.value || field?.label || field?.name)
            .filter(Boolean);
        const screeningQuestions = (job.questions || [])
            .map((question) => question?.question)
            .filter(Boolean);

        setIfPresent(jobPost, 'id', job.uid);
        setIfPresent(jobPost, 'ciphertext', job.ciphertext);
        setIfPresent(jobPost, 'url', job.ciphertext ? `https://www.upwork.com/jobs/${job.ciphertext}` : null);
        setIfPresent(jobPost, 'title', job.title);
        setIfPresent(jobPost, 'description', job.description);
        setIfPresent(jobPost, 'status', job.status);
        setIfPresent(jobPost, 'category', job.category?.name);
        setIfPresent(jobPost, 'subCategory', job.categoryGroup?.name);
        setIfPresent(jobPost, 'type', job.type);
        setIfPresent(budget, 'currency', job.budget?.currencyCode);
        setIfPresent(budget, 'amount', job.budget?.amount);
        setIfPresent(budget, 'weeklyRetainer', job.weeklyRetainerBudget);
        setIfPresent(budget, 'extendedInfo', job.extendedBudgetInfo || null);
        setIfPresent(jobPost, 'budget', budget);
        setIfPresent(jobPost, 'duration', job.engagementDuration);
        setIfPresent(jobPost, 'workload', job.workload);
        setIfPresent(jobPost, 'postedOn', job.postedOn);
        setIfPresent(jobPost, 'clientActivity', job.clientActivity || null);
        setIfPresent(jobPost, 'skills', skills);
        setIfPresent(jobPost, 'screeningQuestions', screeningQuestions);

        const clientInfo = {};
        const clientLocation = {};
        const clientStats = {};
        const companyHistory = {};

        setIfPresent(clientLocation, 'country', buyerLocation.country);
        setIfPresent(clientLocation, 'city', buyerLocation.city);
        setIfPresent(clientLocation, 'timezone', buyerLocation.countryTimezone);

        setIfPresent(clientStats, 'totalSpent', buyerStats.totalCharges?.amount);
        setIfPresent(clientStats, 'totalHires', buyerStats.totalJobsWithHires);
        setIfPresent(clientStats, 'activeAssignments', buyerStats.activeAssignmentsCount);
        setIfPresent(clientStats, 'feedbackScore', buyerStats.score);
        setIfPresent(clientStats, 'avgHourlyRatePaid', buyer.avgHourlyJobsRate);

        setIfPresent(companyHistory, 'memberSince', buyerCompany.contractDate);
        setIfPresent(companyHistory, 'totalJobsPosted', buyerJobsStats.postedCount);
        setIfPresent(companyHistory, 'openJobsCount', buyerJobsStats.openCount);

        setIfPresent(clientInfo, 'location', clientLocation);
        setIfPresent(clientInfo, 'stats', clientStats);
        setIfPresent(clientInfo, 'isPaymentMethodVerified', buyer.isPaymentMethodVerified);
        setIfPresent(clientInfo, 'isEnterprise', buyer.isEnterprise);
        setIfPresent(clientInfo, 'companyHistory', companyHistory);

        const pastJobsSource = Array.isArray(appState.workHistory)
            ? appState.workHistory
            : (Array.isArray(buyer.jobs) ? buyer.jobs : []);
        const clientPastJobs = pastJobsSource
            .map((pastJob) => {
                const entry = {};
                setIfPresent(entry, 'title', pastJob?.jobInfo?.title);
                setIfPresent(entry, 'status', pastJob?.status);
                setIfPresent(entry, 'startDate', pastJob?.startDate);
                setIfPresent(entry, 'endDate', pastJob?.endDate);
                setIfPresent(entry, 'totalCharge', pastJob?.totalCharge);
                setIfPresent(entry, 'freelancerName', pastJob?.contractorInfo?.contractorName);

                const feedbackLeftForFreelancer = {};
                setIfPresent(feedbackLeftForFreelancer, 'score', pastJob?.feedback?.score);
                setIfPresent(feedbackLeftForFreelancer, 'comment', pastJob?.feedback?.comment);
                setIfPresent(entry, 'feedbackLeftForFreelancer', feedbackLeftForFreelancer);

                const feedbackFromFreelancer = {};
                setIfPresent(feedbackFromFreelancer, 'score', pastJob?.feedbackToClient?.score);
                setIfPresent(feedbackFromFreelancer, 'comment', pastJob?.feedbackToClient?.comment);
                setIfPresent(entry, 'feedbackFromFreelancer', feedbackFromFreelancer);

                return entry;
            })
            .filter((entry) => Object.keys(entry).length > 0);

        const viewerProfile = {};
        setIfPresent(viewerProfile, 'name', viewerCurrent.title || null);
        setIfPresent(viewerProfile, 'photoUrl', viewerCurrent.photoUrl || viewerCurrent.portrait100 || null);
        setIfPresent(viewerProfile, 'type', viewerCurrent.type || null);
        setIfPresent(viewerProfile, 'monetizedTitle', viewerCurrent.monetizedTitle || null);

        const cleanData = {};
        setIfPresent(cleanData, 'jobPost', jobPost);
        setIfPresent(cleanData, 'clientInfo', clientInfo);
        setIfPresent(cleanData, 'clientPastJobs', clientPastJobs);
        setIfPresent(cleanData, 'viewerProfile', viewerProfile);
        const normalizedCleanData = removeEmptySections(cleanData);

        debugLog(
            `[JobPost] ${sourceUrl || 'unknown-url'}: cleaned payload built ` +
            `(sections=${Object.keys(normalizedCleanData).join(',') || 'none'}, pastJobs=${clientPastJobs.length}).`
        );
        return normalizedCleanData;
    };

    const fetchJobPostRawData = async (jobUrl, sourceUrl = '') => {
        if (!jobUrl) {
            debugLog(`[JobPost] ${sourceUrl || 'unknown-url'}: no job URL found, skipping job page fetch.`);
            return null;
        }

        try {
            debugLog(`[JobPost] ${sourceUrl || 'unknown-url'}: fetching job page ${jobUrl}`);
            const response = await fetch(jobUrl);
            debugLog(
                `[JobPost] ${sourceUrl || 'unknown-url'}: job page HTTP ${response.status} ` +
                `(${response.ok ? 'ok' : 'not ok'}).`
            );

            if (!response.ok) {
                recordError('job_post_fetch_http', {
                    message: `HTTP ${response.status}`,
                    sourceUrl: `${sourceUrl || 'unknown-url'} -> ${jobUrl}`
                });
                return null;
            }

            const html = await response.text();
            debugLog(`[JobPost] ${sourceUrl || 'unknown-url'}: fetched job HTML (${html.length} chars).`);

            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const nuxtDataPayload = extractNuxtDataJsonPayload(doc, jobUrl);

            if (!nuxtDataPayload) {
                return null;
            }

            const rawJobPostData = {
                url: jobUrl,
                sourceScriptId: '__NUXT_DATA__',
                nuxtData: nuxtDataPayload
            };
            const data = extractCleanJobPostData(rawJobPostData, jobUrl);

            return {
                // rawData: rawJobPostData,
                data
            };
        } catch (error) {
            debugLog(
                `[JobPost] ${sourceUrl || 'unknown-url'}: failed to fetch/parse job page ` +
                `(${error?.message || 'unknown error'}).`
            );
            recordError('job_post_fetch_exception', {
                message: error?.message || 'failed to fetch/parse job page',
                sourceUrl: `${sourceUrl || 'unknown-url'} -> ${jobUrl}`
            });
            return null;
        }
    };

    const buildCompactProposalData = (proposalRecord) => {
        const compact = JSON.parse(JSON.stringify(proposalRecord || {}));

        if (compact?.proposalDetailsPage?.data?.proposal) {
            delete compact.proposalDetailsPage.data.proposal.answersToQuestions;
        }
        if (compact?.proposalDetailsPage?.data?.jobPost) {
            delete compact.proposalDetailsPage.data.jobPost.jobPrompt;
        }
        if (compact?.jobPostPage?.data) {
            delete compact.jobPostPage.data.clientPastJobs;
        }

        // Legacy shape fallback if old records are still flowing through.
        if (compact?.proposal) {
            delete compact.proposal.screeningAnswers;
        }
        if (compact?.jobPost) {
            delete compact.jobPost.jobPrompt;
        }

        return compact;
    };

    const visitProposalPage = async (linkData) => {
        try {
            debugLog(`[Proposal] Fetching ${linkData.href}`);
            const response = await fetch(linkData.href);
            debugLog(`[Proposal] ${linkData.href}: HTTP ${response.status} (${response.ok ? 'ok' : 'not ok'})`);

            if (!response.ok) {
                recordError('proposal_fetch_http', {
                    message: `HTTP ${response.status}`,
                    sourceUrl: linkData.href
                });
                return null;
            }

            const html = await response.text();
            debugLog(`[Proposal] ${linkData.href}: fetched HTML (${html.length} chars).`);
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            const nuxtScript = await extractNuxtData(doc, linkData.href);
            const rawNuxtData = await extractNuxtScalarData(nuxtScript, linkData.href);
            const proposalDetailsData = buildCleanNuxtData(rawNuxtData, linkData);
            const jobPostUrl = proposalDetailsData?.jobPost?.url || null;
            const jobPostFetchResult = await fetchJobPostRawData(jobPostUrl, linkData.href);
            const jobPostData = jobPostFetchResult?.data || null;
            const coverLetter = proposalDetailsData?.proposal?.coverLetter || null;
            const description = proposalDetailsData?.jobPost?.description || null;
            const isHired = /hired/i.test(String(linkData.reason || ''));

            debugLog(
                `[Proposal] ${linkData.href}: extracted from Nuxt -> description=${description ? description.length : 0} chars, ` +
                `coverLetter=${coverLetter ? coverLetter.length : 0} chars, hasNuxtScript=${!!nuxtScript}, ` +
                `dataSections=${Object.keys(proposalDetailsData || {}).join(',') || 'none'}, ` +
                `hasJobPostData=${!!jobPostData}, isHired=${isHired}`
            );

            let proposalData = {
                proposalListPage: {
                    href: linkData.href,
                    text: linkData.text,
                    reason: linkData.reason,
                    submissionTime: linkData.submissionTime,
                    isHired
                },
                proposalDetailsPage: {
                    url: linkData.href,
                    data: proposalDetailsData,
                    // rawParsedData: rawNuxtData?.rawParsedData || null,
                    // nuxtScript: includeRawNuxtScript ? nuxtScript : null
                },
                jobPostPage: {
                    url: jobPostUrl,
                    data: jobPostData
                    // rawData: jobPostRawData
                }
            };

            // Add to local storage
            const storageUpdate = await chrome.storage.local.get('proposals');
            const proposals = storageUpdate.proposals || [];
            proposals.push(proposalData);

            const updateLatestProposal = (nextRecord) => {
                proposalData = nextRecord;
                proposals[proposals.length - 1] = nextRecord;
            };

            try {
                await chrome.storage.local.set({ proposals });
                debugLog(
                    `[Proposal] ${linkData.href}: saved grouped payload by source pages ` +
                    `(sections=list,details,jobPost).`
                );
            } catch (storageError) {
                const hasRawScript = !!proposalData?.proposalDetailsPage?.nuxtScript;
                const hasJobPostRawData = !!proposalData?.jobPostPage?.rawData;
                const hasRawParsedData = !!proposalData?.proposalDetailsPage?.rawParsedData;

                if (hasRawScript) {
                    debugLog(
                        `[Proposal] ${linkData.href}: storage write failed with proposalDetails nuxtScript (${storageError?.message || 'unknown error'}). ` +
                        'Retrying without proposalDetails nuxtScript.'
                    );
                    updateLatestProposal({
                        ...proposalData,
                        proposalDetailsPage: {
                            ...(proposalData.proposalDetailsPage || {}),
                            nuxtScript: null
                        }
                    });
                    try {
                        await chrome.storage.local.set({ proposals });
                        debugLog(`[Proposal] ${linkData.href}: saved without proposalDetails nuxtScript.`);
                    } catch (secondaryStorageError) {
                        debugLog(
                            `[Proposal] ${linkData.href}: storage write still failed without proposalDetails nuxtScript ` +
                            `(${secondaryStorageError?.message || 'unknown error'}). Retrying with compact payload.`
                        );
                        updateLatestProposal(buildCompactProposalData({
                            ...proposalData,
                            proposalDetailsPage: {
                                ...(proposalData.proposalDetailsPage || {}),
                                rawParsedData: null
                            },
                            jobPostPage: {
                                ...(proposalData.jobPostPage || {}),
                                rawData: null
                            }
                        }));
                        await chrome.storage.local.set({ proposals });
                        debugLog(`[Proposal] ${linkData.href}: saved without heavy raw fields using compact payload.`);
                    }
                } else if (hasJobPostRawData) {
                    debugLog(
                        `[Proposal] ${linkData.href}: storage write failed with jobPostPage rawData (${storageError?.message || 'unknown error'}). ` +
                        'Retrying without jobPostPage rawData.'
                    );
                    updateLatestProposal({
                        ...proposalData,
                        jobPostPage: {
                            ...(proposalData.jobPostPage || {}),
                            rawData: null
                        }
                    });
                    try {
                        await chrome.storage.local.set({ proposals });
                        debugLog(`[Proposal] ${linkData.href}: saved without jobPostPage rawData.`);
                    } catch (secondaryStorageError) {
                        debugLog(
                            `[Proposal] ${linkData.href}: storage write still failed without jobPostPage rawData ` +
                            `(${secondaryStorageError?.message || 'unknown error'}). Retrying without proposalDetails rawParsedData.`
                        );
                        updateLatestProposal({
                            ...proposalData,
                            proposalDetailsPage: {
                                ...(proposalData.proposalDetailsPage || {}),
                                rawParsedData: null
                            }
                        });
                        try {
                            await chrome.storage.local.set({ proposals });
                            debugLog(`[Proposal] ${linkData.href}: saved without heavy raw fields.`);
                        } catch (tertiaryStorageError) {
                            debugLog(
                                `[Proposal] ${linkData.href}: storage still failed after removing heavy raw fields ` +
                                `(${tertiaryStorageError?.message || 'unknown error'}). Retrying with compact payload.`
                            );
                            updateLatestProposal(buildCompactProposalData(proposalData));
                            await chrome.storage.local.set({ proposals });
                            debugLog(`[Proposal] ${linkData.href}: saved with compact grouped payload.`);
                        }
                    }
                } else if (hasRawParsedData) {
                    debugLog(
                        `[Proposal] ${linkData.href}: storage write failed with proposalDetails rawParsedData (${storageError?.message || 'unknown error'}). ` +
                        'Retrying without proposalDetails rawParsedData.'
                    );
                    updateLatestProposal({
                        ...proposalData,
                        proposalDetailsPage: {
                            ...(proposalData.proposalDetailsPage || {}),
                            rawParsedData: null
                        }
                    });
                    try {
                        await chrome.storage.local.set({ proposals });
                        debugLog(`[Proposal] ${linkData.href}: saved without proposalDetails rawParsedData.`);
                    } catch (secondaryStorageError) {
                        debugLog(
                            `[Proposal] ${linkData.href}: storage write still failed without proposalDetails rawParsedData ` +
                            `(${secondaryStorageError?.message || 'unknown error'}). Retrying with compact payload.`
                        );
                        updateLatestProposal(buildCompactProposalData(proposalData));
                        await chrome.storage.local.set({ proposals });
                        debugLog(`[Proposal] ${linkData.href}: saved with compact grouped payload.`);
                    }
                } else {
                    debugLog(
                        `[Proposal] ${linkData.href}: storage write failed with grouped cleaned payload ` +
                        `(${storageError?.message || 'unknown error'}). Retrying with compact payload.`
                    );
                    updateLatestProposal(buildCompactProposalData(proposalData));
                    await chrome.storage.local.set({ proposals });
                    debugLog(`[Proposal] ${linkData.href}: saved with compact grouped payload.`);
                }
            }

            existingUrls.add(linkData.href);

            tableData.push(proposalData);
            debugLog(`[Proposal] ${linkData.href}: complete.`);

            return {
                description,
                coverLetter
            };
        } catch (error) {
            recordError('proposal_visit_exception', {
                message: error?.message || 'unexpected proposal visit failure',
                sourceUrl: linkData?.href || 'unknown-url'
            });
            console.error('Error visiting proposal:', linkData.href, error);
            return null;
        }
    };

    try {
        while (true) {
            while (isPaused) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            const result = await waitForTable();
            if (!result) {
                updateStatus({ action: 'No table found after timeout' });
                debugLog('Scraping timeout - no table found');
                break;
            }

            const { links, currentPage, totalPages, tableSignature } = result;
            const listCurrent = currentPage || progressState.listCurrent;
            const listTotal = totalPages || progressState.listTotal;

            updateStatus({
                listCurrent,
                listTotal,
                itemCurrent: 0,
                itemTotal: links.length,
                action: links.length > 0
                    ? 'Opening proposals'
                    : `No new proposals on page ${listCurrent || '?'}`
            });
            
            if (links.length === 0) {
                debugLog(`No new ${modeSummaryText} on page ${currentPage || '?'}.`);
            }

            // Process all proposals from current page
            for (let index = 0; index < links.length; index++) {
                const link = links[index];
                while (isPaused) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                allLinks.push(link);
                updateStatus({
                    listCurrent,
                    listTotal,
                    itemCurrent: index + 1,
                    itemTotal: links.length,
                    action: 'Opening proposals'
                });
                await visitProposalPage(link);
                runMetrics.processedItems += 1;
                updateStatus();
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            runMetrics.completedPages += 1;
            runMetrics.observedItemsInPages += links.length;

            // Re-read pagination from the live DOM in case Upwork re-rendered the section.
            const latestPageState = scrapeCurrentPage();
            if (!latestPageState) {
                updateStatus({ action: 'Could not re-read pagination controls, finishing...' });
                debugLog('Could not find proposals table when re-reading pagination controls.');
                break;
            }

            const nextButton = latestPageState.nextButton;
            if (!nextButton || latestPageState.isNextDisabled) {
                updateStatus({
                    action: 'Reached last page, finishing up...',
                    listCurrent: latestPageState.currentPage || listCurrent,
                    listTotal: latestPageState.totalPages || listTotal,
                    itemCurrent: links.length,
                    itemTotal: links.length
                });
                debugLog(
                    `Stopping pagination. nextButton exists: ${!!nextButton}, disabled: ${latestPageState.isNextDisabled}, ` +
                    `label: "${latestPageState.nextButtonLabel || 'n/a'}", page: ${latestPageState.currentPage || '?'} of ${latestPageState.totalPages || '?'}`
                );
                break;
            }

            updateStatus({
                action: 'Moving to next page...',
                listCurrent,
                listTotal,
                itemCurrent: links.length,
                itemTotal: links.length
            });
            debugLog(`Clicking next page control: "${latestPageState.nextButtonLabel || 'Next'}"`);
            nextButton.click();
            const moved = await waitForNextPageLoad(currentPage, tableSignature);
            if (!moved) {
                updateStatus({ action: 'Could not detect next page load. Check console logs.' });
                debugLog('Pagination click happened, but no page change was detected within timeout.');
                break;
            }
        }

        const completionDelayMs = errorState.total > 0 ? 8000 : 3000;
        updateStatus({
            action: errorState.total > 0
                ? `All done with ${errorState.total} tracked errors. Closing in 8 seconds...`
                : 'All done! Closing in 3 seconds...'
        });
        debugLog('Finished processing all proposals');
        setTimeout(() => {
            statusPopup.remove();
        }, completionDelayMs);

    } catch (error) {
        updateStatus({
            action: `Error: ${error.message}${errorState.total > 0 ? ` (tracked errors: ${errorState.total})` : ''}`
        });
        console.error('Scraping error:', error);
        setTimeout(() => {
            statusPopup.remove();
        }, 5000);
    } finally {
        await teardownSandboxBridge();
    }

    return allLinks;
}
