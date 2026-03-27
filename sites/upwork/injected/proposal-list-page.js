(() => {
    if (globalThis.ProposalCopycatProposalListPageModule) {
        return;
    }

    const GRAPHQL_PROPOSALS_ALIAS = 'gql-query-proposalsbytype';
    const NETWORK_MONITOR_SOURCE = 'proposal-copycat-network-monitor';
    const NETWORK_MONITOR_RESPONSE_TYPE = 'graphql-response';
    const NETWORK_RESPONSE_WAIT_TIMEOUT_MS = 4000;

    const createProposalListPageScraper = (deps = {}) => {
        const debugLog = typeof deps.debugLog === 'function' ? deps.debugLog : () => {};
        const updateStatus = typeof deps.updateStatus === 'function' ? deps.updateStatus : () => {};
        const scrapeMode = deps?.scrapeMode === 'all' ? 'all' : 'successful';
        const isDebuggerListCaptureMode = deps?.isDebuggerListCaptureMode === true;
        const useNetworkMonitor = deps?.useNetworkMonitor === true;
        const existingUrls = deps?.existingUrls instanceof Set ? deps.existingUrls : new Set();
        const existingDetailedUrls = deps?.existingDetailedUrls instanceof Set ? deps.existingDetailedUrls : new Set();
        const existingProposalList = Array.isArray(deps?.existingProposalList) ? deps.existingProposalList : [];

        const interceptedProposalResponses = [];
        const pendingInterceptedResponseWaiters = [];
        let pendingInterceptedPageData = null;
        let networkBridgeInstalled = false;
        const networkDebugStats = {
            received: 0,
            targetClassified: 0,
            fallbackRecovered: 0,
            parseFailed: 0,
            droppedNoSignal: 0
        };
        let lastNetworkEventSummary = null;

        const parsePositiveInteger = (value) => {
            const parsed = Number.parseInt(String(value || ''), 10);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
        };

        const parseNonNegativeInteger = (value) => {
            const parsed = Number.parseInt(String(value || ''), 10);
            return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
        };

        const getElementLabel = (element) => {
            const labelledBy = (element.getAttribute('aria-labelledby') || '')
                .split(/\s+/)
                .filter(Boolean)
                .map((id) => document.getElementById(id)?.textContent || '')
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

            return String(reason || '').trim().toLowerCase() === 'hired';
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

        const parseSubmissionTimestamp = (value) => {
            if (value === undefined || value === null || value === '') {
                return null;
            }

            if (typeof value === 'number' && Number.isFinite(value)) {
                if (value > 1e12) {
                    return Math.floor(value);
                }

                if (value > 0) {
                    return Math.floor(value * 1000);
                }

                return null;
            }

            const asString = String(value).trim();
            if (!asString) {
                return null;
            }

            if (/^\d+(\.\d+)?$/.test(asString)) {
                const numericValue = Number(asString);
                if (Number.isFinite(numericValue)) {
                    if (numericValue > 1e12) {
                        return Math.floor(numericValue);
                    }
                    if (numericValue > 0) {
                        return Math.floor(numericValue * 1000);
                    }
                }
            }

            const parsedDate = Date.parse(asString);
            if (Number.isFinite(parsedDate)) {
                return parsedDate;
            }

            return null;
        };

        const pickFirstString = (...values) => {
            for (const value of values) {
                if (typeof value === 'string' && value.trim()) {
                    return value.trim();
                }
            }
            return '';
        };

        const toAbsoluteUrl = (value) => {
            const raw = String(value || '').trim();
            if (!raw) {
                return '';
            }

            try {
                return new URL(raw, window.location.origin).href;
            } catch (error) {
                return '';
            }
        };

        const normalizeProposalReason = (candidate) => {
            if (!candidate || typeof candidate !== 'object') {
                return '';
            }

            if (candidate.hired === true || candidate.isHired === true || candidate.wasHired === true) {
                return 'Hired';
            }

            const rawReason = pickFirstString(
                candidate.reason,
                candidate.archiveReason,
                candidate.archiveReason?.reason,
                candidate.archivedReason,
                candidate.archiveStatus,
                candidate.status,
                candidate.applicationStatus,
                candidate.result,
                candidate.state,
                candidate.declineReason?.reason,
                candidate.withdrawReason?.reason,
                candidate.proposal?.reason,
                candidate.proposal?.status
            );

            if (!rawReason) {
                return '';
            }

            const normalized = rawReason.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
            if (/hired/i.test(normalized)) {
                return 'Hired';
            }

            return normalized;
        };

        const collectObjectNodes = (root) => {
            const result = [];
            const stack = [root];
            const seen = new WeakSet();

            while (stack.length > 0) {
                const current = stack.pop();
                if (!current || typeof current !== 'object') {
                    continue;
                }

                if (seen.has(current)) {
                    continue;
                }
                seen.add(current);
                result.push(current);

                if (Array.isArray(current)) {
                    for (const item of current) {
                        if (item && typeof item === 'object') {
                            stack.push(item);
                        }
                    }
                    continue;
                }

                for (const value of Object.values(current)) {
                    if (value && typeof value === 'object') {
                        stack.push(value);
                    }
                }
            }

            return result;
        };

        const parseInterceptedProposalsResponse = (
            responseText,
            requestUrl = '',
            capturedAtMs = Date.now(),
            requestStartedAtMs = Date.now()
        ) => {
            if (typeof responseText !== 'string' || !responseText.trim()) {
                return null;
            }

            let parsedResponse;
            try {
                const normalizedResponseText = String(responseText || '')
                    .replace(/^\)\]\}'\s*/, '')
                    .trim();
                parsedResponse = JSON.parse(normalizedResponseText);
            } catch (error) {
                const preview = String(responseText || '')
                    .replace(/\s+/g, ' ')
                    .slice(0, 160);
                debugLog(
                    `[Network] Failed to parse proposals GraphQL JSON (${requestUrl || 'unknown-url'}). ` +
                    `Preview="${preview || '<empty>'}"`
                );
                return null;
            }

            const objectNodes = collectObjectNodes(parsedResponse);
            const links = [];
            const seenLinks = new Set();

            for (const node of objectNodes) {
                if (!node || typeof node !== 'object' || Array.isArray(node)) {
                    continue;
                }

                let href = toAbsoluteUrl(pickFirstString(
                    node.proposalUrl,
                    node.proposalURL,
                    node.href,
                    node.url,
                    node.link,
                    node.proposal?.proposalUrl,
                    node.proposal?.url,
                    node.application?.proposalUrl,
                    node.application?.url
                ));

                if (!href) {
                    const ciphertext = pickFirstString(
                        node.proposalCiphertext,
                        node.applicationCiphertext,
                        node.ciphertext,
                        node.proposal?.ciphertext,
                        node.application?.ciphertext
                    );

                    if (ciphertext) {
                        href = toAbsoluteUrl(`/ab/proposals/${ciphertext}`);
                    }
                }

                if (!href) {
                    const applicationId = pickFirstString(
                        node.applicationId,
                        node.proposalId,
                        node.id,
                        node.application?.applicationId,
                        node.proposal?.applicationId
                    );
                    if (applicationId && /^\d+$/.test(applicationId)) {
                        href = toAbsoluteUrl(`/nx/proposals/${applicationId}`);
                    }
                }

                if (!href || !/upwork\.com/i.test(href) || !/\/proposals\//i.test(href)) {
                    continue;
                }

                if (seenLinks.has(href) || existingUrls.has(href)) {
                    continue;
                }

                const reason = normalizeProposalReason(node);
                if (!isReasonAllowed(reason)) {
                    continue;
                }

                const submissionTime = parseSubmissionTimestamp(
                    node.submittedOn ??
                    node.submittedAt ??
                    node.submissionTime ??
                    node.createdAt ??
                    node.createdOn ??
                    node.createdDate ??
                    node.proposal?.submittedOn ??
                    node.proposal?.submittedAt ??
                    node.application?.submittedOn ??
                    node.application?.submittedAt
                );

                const title = pickFirstString(
                    node.title,
                    node.jobTitle,
                    node.proposalTitle,
                    node.job?.title,
                    node.opening?.title,
                    node.jobPost?.title,
                    node.proposal?.title
                ) || 'Untitled Proposal';

                seenLinks.add(href);
                links.push({
                    href,
                    text: title,
                    reason: reason || 'Unknown',
                    submissionTime
                });
            }

            let currentPage = '';
            let totalPages = '';

            for (const node of objectNodes) {
                if (!node || typeof node !== 'object' || Array.isArray(node)) {
                    continue;
                }

                const directCurrentPage = parsePositiveInteger(
                    node.currentPage ??
                    node.pageNumber ??
                    node.page ??
                    node.current
                );
                if (!currentPage && directCurrentPage) {
                    currentPage = String(directCurrentPage);
                }

                const directTotalPages = parsePositiveInteger(
                    node.totalPages ??
                    node.totalPageCount ??
                    node.pageCount ??
                    node.pages
                );
                if (!totalPages && directTotalPages) {
                    totalPages = String(directTotalPages);
                }

                if (!currentPage || !totalPages) {
                    const totalCount = parsePositiveInteger(
                        node.totalCount ??
                        node.total ??
                        node.count ??
                        node.totalResults
                    );
                    const pageSize = parsePositiveInteger(
                        node.pageSize ??
                        node.perPage ??
                        node.limit ??
                        node.pageLimit
                    );
                    const offset = parseNonNegativeInteger(node.offset ?? node.start ?? node.skip);

                    if (!currentPage && pageSize && offset !== null) {
                        currentPage = String(Math.floor(offset / pageSize) + 1);
                    }

                    if (!totalPages && totalCount && pageSize) {
                        totalPages = String(Math.ceil(totalCount / pageSize));
                    }
                }

                if (currentPage && totalPages) {
                    break;
                }
            }

            return {
                links,
                currentPage,
                totalPages,
                capturedAtMs,
                requestStartedAtMs
            };
        };

        const takeMatchingInterceptedProposalResponse = (minRequestStartedAtMs = 0) => {
            const matchIndex = interceptedProposalResponses.findIndex((entry) => {
                const entryTime = Number(entry?.requestStartedAtMs) || Number(entry?.capturedAtMs) || 0;
                return entryTime >= minRequestStartedAtMs;
            });

            if (matchIndex < 0) {
                return null;
            }

            const [match] = interceptedProposalResponses.splice(matchIndex, 1);
            return match || null;
        };

        const flushPendingInterceptedResponseWaiters = () => {
            for (let index = 0; index < pendingInterceptedResponseWaiters.length; index += 1) {
                const waiter = pendingInterceptedResponseWaiters[index];
                const match = takeMatchingInterceptedProposalResponse(waiter.minRequestStartedAtMs);
                if (!match) {
                    continue;
                }

                clearTimeout(waiter.timeoutId);
                pendingInterceptedResponseWaiters.splice(index, 1);
                index -= 1;
                waiter.resolve(match);
            }
        };

        const waitForNextInterceptedProposalResponse = (options = {}) => {
            const minRequestStartedAtMs = Number(options.minRequestStartedAtMs) || 0;
            const timeoutMs = Number(options.timeoutMs) || NETWORK_RESPONSE_WAIT_TIMEOUT_MS;
            const immediateMatch = takeMatchingInterceptedProposalResponse(minRequestStartedAtMs);
            if (immediateMatch) {
                return Promise.resolve(immediateMatch);
            }

            return new Promise((resolve) => {
                const waiter = {
                    resolve,
                    minRequestStartedAtMs,
                    timeoutId: null
                };

                waiter.timeoutId = setTimeout(() => {
                    const waiterIndex = pendingInterceptedResponseWaiters.indexOf(waiter);
                    if (waiterIndex >= 0) {
                        pendingInterceptedResponseWaiters.splice(waiterIndex, 1);
                    }
                    resolve(null);
                }, timeoutMs);

                pendingInterceptedResponseWaiters.push(waiter);
            });
        };

        const mergeTableAndInterceptedData = (tableResult, interceptedResult) => {
            if (!tableResult || !interceptedResult) {
                return tableResult;
            }

            const interceptedLinks = Array.isArray(interceptedResult.links)
                ? interceptedResult.links
                : [];
            const shouldUseInterceptedLinks = interceptedLinks.length > 0 || tableResult.links.length === 0;

            if (!shouldUseInterceptedLinks) {
                debugLog(
                    `[Network] Intercepted response had 0 eligible links; falling back to DOM rows for ` +
                    `page ${tableResult.currentPage || '?'}.`
                );
                return {
                    ...tableResult,
                    currentPage: interceptedResult.currentPage || tableResult.currentPage,
                    totalPages: interceptedResult.totalPages || tableResult.totalPages
                };
            }

            debugLog(
                `[Network] Using intercepted proposals response for page ${interceptedResult.currentPage || tableResult.currentPage || '?'} ` +
                `with ${interceptedLinks.length} eligible links.`
            );
            return {
                ...tableResult,
                links: interceptedLinks,
                currentPage: interceptedResult.currentPage || tableResult.currentPage,
                totalPages: interceptedResult.totalPages || tableResult.totalPages
            };
        };

        const networkMessageHandler = (event) => {
            const data = event?.data;
            if (
                !data ||
                data.source !== NETWORK_MONITOR_SOURCE ||
                data.type !== NETWORK_MONITOR_RESPONSE_TYPE ||
                event.source !== window
            ) {
                return;
            }

            const payload = data.payload || {};
            const requestUrl = String(payload.url || '');
            const isClassifiedTarget = payload?.isTargetOperation === true || requestUrl.includes(GRAPHQL_PROPOSALS_ALIAS);
            networkDebugStats.received += 1;
            if (isClassifiedTarget) {
                networkDebugStats.targetClassified += 1;
            }
            const eventSeq = Number(payload?.monitorSeq) || networkDebugStats.received;
            const responseTextLen = Number(payload?.responseTextLength) || String(payload?.responseText || '').length || 0;
            lastNetworkEventSummary = {
                seq: eventSeq,
                transport: String(payload?.transport || 'unknown'),
                path: String(payload?.path || ''),
                status: Number(payload?.status) || 0,
                len: responseTextLen,
                target: isClassifiedTarget,
                match: String(payload?.matchReason || 'none')
            };
            if (eventSeq <= 8 || eventSeq % 20 === 0) {
                debugLog(
                    `[Network] Monitor event#${eventSeq} transport=${lastNetworkEventSummary.transport} ` +
                    `path=${lastNetworkEventSummary.path || '?'} status=${lastNetworkEventSummary.status || '?'} ` +
                    `len=${lastNetworkEventSummary.len} target=${isClassifiedTarget ? 'yes' : 'no'} ` +
                    `match=${lastNetworkEventSummary.match} ` +
                    `req="${String(payload?.requestBodySnippet || '').replace(/\s+/g, ' ').slice(0, 90)}" ` +
                    `res="${String(payload?.responsePreview || '').replace(/\s+/g, ' ').slice(0, 90)}"`
                );
            }

            const responseText = String(payload.responseText || '');
            const responseLower = responseText.toLowerCase();
            const responseHasProposalSignal = (
                responseLower.includes('/nx/proposals/') ||
                responseLower.includes('proposalurl') ||
                responseLower.includes('proposalciphertext') ||
                responseLower.includes('proposalsbytype')
            );
            const shouldAttemptParsing = isClassifiedTarget || responseHasProposalSignal;
            if (!shouldAttemptParsing) {
                networkDebugStats.droppedNoSignal += 1;
                if (networkDebugStats.droppedNoSignal <= 3 || networkDebugStats.droppedNoSignal % 20 === 0) {
                    debugLog(
                        `[Network] Monitor event skipped before parse (no target signal). ` +
                        `match=${payload?.matchReason || 'none'}, drop=${payload?.dropReason || 'n/a'}, ` +
                        `url=${requestUrl || 'unknown-url'}, len=${Number(payload?.responseTextLength) || responseText.length || 0}`
                    );
                }
                return;
            }

            const parsedResponse = parseInterceptedProposalsResponse(
                responseText,
                requestUrl,
                Number(payload.capturedAtMs) || Date.now(),
                Number(payload.requestStartedAtMs) || Number(payload.capturedAtMs) || Date.now()
            );

            if (!parsedResponse) {
                networkDebugStats.parseFailed += 1;
                if (networkDebugStats.parseFailed <= 3 || networkDebugStats.parseFailed % 20 === 0) {
                    debugLog(
                        `[Network] Ignored monitor event (parse failed). ` +
                        `classifiedTarget=${isClassifiedTarget}, match=${payload?.matchReason || 'none'}, ` +
                        `drop=${payload?.dropReason || 'n/a'}, url=${requestUrl || 'unknown-url'}, ` +
                        `len=${Number(payload?.responseTextLength) || 0}`
                    );
                }
                return;
            }

            const hasSignal = (
                (Array.isArray(parsedResponse.links) && parsedResponse.links.length > 0) ||
                !!parsedResponse.currentPage ||
                !!parsedResponse.totalPages
            );
            if (!hasSignal) {
                networkDebugStats.droppedNoSignal += 1;
                if (networkDebugStats.droppedNoSignal <= 3 || networkDebugStats.droppedNoSignal % 20 === 0) {
                    debugLog(
                        `[Network] Parsed monitor event but found no proposal signal. ` +
                        `classifiedTarget=${isClassifiedTarget}, match=${payload?.matchReason || 'none'}, ` +
                        `url=${requestUrl || 'unknown-url'}`
                    );
                }
                return;
            }

            if (!isClassifiedTarget) {
                networkDebugStats.fallbackRecovered += 1;
                debugLog(
                    `[Network] Recovered target response via fallback parsing. ` +
                    `match=${payload?.matchReason || 'none'}, drop=${payload?.dropReason || 'n/a'}, ` +
                    `url=${requestUrl || 'unknown-url'}`
                );
            }

            interceptedProposalResponses.push(parsedResponse);
            flushPendingInterceptedResponseWaiters();
            debugLog(
                `[Network] Intercepted proposals GraphQL response. ` +
                `Eligible links=${parsedResponse.links.length}, page=${parsedResponse.currentPage || '?'}/${parsedResponse.totalPages || '?'}, ` +
                `match=${payload?.matchReason || 'unknown'}, stats=` +
                `${networkDebugStats.received}/${networkDebugStats.targetClassified}/${networkDebugStats.fallbackRecovered}/` +
                `${networkDebugStats.parseFailed}/${networkDebugStats.droppedNoSignal}`
            );
        };

        const installNetworkBridge = () => {
            if (!useNetworkMonitor || networkBridgeInstalled) {
                return;
            }

            window.addEventListener('message', networkMessageHandler);
            networkBridgeInstalled = true;
        };

        const teardownNetworkBridge = () => {
            if (networkBridgeInstalled) {
                window.removeEventListener('message', networkMessageHandler);
                networkBridgeInstalled = false;
            }

            interceptedProposalResponses.length = 0;
            pendingInterceptedPageData = null;

            for (const waiter of pendingInterceptedResponseWaiters) {
                clearTimeout(waiter.timeoutId);
                waiter.resolve(null);
            }
            pendingInterceptedResponseWaiters.length = 0;
        };

        const mergeCurrentPageResult = (tableResult) => {
            if (!tableResult || isDebuggerListCaptureMode) {
                pendingInterceptedPageData = null;
                return tableResult;
            }

            const merged = mergeTableAndInterceptedData(tableResult, pendingInterceptedPageData);
            pendingInterceptedPageData = null;
            return merged;
        };

        const rememberInterceptedResponse = (interceptedResponse) => {
            pendingInterceptedPageData = interceptedResponse || null;
        };

        const getNetworkDebugSnapshot = () => ({
            stats: { ...networkDebugStats },
            lastEventSummary: lastNetworkEventSummary ? { ...lastNetworkEventSummary } : null
        });

        const scrapeCurrentPage = () => {
            const allDivs = document.querySelectorAll('div[data-qa="card-archived-proposals"]');
            const proposalsDiv = Array.from(allDivs).find((div) => {
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
                .map((a) => a.href)
                .join('|');

            const links = isDebuggerListCaptureMode
                ? []
                : Array.from(table.querySelectorAll('tr')).map((row) => {
                    const reasonCell = row.querySelector('td[data-qa="reason-slot"]');
                    const link = row.querySelector('a[href]');
                    if (!reasonCell || !link) return null;

                    const reason = reasonCell.textContent.trim();
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
                let settled = false;
                let timeoutId = null;
                const settle = (value) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearInterval(checkInterval);
                    clearTimeout(timeoutId);
                    resolve(value);
                };

                const checkInterval = setInterval(() => {
                    const result = scrapeCurrentPage();
                    if (result) {
                        debugLog(
                            `Table loaded. Page ${result.currentPage || '?'} of ${result.totalPages || '?'}. ` +
                            `${isDebuggerListCaptureMode ? 'Eligible links: n/a (debugger capture mode)' : `Eligible links: ${result.links.length}`}`
                        );
                        settle(result);
                    }
                }, 1000);

                timeoutId = setTimeout(() => {
                    debugLog('Timed out waiting for archived proposals table.');
                    settle(null);
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

        const findPrevPageButton = (proposalsDiv) => (
            proposalsDiv?.querySelector('button[data-test="prev-page"], a[data-test="prev-page"], button[data-ev-label="pagination_prev_page"], a[data-ev-label="pagination_prev_page"]') ||
            document.querySelector('button[data-test="prev-page"], a[data-test="prev-page"], button[data-ev-label="pagination_prev_page"], a[data-ev-label="pagination_prev_page"]')
        );

        const warmupDebuggerCaptureForFirstPage = async (initialState) => {
            if (!isDebuggerListCaptureMode || !initialState) {
                return false;
            }

            const currentPageNumber = Number.parseInt(String(initialState.currentPage || ''), 10);
            if (!Number.isFinite(currentPageNumber) || currentPageNumber !== 1) {
                return false;
            }

            if (!initialState.nextButton || initialState.isNextDisabled) {
                debugLog('[Warmup] Skipping first-page replay: next-page control unavailable on page 1.');
                return false;
            }

            debugLog('[Warmup] Replaying page 1 via page 2 -> page 1 to force GraphQL capture.');

            initialState.nextButton.click();
            const movedForward = await waitForNextPageLoad(initialState.currentPage, initialState.tableSignature);
            if (!movedForward) {
                debugLog('[Warmup] Could not detect move to page 2; continuing without replay.');
                return false;
            }

            await new Promise((resolve) => setTimeout(resolve, 800));

            const prevButton = findPrevPageButton(movedForward.proposalsDiv);
            if (!prevButton || isElementDisabled(prevButton)) {
                debugLog('[Warmup] Could not find enabled previous-page control on page 2.');
                return false;
            }

            prevButton.click();
            const movedBack = await waitForNextPageLoad(movedForward.currentPage, movedForward.tableSignature);
            if (!movedBack) {
                debugLog('[Warmup] Could not detect move back to page 1; continuing from current page.');
                return false;
            }

            await new Promise((resolve) => setTimeout(resolve, 600));
            debugLog('[Warmup] First-page replay complete. Starting normal pagination.');
            return true;
        };

        const getLinksFromStoredProposalList = () => {
            const seen = new Set();
            const links = [];

            for (const entry of existingProposalList) {
                const href = String(entry?.href || '').trim();
                if (!href) {
                    continue;
                }
                if (seen.has(href)) {
                    continue;
                }
                seen.add(href);

                const reason = String(entry?.reason || '').trim();
                if (!isReasonAllowed(reason)) {
                    continue;
                }
                if (existingDetailedUrls.has(href)) {
                    continue;
                }

                links.push({
                    href,
                    text: String(entry?.text || '').trim(),
                    reason,
                    submissionTime: parseSubmissionTimestamp(entry?.submissionTime)
                });
            }

            return links;
        };

        const upsertArchivedProposalListEntries = async (entries, sourceLabel = 'run') => {
            const normalizedEntries = Array.isArray(entries) ? entries : [];
            if (!normalizedEntries.length) {
                return null;
            }

            const storageUpdate = await chrome.storage.local.get('proposalList');
            const proposalList = Array.isArray(storageUpdate.proposalList) ? storageUpdate.proposalList : [];
            const listByHref = new Map();

            for (const entry of proposalList) {
                const href = String(entry?.href || '').trim();
                if (href) {
                    listByHref.set(href, entry);
                }
            }

            const scrapedAtIso = new Date().toISOString();
            let upsertedCount = 0;
            for (const link of normalizedEntries) {
                const href = String(link?.href || '').trim();
                if (!href) {
                    continue;
                }

                const previous = listByHref.get(href) || {};
                listByHref.set(href, {
                    ...previous,
                    href,
                    text: link?.text || previous.text || '',
                    reason: link?.reason || previous.reason || '',
                    submissionTime: link?.submissionTime ?? previous.submissionTime ?? null,
                    scrapedAt: scrapedAtIso
                });
                upsertedCount += 1;
            }

            await chrome.storage.local.set({ proposalList: Array.from(listByHref.values()) });
            debugLog(
                `[List] Upserted ${upsertedCount} entries from ${sourceLabel}. ` +
                `Total list size: ${listByHref.size}.`
            );

            return {
                upsertedCount,
                totalSize: listByHref.size
            };
        };

        return {
            isReasonAllowed,
            parseSubmissionTimestamp,
            installNetworkBridge,
            teardownNetworkBridge,
            waitForNextInterceptedProposalResponse,
            mergeCurrentPageResult,
            rememberInterceptedResponse,
            getNetworkDebugSnapshot,
            scrapeCurrentPage,
            waitForTable,
            waitForNextPageLoad,
            warmupDebuggerCaptureForFirstPage,
            getLinksFromStoredProposalList,
            upsertArchivedProposalListEntries
        };
    };

    globalThis.ProposalCopycatProposalListPageModule = {
        createProposalListPageScraper
    };
})();
