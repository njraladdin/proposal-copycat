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
            .map((proposal) => proposal?.proposal?.proposalUrl || proposal?.href)
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
                </div>
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

    const debugLog = (...args) => {
        console.log('[ProposalCopycat]', ...args);
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
            return 'N/A';
        }

        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const mainRow = timeCell.querySelector('.cell-content-wrapper > div') || timeCell.querySelector('div');
        const dateNode = mainRow?.querySelector('span.nowrap');
        const relativeNode = timeCell.querySelector('small span, small');

        const dateText = normalize(dateNode?.textContent);
        const relativeText = normalize(relativeNode?.textContent);

        let statusText = normalize(mainRow?.textContent);
        if (dateText) {
            statusText = normalize(statusText.replace(dateText, ''));
        }

        const compact = [statusText, dateText, relativeText].filter(Boolean).join(' | ');
        if (compact) {
            return compact;
        }

        return normalize(timeCell.textContent) || 'N/A';
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

    const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const parseJsonStringLiteral = (literal) => {
        if (!literal || literal === 'null') {
            return null;
        }

        try {
            const parsed = JSON.parse(literal);
            if (typeof parsed !== 'string') {
                return null;
            }
            const trimmed = parsed.trim();
            return trimmed || null;
        } catch (error) {
            return null;
        }
    };

    const parseScalarLiteral = (token) => {
        const trimmed = String(token || '').trim();
        if (!trimmed) {
            return undefined;
        }

        if (trimmed === 'null') return null;
        if (trimmed === 'true') return true;
        if (trimmed === 'false') return false;

        if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(trimmed)) {
            const value = Number(trimmed);
            return Number.isNaN(value) ? undefined : value;
        }

        if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
            return parseJsonStringLiteral(trimmed);
        }

        return undefined;
    };

    const splitTopLevelCsv = (input = '') => {
        const text = String(input);
        const parts = [];
        let current = '';
        let quoteChar = '';
        let isEscaped = false;
        let roundDepth = 0;
        let squareDepth = 0;
        let curlyDepth = 0;

        for (let index = 0; index < text.length; index += 1) {
            const char = text[index];

            if (quoteChar) {
                current += char;
                if (isEscaped) {
                    isEscaped = false;
                } else if (char === '\\') {
                    isEscaped = true;
                } else if (char === quoteChar) {
                    quoteChar = '';
                }
                continue;
            }

            if (char === '"' || char === "'") {
                quoteChar = char;
                current += char;
                continue;
            }

            if (char === '(') roundDepth += 1;
            else if (char === ')') roundDepth = Math.max(0, roundDepth - 1);
            else if (char === '[') squareDepth += 1;
            else if (char === ']') squareDepth = Math.max(0, squareDepth - 1);
            else if (char === '{') curlyDepth += 1;
            else if (char === '}') curlyDepth = Math.max(0, curlyDepth - 1);

            if (
                char === ',' &&
                roundDepth === 0 &&
                squareDepth === 0 &&
                curlyDepth === 0
            ) {
                parts.push(current.trim());
                current = '';
                continue;
            }

            current += char;
        }

        if (current.trim()) {
            parts.push(current.trim());
        }

        return parts;
    };

    const resolveNuxtScalarToken = (token, aliasScalars = null) => {
        const literalValue = parseScalarLiteral(token);
        if (literalValue !== undefined) {
            return literalValue;
        }

        const trimmed = String(token || '').trim();
        if (
            aliasScalars &&
            Object.prototype.hasOwnProperty.call(aliasScalars, trimmed)
        ) {
            return aliasScalars[trimmed];
        }

        return undefined;
    };

    const addUniqueScalarValue = (store, key, value) => {
        if (!key || value === undefined) {
            return;
        }

        let bucket = store.get(key);
        if (!bucket) {
            bucket = new Map();
            store.set(key, bucket);
        }

        const marker = `${typeof value}:${JSON.stringify(value)}`;
        bucket.set(marker, value);
    };

    const finalizeScalarStore = (store) => {
        const result = {};
        for (const [key, bucket] of store.entries()) {
            const values = Array.from(bucket.values());
            if (!values.length) continue;
            result[key] = values.length === 1 ? values[0] : values;
        }
        return result;
    };

    const extractNuxtAliasScalars = (scriptText, sourceUrl = '') => {
        if (!scriptText) {
            return {};
        }

        const paramsMatch = scriptText.match(/^window\.__NUXT__=\(function\(([\s\S]*?)\)\{/);
        const argsMatch = scriptText.match(/\}\)\(([\s\S]*)\)\s*;?\s*$/);

        if (!paramsMatch || !argsMatch) {
            debugLog(`[Nuxt] ${sourceUrl || 'unknown-url'}: could not parse __NUXT__ function header/call args.`);
            return {};
        }

        const params = splitTopLevelCsv(paramsMatch[1]).map((value) => value.trim()).filter(Boolean);
        const args = splitTopLevelCsv(argsMatch[1]);
        const aliasScalars = {};

        for (let index = 0; index < params.length; index += 1) {
            const paramName = params[index];
            const argToken = args[index];
            const resolved = resolveNuxtScalarToken(argToken, null);
            if (resolved !== undefined) {
                aliasScalars[paramName] = resolved;
            }
        }

        debugLog(
            `[Nuxt] ${sourceUrl || 'unknown-url'}: resolved ${Object.keys(aliasScalars).length}/${params.length} scalar aliases.`
        );
        return aliasScalars;
    };

    const extractNuxtScalarData = (scriptText, sourceUrl = '') => {
        if (!scriptText) {
            return {
                aliases: {},
                fields: {},
                assignments: {}
            };
        }

        const aliasScalars = extractNuxtAliasScalars(scriptText, sourceUrl);
        const fieldStore = new Map();
        const assignmentStore = new Map();
        let fieldMatches = 0;
        let assignmentMatches = 0;

        const valueTokenPattern = '(null|true|false|-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?|"(?:\\\\.|[^"\\\\])*"|[A-Za-z_$][\\w$]*)';
        const fieldPattern = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*:\\s*${valueTokenPattern}`, 'g');
        const assignmentPattern = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\.([A-Za-z_$][\\w$]*)\\s*=\\s*${valueTokenPattern}`, 'g');

        let fieldMatch;
        while ((fieldMatch = fieldPattern.exec(scriptText)) !== null) {
            fieldMatches += 1;
            const resolved = resolveNuxtScalarToken(fieldMatch[2], aliasScalars);
            addUniqueScalarValue(fieldStore, fieldMatch[1], resolved);
        }

        let assignmentMatch;
        while ((assignmentMatch = assignmentPattern.exec(scriptText)) !== null) {
            assignmentMatches += 1;
            const resolved = resolveNuxtScalarToken(assignmentMatch[3], aliasScalars);
            addUniqueScalarValue(assignmentStore, `${assignmentMatch[1]}.${assignmentMatch[2]}`, resolved);
        }

        const fields = finalizeScalarStore(fieldStore);
        const assignments = finalizeScalarStore(assignmentStore);

        debugLog(
            `[Nuxt] ${sourceUrl || 'unknown-url'}: scalar extraction -> fieldMatches=${fieldMatches}, ` +
            `fieldKeys=${Object.keys(fields).length}, assignmentMatches=${assignmentMatches}, ` +
            `assignmentKeys=${Object.keys(assignments).length}.`
        );

        return {
            aliases: aliasScalars,
            fields,
            assignments
        };
    };

    const pickLongestString = (value) => {
        if (typeof value === 'string') {
            const trimmed = value.trim();
            return trimmed || null;
        }

        if (Array.isArray(value)) {
            const strings = value
                .filter((item) => typeof item === 'string')
                .map((item) => item.trim())
                .filter(Boolean);

            if (!strings.length) {
                return null;
            }

            return strings.reduce((longest, current) => (
                current.length > longest.length ? current : longest
            ), strings[0]);
        }

        return null;
    };

    const toValueArray = (value) => {
        if (value === undefined || value === null) {
            return [];
        }

        if (!Array.isArray(value)) {
            return [value];
        }

        return value.flatMap((item) => toValueArray(item));
    };

    const normalizePrimitiveValues = (values) => {
        const deduped = new Map();

        for (const item of values) {
            if (item === undefined) {
                continue;
            }

            let normalized = item;
            if (typeof item === 'string') {
                normalized = item.trim();
                if (!normalized) {
                    continue;
                }
            }

            if (
                normalized === null ||
                typeof normalized === 'string' ||
                typeof normalized === 'number' ||
                typeof normalized === 'boolean'
            ) {
                const marker = `${typeof normalized}:${JSON.stringify(normalized)}`;
                deduped.set(marker, normalized);
            }
        }

        return Array.from(deduped.values());
    };

    const pickLongestStringFromValues = (values) => {
        const strings = values.filter((item) => typeof item === 'string');
        if (!strings.length) {
            return null;
        }

        return strings.reduce((longest, current) => (
            current.length > longest.length ? current : longest
        ), strings[0]);
    };

    const pickFirstStringFromValues = (values) => {
        const value = values.find((item) => typeof item === 'string');
        return value === undefined ? null : value;
    };

    const pickFirstNumberFromValues = (values) => {
        const value = values.find((item) => typeof item === 'number' && Number.isFinite(item));
        return value === undefined ? null : value;
    };

    const pickStringsFromValues = (values) => {
        const strings = values.filter((item) => typeof item === 'string');
        return strings.length ? strings : null;
    };

    const pickPrimitivesFromValues = (values) => (
        values.length ? values : null
    );

    const pickFirstNumericFromValues = (values) => {
        for (const item of values) {
            if (typeof item === 'number' && Number.isFinite(item)) {
                return item;
            }

            if (typeof item === 'string') {
                const trimmed = item.trim();
                if (!trimmed) {
                    continue;
                }

                const normalized = trimmed.replace(/,/g, '');
                const parsed = Number(normalized);
                if (Number.isFinite(parsed)) {
                    return parsed;
                }
            }
        }

        return null;
    };

    const collectNuxtValuesByKey = (rawNuxtData, key) => {
        const collected = [];

        if (rawNuxtData?.fields && Object.prototype.hasOwnProperty.call(rawNuxtData.fields, key)) {
            collected.push(...toValueArray(rawNuxtData.fields[key]));
        }

        if (rawNuxtData?.assignments) {
            for (const [assignmentKey, assignmentValue] of Object.entries(rawNuxtData.assignments)) {
                const suffix = assignmentKey.split('.').pop();
                if (suffix === key) {
                    collected.push(...toValueArray(assignmentValue));
                }
            }
        }

        return normalizePrimitiveValues(collected);
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

    const buildCleanNuxtData = (rawNuxtData, linkData) => {
        const getValues = (key) => collectNuxtValuesByKey(rawNuxtData, key);

        const jobPost = {};
        const proposal = {};
        const freelancer = {};
        const client = {};
        const basePath = pickFirstStringFromValues(getValues('basePath'));
        const routePath = pickFirstStringFromValues(getValues('routePath'));
        const normalizedBasePath = basePath
            ? (basePath.endsWith('/') ? basePath : `${basePath}/`)
            : '/nx/proposals/';
        const normalizedRoutePath = routePath
            ? (routePath.startsWith('/') ? routePath.slice(1) : routePath)
            : null;
        const proposalUrlFromNuxt = normalizedRoutePath
            ? `https://www.upwork.com${normalizedBasePath}${normalizedRoutePath}`
            : null;
        const workload = pickLongestStringFromValues(getValues('workload'));
        const rawProposedAmounts = pickPrimitivesFromValues(getValues('amount'));
        const normalizedProposedAmount = pickFirstNumericFromValues(rawProposedAmounts || []);
        const isHourlyByWorkload = typeof workload === 'string' && /\bhrs?\b/i.test(workload);

        setIfPresent(jobPost, 'title', pickFirstStringFromValues(getValues('title')));
        setIfPresent(jobPost, 'description', pickLongestStringFromValues(getValues('description')));
        setIfPresent(jobPost, 'workload', workload);
        setIfPresent(jobPost, 'expectedDeliveryDate', pickLongestStringFromValues(getValues('deliveryDate')));
        setIfPresent(jobPost, 'category', pickFirstStringFromValues(getValues('name')));
        setIfPresent(jobPost, 'skills', pickStringsFromValues(getValues('prefLabel')));
        setIfPresent(jobPost, 'skillIds', pickStringsFromValues(getValues('ontologyId')));
        setIfPresent(jobPost, 'categorySlugs', pickStringsFromValues(getValues('urlSlug')));
        setIfPresent(jobPost, 'jobPrompt', pickLongestStringFromValues(getValues('generate_prompt')));

        setIfPresent(proposal, 'coverLetter', pickLongestStringFromValues(getValues('coverLetter')));
        setIfPresent(proposal, 'connectsSpent', pickFirstNumberFromValues(getValues('connectsBid')));
        setIfPresent(proposal, 'proposedAmounts', rawProposedAmounts);
        setIfPresent(proposal, 'amountType', normalizedProposedAmount === null ? null : (isHourlyByWorkload ? 'hourly' : 'fixed'));
        setIfPresent(proposal, 'hourlyRate', isHourlyByWorkload ? normalizedProposedAmount : null);
        setIfPresent(proposal, 'fixedAmount', isHourlyByWorkload ? null : normalizedProposedAmount);
        setIfPresent(proposal, 'screeningAnswers', pickStringsFromValues(getValues('answer')));
        setIfPresent(proposal, 'status', pickFirstStringFromValues(getValues('status')));
        setIfPresent(
            proposal,
            'submittedAtLabel',
            pickFirstStringFromValues(getValues('submissionTime')) || linkData?.submissionTime || null
        );
        setIfPresent(proposal, 'proposalUrl', proposalUrlFromNuxt || linkData?.href || null);

        setIfPresent(freelancer, 'firstName', pickFirstStringFromValues(getValues('firstName')));
        setIfPresent(freelancer, 'lastName', pickFirstStringFromValues(getValues('lastName')));
        setIfPresent(freelancer, 'applicationsCount', pickFirstNumberFromValues(getValues('jobApplicationsCount')));
        setIfPresent(freelancer, 'profileRate', pickFirstNumberFromValues(getValues('applicantsProfileRate')));

        const clientLocation = {};
        setIfPresent(client, 'companyUid', pickFirstStringFromValues(getValues('companyUid')));
        setIfPresent(client, 'jobsPosted', pickFirstNumberFromValues(getValues('postedCount')));
        setIfPresent(client, 'feedbackCount', pickFirstNumberFromValues(getValues('feedbackCount')));
        setIfPresent(client, 'lastActivity', pickLongestStringFromValues(getValues('lastBuyerActivity')));
        setIfPresent(client, 'minRequiredJobSuccessScore', pickFirstNumberFromValues(getValues('minJobSuccessScore')));
        setIfPresent(client, 'totalAssignments', pickFirstNumberFromValues(getValues('totalAssignments')));
        setIfPresent(client, 'totalJobsWithHires', pickFirstNumberFromValues(getValues('totalJobsWithHires')));
        setIfPresent(client, 'memberSince', pickFirstStringFromValues(getValues('contractDate')));
        setIfPresent(clientLocation, 'city', pickFirstStringFromValues(getValues('city')));
        setIfPresent(clientLocation, 'state', pickFirstStringFromValues(getValues('state')));
        setIfPresent(clientLocation, 'country', pickFirstStringFromValues(getValues('country')));
        setIfPresent(client, 'location', clientLocation);

        return removeEmptySections({
            jobPost,
            proposal,
            freelancer,
            client
        });
    };

    const extractFieldFromNuxtScript = (scriptText, fieldName, sourceUrl = '') => {
        if (!scriptText) {
            debugLog(`[Nuxt] ${sourceUrl || 'unknown-url'}: cannot extract ${fieldName} (missing Nuxt script).`);
            return null;
        }

        const pattern = new RegExp(
            `\\b${escapeRegExp(fieldName)}\\s*:\\s*(null|"(?:\\\\.|[^"\\\\])*")`,
            'g'
        );

        let totalMatches = 0;
        const values = [];
        let match;
        while ((match = pattern.exec(scriptText)) !== null) {
            totalMatches += 1;
            const decoded = parseJsonStringLiteral(match[1]);
            if (decoded) {
                values.push(decoded);
            }
        }

        if (!totalMatches) {
            debugLog(`[Nuxt] ${sourceUrl || 'unknown-url'}: ${fieldName} not found in Nuxt script.`);
            return null;
        }

        if (!values.length) {
            debugLog(
                `[Nuxt] ${sourceUrl || 'unknown-url'}: ${fieldName} had ${totalMatches} match(es) but no non-null string values.`
            );
            return null;
        }

        const bestValue = values.reduce((longest, current) => (
            current.length > longest.length ? current : longest
        ), values[0]);

        debugLog(
            `[Nuxt] ${sourceUrl || 'unknown-url'}: extracted ${fieldName} from Nuxt script ` +
            `(${bestValue.length} chars, ${values.length}/${totalMatches} non-null match(es)).`
        );

        return bestValue;
    };

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

    const visitProposalPage = async (linkData) => {
        try {
            debugLog(`[Proposal] Fetching ${linkData.href}`);
            const response = await fetch(linkData.href);
            debugLog(`[Proposal] ${linkData.href}: HTTP ${response.status} (${response.ok ? 'ok' : 'not ok'})`);

            if (!response.ok) {
                throw new Error(`Failed to fetch proposal page: HTTP ${response.status}`);
            }

            const html = await response.text();
            debugLog(`[Proposal] ${linkData.href}: fetched HTML (${html.length} chars).`);
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            const nuxtScript = await extractNuxtData(doc, linkData.href);
            const rawNuxtData = extractNuxtScalarData(nuxtScript, linkData.href);
            const cleanData = buildCleanNuxtData(rawNuxtData, linkData);
            const coverLetter =
                cleanData?.proposal?.coverLetter ||
                extractFieldFromNuxtScript(nuxtScript, 'coverLetter', linkData.href);
            const description =
                cleanData?.jobPost?.description ||
                extractFieldFromNuxtScript(nuxtScript, 'description', linkData.href);

            if (!cleanData?.proposal?.coverLetter && coverLetter) {
                cleanData.proposal = cleanData.proposal || {};
                cleanData.proposal.coverLetter = coverLetter;
            }

            if (!cleanData?.jobPost?.description && description) {
                cleanData.jobPost = cleanData.jobPost || {};
                cleanData.jobPost.description = description;
            }

            debugLog(
                `[Proposal] ${linkData.href}: extracted from Nuxt -> description=${description ? description.length : 0} chars, ` +
                `coverLetter=${coverLetter ? coverLetter.length : 0} chars, hasNuxtScript=${!!nuxtScript}, ` +
                `cleanSections=${Object.keys(cleanData || {}).join(',') || 'none'}`
            );
            
            const proposalData = {
                ...cleanData,
                href: linkData.href,
                text: linkData.text,
                reason: linkData.reason,
                submissionTime: linkData.submissionTime
            };

            if (includeRawNuxtScript) {
                proposalData.nuxtScript = nuxtScript;
            }
            
            // Add to local storage
            const storageUpdate = await chrome.storage.local.get('proposals');
            const proposals = storageUpdate.proposals || [];
            proposals.push(proposalData);
            try {
                await chrome.storage.local.set({ proposals });
                if (proposalData.nuxtScript) {
                    debugLog(
                        `[Proposal] ${linkData.href}: saved with nuxtScript + cleaned nuxtData ` +
                        `(sections=${Object.keys(cleanData || {}).join(',') || 'none'}).`
                    );
                } else {
                    debugLog(
                        `[Proposal] ${linkData.href}: saved with cleaned nuxtData only ` +
                        `(sections=${Object.keys(cleanData || {}).join(',') || 'none'}).`
                    );
                }
            } catch (storageError) {
                const hasRawScript = !!proposalData.nuxtScript;
                if (hasRawScript) {
                    // Raw Nuxt script can be large; retry without it first.
                    debugLog(
                        `[Proposal] ${linkData.href}: storage write failed with full nuxtScript (${storageError?.message || 'unknown error'}). ` +
                        'Retrying without nuxtScript.'
                    );
                    const withoutScriptData = { ...proposalData, nuxtScript: null };
                    proposals[proposals.length - 1] = withoutScriptData;
                    try {
                        await chrome.storage.local.set({ proposals });
                        proposalData.nuxtScript = null;
                        debugLog(
                            `[Proposal] ${linkData.href}: saved without nuxtScript, kept nuxtData ` +
                            `(sections=${Object.keys(cleanData || {}).join(',') || 'none'}).`
                        );
                    } catch (secondaryStorageError) {
                        debugLog(
                            `[Proposal] ${linkData.href}: storage write still failed without nuxtScript ` +
                            `(${secondaryStorageError?.message || 'unknown error'}). Retrying with compact payload.`
                        );
                        const minimalProposalData = { ...withoutScriptData };
                        if (minimalProposalData.proposal) {
                            delete minimalProposalData.proposal.screeningAnswers;
                        }
                        if (minimalProposalData.jobPost) {
                            delete minimalProposalData.jobPost.jobPrompt;
                        }
                        proposals[proposals.length - 1] = minimalProposalData;
                        await chrome.storage.local.set({ proposals });
                        proposalData.nuxtScript = null;
                        if (proposalData.proposal) {
                            delete proposalData.proposal.screeningAnswers;
                        }
                        if (proposalData.jobPost) {
                            delete proposalData.jobPost.jobPrompt;
                        }
                        debugLog(`[Proposal] ${linkData.href}: saved without nuxtScript using compact payload.`);
                    }
                } else {
                    debugLog(
                        `[Proposal] ${linkData.href}: storage write failed with cleaned payload ` +
                        `(${storageError?.message || 'unknown error'}). Retrying with compact payload.`
                    );
                    const minimalProposalData = { ...proposalData };
                    if (minimalProposalData.proposal) {
                        delete minimalProposalData.proposal.screeningAnswers;
                    }
                    if (minimalProposalData.jobPost) {
                        delete minimalProposalData.jobPost.jobPrompt;
                    }
                    proposals[proposals.length - 1] = minimalProposalData;
                    await chrome.storage.local.set({ proposals });
                    if (proposalData.proposal) {
                        delete proposalData.proposal.screeningAnswers;
                    }
                    if (proposalData.jobPost) {
                        delete proposalData.jobPost.jobPrompt;
                    }
                    debugLog(`[Proposal] ${linkData.href}: saved using compact payload.`);
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
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

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

        updateStatus({ action: 'All done! Closing in 3 seconds...' });
        debugLog('Finished processing all proposals');
        setTimeout(() => {
            statusPopup.remove();
        }, 3000);

    } catch (error) {
        updateStatus({ action: `Error: ${error.message}` });
        console.error('Scraping error:', error);
        setTimeout(() => {
            statusPopup.remove();
        }, 5000);
    }

    return allLinks;
} 
