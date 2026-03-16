async function scrapeProposals(options = {}) {
    if (document.getElementById('proposal-copycat-status-popup')) {
        return;
    }

    const scrapeMode = options?.scrapeMode === 'all' ? 'all' : 'successful';
    const scrapeCurrentJobPost = options?.scrapeCurrentJobPost === true;
    const scrapeJobPostsFromSavedList = options?.scrapeJobPostsFromSavedList === true;
    const scrapeArchivedListOnly = options?.scrapeArchivedListOnly === true;
    const scrapeProposalDetailsFromList = options?.scrapeProposalDetailsFromList === true;
    const useDebuggerProposalListCapture = options?.useDebuggerProposalListCapture === true;
    const disableNetworkMonitor = options?.disableNetworkMonitor === true;
    const includeRawNuxtScript = options?.includeRawNuxtScript === true;
    const scrapeDetailsFromSavedList = (
        scrapeProposalDetailsFromList &&
        !scrapeArchivedListOnly &&
        !scrapeCurrentJobPost &&
        !scrapeJobPostsFromSavedList
    );
    const isDebuggerListCaptureMode = scrapeArchivedListOnly && useDebuggerProposalListCapture;
    const useNetworkMonitor = !disableNetworkMonitor;
    const statusTitle = scrapeCurrentJobPost
        ? 'Collecting Job Post'
        : (scrapeJobPostsFromSavedList
            ? 'Collecting Job Posts'
        : (scrapeArchivedListOnly
            ? 'Collecting Proposal List'
            : (scrapeDetailsFromSavedList
                ? 'Collecting Proposal Details'
                : (scrapeMode === 'all' ? 'Collecting Proposals' : 'Collecting Successful Proposals'))));
    const modeBadgeText = scrapeCurrentJobPost
        ? 'Current Job Page'
        : (scrapeJobPostsFromSavedList
            ? (scrapeMode === 'all' ? 'Job Posts From Saved Details: All Proposals' : 'Job Posts From Saved Details: Successful Only')
        : (scrapeArchivedListOnly
            ? (scrapeMode === 'all' ? 'Archived List: All Proposals' : 'Archived List: Successful Only')
            : (scrapeDetailsFromSavedList
                ? (scrapeMode === 'all' ? 'Details From Saved List: All Proposals' : 'Details From Saved List: Successful Only')
                : (scrapeMode === 'all' ? 'All Proposals' : 'Successful Only'))));
    const modeSummaryText = scrapeMode === 'all' ? 'all proposals' : 'successful proposals';

    // Get existing proposals from storage
    const storageData = await chrome.storage.local.get(['proposals', 'proposalList']);
    const existingProposals = storageData.proposals || [];
    const existingProposalList = Array.isArray(storageData.proposalList) ? storageData.proposalList : [];
    const initialProposalListCount = existingProposalList.length;
    const extractProposalUrl = (proposal) => (
        proposal?.proposalDetailsPage?.data?.proposal?.proposalUrl ||
        proposal?.proposal?.proposalUrl ||
        proposal?.proposalListPage?.href ||
        proposal?.href ||
        proposal?.url
    );
    const normalizeJobPostHref = (value) => {
        const raw = String(value || '').trim();
        if (!raw) {
            return '';
        }
        if (/^https?:\/\//i.test(raw)) {
            return raw;
        }
        if (/^\/jobs\//i.test(raw)) {
            return `https://www.upwork.com${raw}`;
        }
        if (/^~0\d+/.test(raw)) {
            return `https://www.upwork.com/jobs/${raw}`;
        }
        return '';
    };
    const deriveCiphertextFromOpeningId = (value) => {
        const raw = String(value || '').trim();
        if (!/^\d{8,}$/.test(raw)) {
            return '';
        }
        return `~02${raw}`;
    };
    const collectJobPostHrefCandidatesFromRawGraphql = (rawGraphql) => {
        const details = rawGraphql?.jobAuthDetails || rawGraphql || {};
        const opening = details?.opening || {};
        const jobDetails = details?.jobDetails || {};
        const jobDetailsOpening = jobDetails?.opening || {};
        const openingJob = opening?.job || jobDetailsOpening?.job || jobDetails?.job || {};
        const openingInfo = opening?.info || openingJob?.info || jobDetailsOpening?.info || {};
        const jobInfo = openingJob?.info || {};

        const openingIdCandidates = [
            opening?.id,
            opening?.openingId,
            opening?.openingUid,
            openingInfo?.id,
            openingJob?.id,
            openingJob?.uid,
            openingJob?.openingId,
            openingJob?.openingUid,
            jobInfo?.id,
            details?.openingId,
            details?.openingUid,
            jobDetailsOpening?.id,
            jobDetailsOpening?.openingId,
            jobDetailsOpening?.openingUid
        ]
            .map((idValue) => deriveCiphertextFromOpeningId(idValue))
            .filter(Boolean);

        // All candidates are tied to this proposal's opening details.
        return [
            opening?.url,
            opening?.jobPostUrl,
            opening?.canonicalUrl,
            openingInfo?.url,
            openingJob?.url,
            jobInfo?.url,
            opening?.ciphertext,
            opening?.jobCiphertext,
            openingInfo?.ciphertext,
            openingJob?.ciphertext,
            jobInfo?.ciphertext,
            jobDetailsOpening?.ciphertext,
            jobDetailsOpening?.jobCiphertext,
            ...openingIdCandidates
        ];
    };
    const extractJobPostUrlFromRawGraphql = (rawGraphql) => {
        const candidates = collectJobPostHrefCandidatesFromRawGraphql(rawGraphql);
        for (const candidate of candidates) {
            const normalized = normalizeJobPostHref(candidate);
            if (normalized) {
                return normalized;
            }
        }
        return '';
    };
    const extractJobPostUrlFromProposal = (proposal) => (
        extractJobPostUrlFromRawGraphql(proposal?.proposalDetailsPage?.rawGraphql) ||
        normalizeJobPostHref(
            proposal?.jobPostPage?.url ||
            proposal?.proposalDetailsPage?.jobPostHref ||
            proposal?.proposalDetailsPage?.data?.jobPost?.url
        )
    );
    const extractJobPostDataFallbackFromProposal = (proposal, fallbackJobUrl = '') => {
        const existingDetailsData = proposal?.proposalDetailsPage?.data;
        if (existingDetailsData && typeof existingDetailsData === 'object') {
            const existingJobPost = existingDetailsData.jobPost;
            if (existingJobPost && typeof existingJobPost === 'object' && Object.keys(existingJobPost).length > 0) {
                const clonedData = JSON.parse(JSON.stringify(existingDetailsData));
                if (!clonedData?.jobPost?.url) {
                    const fallbackUrl = normalizeJobPostHref(fallbackJobUrl || proposal?.jobPostPage?.url || '');
                    if (fallbackUrl) {
                        clonedData.jobPost = {
                            ...clonedData.jobPost,
                            url: fallbackUrl
                        };
                    }
                }
                return clonedData;
            }
        }

        const rawGraphql = proposal?.proposalDetailsPage?.rawGraphql;
        const details = rawGraphql?.jobAuthDetails || rawGraphql || {};
        if (!details || typeof details !== 'object') {
            return null;
        }

        const jobDetails = details?.jobDetails || {};
        const opening = details?.opening || jobDetails?.opening || {};
        const openingInfo = opening?.info || jobDetails?.opening?.info || {};
        const openingJob = opening?.job || jobDetails?.opening?.job || jobDetails?.job || {};
        const buyer = details?.buyer || jobDetails?.buyer || {};
        const buyerInfo = buyer?.info || {};

        const jobPostUrl = (
            normalizeJobPostHref(
                opening?.url ||
                opening?.jobPostUrl ||
                opening?.canonicalUrl ||
                openingInfo?.url ||
                opening?.ciphertext ||
                opening?.jobCiphertext ||
                openingInfo?.ciphertext ||
                openingJob?.info?.url ||
                openingJob?.info?.ciphertext ||
                fallbackJobUrl ||
                proposal?.jobPostPage?.url
            ) ||
            ''
        );

        const budget = {};
        setIfPresent(budget, 'amount', openingJob?.budget?.amount);
        setIfPresent(budget, 'currency', openingJob?.budget?.currencyCode);
        setIfPresent(budget, 'hourlyMin', openingJob?.extendedBudgetInfo?.hourlyBudgetMin);
        setIfPresent(budget, 'hourlyMax', openingJob?.extendedBudgetInfo?.hourlyBudgetMax);

        const skills = []
            .concat((openingJob?.sandsData?.additionalSkills || []).map((item) => item?.prefLabel))
            .concat((openingJob?.sandsData?.ontologySkills || []).map((item) => item?.prefLabel))
            .filter(Boolean);

        const clientInfo = {};
        const clientLocation = {};
        setIfPresent(clientLocation, 'country', buyerInfo?.location?.country);
        setIfPresent(clientLocation, 'city', buyerInfo?.location?.city);
        setIfPresent(clientLocation, 'state', buyerInfo?.location?.state);
        setIfPresent(clientLocation, 'timezone', buyerInfo?.location?.countryTimezone);

        const clientStats = {};
        setIfPresent(clientStats, 'totalSpent', buyerInfo?.stats?.totalCharges?.amount);
        setIfPresent(clientStats, 'feedbackCount', buyerInfo?.stats?.feedbackCount);
        setIfPresent(clientStats, 'ratingScore', buyerInfo?.stats?.score);
        setIfPresent(clientStats, 'totalJobsWithHires', buyerInfo?.stats?.totalJobsWithHires);
        setIfPresent(clientStats, 'activeAssignments', buyerInfo?.stats?.activeAssignmentsCount);
        setIfPresent(clientStats, 'postedCount', buyerInfo?.jobs?.postedCount);

        setIfPresent(clientInfo, 'location', clientLocation);
        setIfPresent(clientInfo, 'stats', clientStats);
        setIfPresent(clientInfo, 'isPaymentMethodVerified', buyer?.isPaymentMethodVerified);
        setIfPresent(clientInfo, 'isEnterprise', buyer?.isEnterprise);

        const jobPost = {};
        setIfPresent(jobPost, 'url', jobPostUrl || null);
        setIfPresent(jobPost, 'title', openingInfo?.title || openingJob?.info?.title || proposal?.proposalListPage?.text);
        setIfPresent(jobPost, 'description', openingJob?.description || jobDetails?.jobDescription);
        setIfPresent(jobPost, 'postedOn', openingJob?.postedOn);
        setIfPresent(jobPost, 'category', openingJob?.category?.name);
        setIfPresent(jobPost, 'workload', openingJob?.workload);
        setIfPresent(jobPost, 'duration', openingJob?.engagementDuration?.label || openingJob?.engagementDuration);
        setIfPresent(jobPost, 'budget', budget);
        setIfPresent(jobPost, 'skills', skills);
        setIfPresent(
            jobPost,
            'clientActivity',
            openingJob?.clientActivity || null
        );
        setIfPresent(
            jobPost,
            'screeningQuestions',
            (jobDetails?.qualifications?.questions || []).map((item) => item?.question).filter(Boolean)
        );

        const cleanFallback = removeEmptySections({
            jobPost,
            clientInfo
        });

        return Object.keys(cleanFallback).length ? cleanFallback : null;
    };
    const existingDetailedUrls = new Set(
        existingProposals
            .map((proposal) => extractProposalUrl(proposal))
            .filter(Boolean)
    );
    const existingUrls = new Set(
        [...existingDetailedUrls, ...existingProposalList.map((proposal) => extractProposalUrl(proposal)).filter(Boolean)]
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
    const usesPagedListProgress = (
        !scrapeCurrentJobPost &&
        !scrapeJobPostsFromSavedList &&
        !scrapeDetailsFromSavedList
    );
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
    const parseNonNegativeInteger = (value) => {
        const parsed = Number.parseInt(String(value || ''), 10);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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
        const totalItemsOnRun = Number.isFinite(progressState.itemTotal) ? progressState.itemTotal : 0;

        let remainingItems = Math.max(totalItemsOnRun - currentItem, 0);
        if (usesPagedListProgress && currentPage && totalPages && totalPages >= currentPage) {
            const pagesRemaining = totalPages - currentPage;
            const averageItemsPerPage = runMetrics.completedPages > 0
                ? (runMetrics.observedItemsInPages / runMetrics.completedPages)
                : (totalItemsOnRun > 0 ? totalItemsOnRun : 0);

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

        const listProgressLabel = usesPagedListProgress ? 'List Progress' : 'Run Scope';
        const listProgressText = usesPagedListProgress
            ? (
                progressState.listCurrent
                    ? `Segment ${progressState.listCurrent}${progressState.listTotal ? ` of ${progressState.listTotal}` : ''}`
                    : 'Scanning list...'
            )
            : (
                scrapeCurrentJobPost
                    ? 'Active job page'
                    : (scrapeJobPostsFromSavedList
                        ? `${progressState.itemTotal || 0} saved targets`
                        : (scrapeDetailsFromSavedList
                            ? `${progressState.itemTotal || 0} saved proposals`
                            : 'Single run'))
            );

        const pageProgressText = progressState.itemTotal > 0
            ? `${progressState.itemCurrent}/${progressState.itemTotal}`
            : (usesPagedListProgress ? 'None in current segment' : 'Waiting...');
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
                    ">${listProgressLabel}</div>
                    <div style="font-size: 13px; color: #1a1f36; font-weight: 600;">
                        ${listProgressText}
                    </div>

                    <div style="
                        font-size: 11px;
                        color: #697386;
                        text-transform: uppercase;
                        letter-spacing: 0.4px;
                        font-weight: 600;
                    ">Item Progress</div>
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
    const GRAPHQL_PROPOSALS_ALIAS = 'gql-query-proposalsbytype';
    const NETWORK_MONITOR_SOURCE = 'proposal-copycat-network-monitor';
    const NETWORK_MONITOR_RESPONSE_TYPE = 'graphql-response';
    const NETWORK_RESPONSE_WAIT_TIMEOUT_MS = 4000;

    let sandboxFramePromise = null;
    let sandboxRequestCounter = 0;
    let sandboxBridgeState = 'unknown';
    const pendingSandboxRequests = new Map();
    const interceptedProposalResponses = [];
    const pendingInterceptedResponseWaiters = [];
    let pendingInterceptedPageData = null;
    const networkDebugStats = {
        received: 0,
        targetClassified: 0,
        fallbackRecovered: 0,
        parseFailed: 0,
        droppedNoSignal: 0
    };
    let lastNetworkEventSummary = null;

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

    debugLog(
        `Loaded ${existingProposals.length} detailed proposals and ${existingProposalList.length} list records from storage. ` +
        `Mode: ${scrapeMode}, listOnly: ${scrapeArchivedListOnly}, detailsFromList: ${scrapeDetailsFromSavedList}, ` +
        `jobPostsFromList: ${scrapeJobPostsFromSavedList}, ` +
        `debuggerListCapture: ${useDebuggerProposalListCapture}, networkMonitor: ${useNetworkMonitor}`
    );
    if (useNetworkMonitor) {
        debugLog(`[Network] Waiting for GraphQL responses with alias="${GRAPHQL_PROPOSALS_ALIAS}".`);
    }
    
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

    if (useNetworkMonitor) {
        window.addEventListener('message', networkMessageHandler);
    }

    const teardownNetworkBridge = () => {
        if (useNetworkMonitor) {
            window.removeEventListener('message', networkMessageHandler);
        }
        interceptedProposalResponses.length = 0;
        pendingInterceptedPageData = null;

        for (const waiter of pendingInterceptedResponseWaiters) {
            clearTimeout(waiter.timeoutId);
            waiter.resolve(null);
        }
        pendingInterceptedResponseWaiters.length = 0;
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
        
        // In debugger list-capture mode, list items are sourced from GraphQL responses.
        // Keep DOM usage limited to pagination state and table signatures.
        const links = isDebuggerListCaptureMode
            ? []
            : Array.from(table.querySelectorAll('tr')).map(row => {
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

    let fetchJobPostRawData = async () => null;
    let isJobPostPageUrl = () => false;
    if (scrapeCurrentJobPost || !scrapeArchivedListOnly) {
        const jobPostModule = globalThis.ProposalCopycatJobPostPageModule;
        if (!jobPostModule || typeof jobPostModule.createJobPostScraper !== 'function') {
            throw new Error('Job post scraper module is not available in page context.');
        }

        const jobPostScraper = jobPostModule.createJobPostScraper({
            debugLog,
            recordError,
            setIfPresent,
            removeEmptySections
        });
        fetchJobPostRawData = jobPostScraper.fetchJobPostRawData;
        isJobPostPageUrl = jobPostScraper.isJobPostPageUrl;
    }

    if (scrapeCurrentJobPost) {
        const currentPageUrl = window.location.href;

        try {
            updateStatus({
                action: 'Inspecting current job page...',
                listCurrent: '1',
                listTotal: '1',
                itemCurrent: 0,
                itemTotal: 1
            });

            if (!isJobPostPageUrl(currentPageUrl)) {
                updateStatus({
                    action: 'Current page is not an Upwork job post URL.',
                    listCurrent: '1',
                    listTotal: '1',
                    itemCurrent: 0,
                    itemTotal: 1
                });
                setTimeout(() => {
                    statusPopup.remove();
                }, 4500);
                return [];
            }

            const jobPostFetchResult = await fetchJobPostRawData(currentPageUrl, currentPageUrl);
            const jobPostData = jobPostFetchResult?.data || null;

            if (!jobPostData || Object.keys(jobPostData).length === 0) {
                updateStatus({
                    action: `Could not extract job post data${errorState.total > 0 ? ` (errors: ${errorState.total})` : ''}.`,
                    listCurrent: '1',
                    listTotal: '1',
                    itemCurrent: 1,
                    itemTotal: 1
                });
                setTimeout(() => {
                    statusPopup.remove();
                }, 5000);
                return [];
            }

            const normalizedJobUrl = jobPostData?.jobPost?.url || currentPageUrl;
            const jobPostRecord = {
                sourcePageUrl: currentPageUrl,
                scrapedAt: new Date().toISOString(),
                jobPostPage: {
                    url: normalizedJobUrl,
                    data: jobPostData
                }
            };

            await chrome.storage.local.set({ activeJobPost: [jobPostRecord] });

            updateStatus({
                action: `Active job post saved${errorState.total > 0 ? ` with ${errorState.total} tracked errors` : ''}. Closing in 3 seconds...`,
                listCurrent: '1',
                listTotal: '1',
                itemCurrent: 1,
                itemTotal: 1
            });
            setTimeout(() => {
                statusPopup.remove();
            }, 3000);

            return [jobPostRecord];
        } catch (error) {
            updateStatus({
                action: `Error: ${error.message}${errorState.total > 0 ? ` (tracked errors: ${errorState.total})` : ''}`
            });
            console.error('Current job post scraping error:', error);
            setTimeout(() => {
                statusPopup.remove();
            }, 5000);
            return [];
        } finally {
            teardownNetworkBridge();
            await teardownSandboxBridge();
        }
    }

    if (scrapeJobPostsFromSavedList) {
        try {
            const savedProposals = Array.isArray(storageData.proposals) ? storageData.proposals : [];
            const seenJobUrls = new Set();
            const jobTargets = [];
            let eligibleProposalCount = 0;
            let proposalsWithDerivedJobUrl = 0;

            for (const proposal of savedProposals) {
                const reason = String(proposal?.proposalListPage?.reason || '').trim();
                if (!isReasonAllowed(reason)) {
                    continue;
                }
                eligibleProposalCount += 1;

                const jobUrl = extractJobPostUrlFromProposal(proposal);
                if (!jobUrl) {
                    continue;
                }
                proposalsWithDerivedJobUrl += 1;
                if (seenJobUrls.has(jobUrl)) {
                    continue;
                }

                seenJobUrls.add(jobUrl);
                jobTargets.push({
                    jobUrl,
                    sourceProposalUrl: extractProposalUrl(proposal) || proposal?.proposalDetailsPage?.url || '',
                    reason,
                    proposal
                });
            }

            if (!jobTargets.length) {
                updateStatus({
                    listCurrent: '1',
                    listTotal: '1',
                    itemCurrent: 0,
                    itemTotal: 0,
                    action: (
                        'No saved proposal details with job URLs found. ' +
                        `Detailed proposals in scope: ${eligibleProposalCount}/${savedProposals.length}; ` +
                        `archived list entries: ${existingProposalList.length}.`
                    )
                });
                setTimeout(() => {
                    statusPopup.remove();
                }, 4500);
                return [];
            }

            updateStatus({
                listCurrent: '1',
                listTotal: '1',
                itemCurrent: 0,
                itemTotal: jobTargets.length,
                action: (
                    'Scraping job posts from saved proposal details ' +
                    `(${jobTargets.length} unique jobs from ${eligibleProposalCount} detailed proposals; ` +
                    `URL found in ${proposalsWithDerivedJobUrl}; ` +
                    `archived list entries: ${existingProposalList.length}).`
                )
            });

            const jobStorage = await chrome.storage.local.get('jobPosts');
            const existingJobPosts = Array.isArray(jobStorage.jobPosts) ? jobStorage.jobPosts : [];
            const jobPostsByUrl = new Map();
            for (const entry of existingJobPosts) {
                const existingUrl = String(entry?.jobPostPage?.url || entry?.sourcePageUrl || '').trim();
                if (existingUrl) {
                    jobPostsByUrl.set(existingUrl, entry);
                }
            }

            const savedRecords = [];
            let fallbackSavedCount = 0;
            for (let index = 0; index < jobTargets.length; index += 1) {
                const target = jobTargets[index];
                while (isPaused) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                updateStatus({
                    listCurrent: '1',
                    listTotal: '1',
                    itemCurrent: index + 1,
                    itemTotal: jobTargets.length,
                    action: `Scraping saved job post ${index + 1}/${jobTargets.length}`
                });

                const jobPostFetchResult = await fetchJobPostRawData(target.jobUrl, target.sourceProposalUrl || target.jobUrl);
                let jobPostData = jobPostFetchResult?.data || null;
                let usedDetailsFallback = false;
                if (!jobPostData || Object.keys(jobPostData).length === 0) {
                    jobPostData = extractJobPostDataFallbackFromProposal(target.proposal, target.jobUrl);
                    usedDetailsFallback = !!(jobPostData && Object.keys(jobPostData).length > 0);
                }
                if (!jobPostData || Object.keys(jobPostData).length === 0) {
                    recordError('job_post_parse_empty', {
                        message: 'No job post data parsed from fetched page or saved details fallback.',
                        sourceUrl: target.jobUrl
                    });
                    continue;
                }
                if (usedDetailsFallback) {
                    fallbackSavedCount += 1;
                }

                const normalizedJobUrl = jobPostData?.jobPost?.url || target.jobUrl;
                const jobPostRecord = {
                    sourcePageUrl: target.sourceProposalUrl || target.jobUrl,
                    sourceProposalReason: target.reason || '',
                    scrapedAt: new Date().toISOString(),
                    jobPostPage: {
                        url: normalizedJobUrl,
                        data: jobPostData
                    },
                    source: 'saved-proposal-details'
                };

                jobPostsByUrl.set(normalizedJobUrl, jobPostRecord);
                savedRecords.push(jobPostRecord);
                if (savedRecords.length % 5 === 0 || index === jobTargets.length - 1) {
                    await chrome.storage.local.set({ jobPosts: Array.from(jobPostsByUrl.values()) });
                }
                runMetrics.processedItems += 1;
                updateStatus();
                await new Promise(resolve => setTimeout(resolve, 600));
            }

            await chrome.storage.local.set({ jobPosts: Array.from(jobPostsByUrl.values()) });

            updateStatus({
                listCurrent: '1',
                listTotal: '1',
                itemCurrent: savedRecords.length,
                itemTotal: jobTargets.length,
                action: (
                    `Job post scraping from saved details done (${savedRecords.length}/${jobTargets.length} saved` +
                    `${fallbackSavedCount > 0 ? `, fallback from details: ${fallbackSavedCount}` : ''}). Closing in 3 seconds...`
                )
            });
            setTimeout(() => {
                statusPopup.remove();
            }, 3000);

            return savedRecords;
        } catch (error) {
            updateStatus({
                action: `Error: ${error.message}${errorState.total > 0 ? ` (tracked errors: ${errorState.total})` : ''}`
            });
            console.error('Saved-list job post scraping error:', error);
            setTimeout(() => {
                statusPopup.remove();
            }, 5000);
            return [];
        } finally {
            teardownNetworkBridge();
            await teardownSandboxBridge();
        }
    }

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
            existingDetailedUrls.add(linkData.href);

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
        let interceptedMissCount = 0;
        let ranDebuggerFirstPageWarmup = false;
        if (scrapeDetailsFromSavedList) {
            const links = getLinksFromStoredProposalList();
            if (!existingProposalList.length) {
                updateStatus({
                    listCurrent: '1',
                    listTotal: '1',
                    itemCurrent: 0,
                    itemTotal: 0,
                    action: 'No saved archived list found. Run "Scrape List Only" first.'
                });
                setTimeout(() => {
                    statusPopup.remove();
                }, 5000);
                return [];
            }

            updateStatus({
                listCurrent: '1',
                listTotal: '1',
                itemCurrent: 0,
                itemTotal: links.length,
                action: links.length > 0
                    ? 'Opening proposals from saved list'
                    : `No pending ${modeSummaryText} in saved list`
            });

            for (let index = 0; index < links.length; index++) {
                const link = links[index];
                while (isPaused) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                allLinks.push(link);
                updateStatus({
                    listCurrent: '1',
                    listTotal: '1',
                    itemCurrent: index + 1,
                    itemTotal: links.length,
                    action: 'Opening proposals from saved list'
                });
                await visitProposalPage(link);
                runMetrics.processedItems += 1;
                updateStatus();
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            runMetrics.completedPages += 1;
            runMetrics.observedItemsInPages += links.length;
        } else {
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

                if (isDebuggerListCaptureMode && !ranDebuggerFirstPageWarmup) {
                    ranDebuggerFirstPageWarmup = true;
                    const warmedUp = await warmupDebuggerCaptureForFirstPage(result);
                    if (warmedUp) {
                        continue;
                    }
                }

                const currentPageResult = isDebuggerListCaptureMode
                    ? result
                    : mergeTableAndInterceptedData(result, pendingInterceptedPageData);
                pendingInterceptedPageData = null;
                const { links, currentPage, totalPages, tableSignature } = currentPageResult;
                const listCurrent = currentPage || progressState.listCurrent;
                const listTotal = totalPages || progressState.listTotal;

                updateStatus({
                    listCurrent,
                    listTotal,
                    itemCurrent: 0,
                    itemTotal: links.length,
                    action: isDebuggerListCaptureMode
                        ? 'Capturing archived list entries from GraphQL responses'
                        : (links.length > 0
                        ? (scrapeArchivedListOnly ? 'Collecting archived list entries' : 'Opening proposals')
                        : 'No new proposals in current segment')
                });
                
                if (links.length === 0 && !isDebuggerListCaptureMode) {
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
                        action: scrapeArchivedListOnly ? 'Collecting archived list entries' : 'Opening proposals'
                    });
                    if (!scrapeArchivedListOnly) {
                        await visitProposalPage(link);
                    } else {
                        existingUrls.add(link.href);
                    }
                    runMetrics.processedItems += 1;
                    updateStatus();
                    if (!scrapeArchivedListOnly) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }
                runMetrics.completedPages += 1;
                runMetrics.observedItemsInPages += links.length;

                if (scrapeArchivedListOnly && links.length > 0 && !useDebuggerProposalListCapture) {
                    await upsertArchivedProposalListEntries(links, `page ${listCurrent || '?'}`);
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
                        action: 'Reached end of list, finishing up...',
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
                    action: 'Loading next segment...',
                    listCurrent,
                    listTotal,
                    itemCurrent: links.length,
                    itemTotal: links.length
                });
                debugLog(`Clicking next page control: "${latestPageState.nextButtonLabel || 'Next'}"`);
                const clickStartedAtMs = Date.now();
                nextButton.click();
                const [moved, interceptedResponse] = await Promise.all([
                    waitForNextPageLoad(currentPage, tableSignature),
                    (useNetworkMonitor
                        ? waitForNextInterceptedProposalResponse({ minRequestStartedAtMs: clickStartedAtMs })
                        : Promise.resolve(null))
                ]);

                if (interceptedResponse) {
                    pendingInterceptedPageData = interceptedResponse;
                    interceptedMissCount = 0;
                } else {
                    interceptedMissCount += 1;
                    if (useNetworkMonitor && (interceptedMissCount === 1 || interceptedMissCount % 5 === 0)) {
                        debugLog(
                            `[Network] No intercepted proposals response captured for this pagination click ` +
                            `(misses=${interceptedMissCount}). Falling back to DOM table extraction. ` +
                            `Stats=${networkDebugStats.received}/${networkDebugStats.targetClassified}/` +
                            `${networkDebugStats.fallbackRecovered}/${networkDebugStats.parseFailed}/` +
                            `${networkDebugStats.droppedNoSignal}. LastEvent=` +
                            `${lastNetworkEventSummary ? `${lastNetworkEventSummary.seq}:${lastNetworkEventSummary.transport}:${lastNetworkEventSummary.path || '?'}:${lastNetworkEventSummary.status || '?'}:len${lastNetworkEventSummary.len}:target${lastNetworkEventSummary.target ? '1' : '0'}:${lastNetworkEventSummary.match}` : 'none'}`
                        );
                    }
                }

                if (!moved && !interceptedResponse) {
                    updateStatus({ action: 'Could not detect next page load. Check console logs.' });
                    debugLog('Pagination click happened, but no page change or GraphQL response was detected within timeout.');
                    break;
                }
            }
        }

        if (scrapeArchivedListOnly && !useDebuggerProposalListCapture) {
            await upsertArchivedProposalListEntries(allLinks, 'final run merge');
        }

        let archivedListRunCount = allLinks.length;
        if (isDebuggerListCaptureMode) {
            const finalStorage = await chrome.storage.local.get('proposalList');
            const finalProposalList = Array.isArray(finalStorage?.proposalList) ? finalStorage.proposalList : [];
            archivedListRunCount = Math.max(finalProposalList.length - initialProposalListCount, 0);
        }

        const completionDelayMs = errorState.total > 0 ? 8000 : 3000;
        updateStatus({
            action: errorState.total > 0
                ? `All done with ${errorState.total} tracked errors. Closing in 8 seconds...`
                : (scrapeArchivedListOnly
                    ? `Archived list done (${archivedListRunCount} entries this run). Closing in 3 seconds...`
                    : (scrapeDetailsFromSavedList
                        ? `Proposal details from saved list done (${allLinks.length} entries this run). Closing in 3 seconds...`
                        : 'All done! Closing in 3 seconds...'))
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
        teardownNetworkBridge();
        await teardownSandboxBridge();
    }

    return allLinks;
}
