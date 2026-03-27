async function runUpworkScrape(options = {}) {
    const upworkRunStatusModule = globalThis.ProposalCopycatUpworkRunStatusModule || {};
    const RUN_STATUS_STORAGE_KEY = upworkRunStatusModule.RUN_STATUS_STORAGE_KEY || 'upworkRunStatus';
    const RUN_CONTROL_STORAGE_KEY = upworkRunStatusModule.RUN_CONTROL_STORAGE_KEY || 'upworkRunControl';
    const ACTIVE_RUN_FLAG = '__proposalCopycatScrapeRunActive';

    if (globalThis[ACTIVE_RUN_FLAG]) {
        return;
    }
    globalThis[ACTIVE_RUN_FLAG] = true;

    const normalizeRunScrapeMode = typeof upworkRunStatusModule.normalizeScrapeMode === 'function'
        ? upworkRunStatusModule.normalizeScrapeMode
        : (value) => value === 'all' ? 'all' : 'successful';
    const getRunDescriptor = typeof upworkRunStatusModule.getRunDescriptor === 'function'
        ? upworkRunStatusModule.getRunDescriptor
        : (descriptorOptions = {}) => ({
            runKind: 'proposal-list',
            statusTitle: descriptorOptions?.scrapeMode === 'all'
                ? 'Collecting Proposals'
                : 'Collecting Successful Proposals',
            modeBadgeText: descriptorOptions?.scrapeMode === 'all' ? 'All Proposals' : 'Successful Only'
        });

    const scrapeMode = normalizeRunScrapeMode(options?.scrapeMode);
    const scrapeCurrentJobPost = options?.scrapeCurrentJobPost === true;
    const scrapeJobPostsFromSavedList = options?.scrapeJobPostsFromSavedList === true;
    const scrapeArchivedListOnly = options?.scrapeArchivedListOnly === true;
    const scrapeProposalDetailsFromList = options?.scrapeProposalDetailsFromList === true;
    const useDebuggerProposalListCapture = options?.useDebuggerProposalListCapture === true;
    const disableNetworkMonitor = options?.disableNetworkMonitor === true;
    const scrapeDetailsFromSavedList = (
        scrapeProposalDetailsFromList &&
        !scrapeArchivedListOnly &&
        !scrapeCurrentJobPost &&
        !scrapeJobPostsFromSavedList
    );
    const isDebuggerListCaptureMode = scrapeArchivedListOnly && useDebuggerProposalListCapture;
    const useNetworkMonitor = !disableNetworkMonitor;
    const runDescriptor = getRunDescriptor({
        scrapeMode,
        scrapeCurrentJobPost,
        scrapeJobPostsFromSavedList,
        scrapeArchivedListOnly,
        scrapeProposalDetailsFromList
    });
    const statusTitle = runDescriptor.statusTitle;
    const modeBadgeText = runDescriptor.modeBadgeText;
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
    let persistedRecordCount = 0;

    const debugLog = (...args) => {
        console.log('[ProposalCopycat]', ...args);
    };
    const scrapeRunStateModule = globalThis.ProposalCopycatScrapeRunStateModule;
    if (!scrapeRunStateModule || typeof scrapeRunStateModule.createScrapeRunState !== 'function') {
        throw new Error('Proposal scrape run-state module is not available in page context.');
    }

    const scrapeRunState = scrapeRunStateModule.createScrapeRunState({
        statusTitle,
        modeBadgeText,
        scrapeCurrentJobPost,
        scrapeJobPostsFromSavedList,
        scrapeArchivedListOnly,
        scrapeDetailsFromSavedList,
        runStatusStorageKey: RUN_STATUS_STORAGE_KEY,
        runControlStorageKey: RUN_CONTROL_STORAGE_KEY,
        getTotalSavedCount: () => {
            if (scrapeCurrentJobPost || scrapeJobPostsFromSavedList) {
                return persistedRecordCount;
            }
            if (scrapeArchivedListOnly) {
                return allLinks.length;
            }
            return tableData.length;
        },
        debugLog
    });
    const {
        progressState,
        errorState,
        runMetrics,
        updateStatus,
        isStopRequestedError,
        throwIfStopRequested,
        waitWhilePaused,
        recordError,
        initialize: initializeRunState,
        finalize: finalizeRunState
    } = scrapeRunState;

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

    debugLog(
        `Loaded ${existingProposals.length} detailed proposals and ${existingProposalList.length} list records from storage. ` +
        `Mode: ${scrapeMode}, listOnly: ${scrapeArchivedListOnly}, detailsFromList: ${scrapeDetailsFromSavedList}, ` +
        `jobPostsFromList: ${scrapeJobPostsFromSavedList}, ` +
        `debuggerListCapture: ${useDebuggerProposalListCapture}, networkMonitor: ${useNetworkMonitor}`
    );
    await initializeRunState();
    updateStatus({ action: 'Starting scraper...' });

    const proposalListPageModule = globalThis.ProposalCopycatProposalListPageModule;
    if (!proposalListPageModule || typeof proposalListPageModule.createProposalListPageScraper !== 'function') {
        throw new Error('Proposal list scraper module is not available in page context.');
    }

    const proposalListPageScraper = proposalListPageModule.createProposalListPageScraper({
        debugLog,
        updateStatus,
        scrapeMode,
        isDebuggerListCaptureMode,
        useNetworkMonitor,
        existingUrls,
        existingDetailedUrls,
        existingProposalList
    });
    if (useNetworkMonitor) {
        proposalListPageScraper.installNetworkBridge();
        debugLog('[Network] Waiting for proposal-list GraphQL responses from the page monitor.');
    }
    const teardownNetworkBridge = () => {
        proposalListPageScraper.teardownNetworkBridge();
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

    const needsProposalDetailsScraper = (
        !scrapeArchivedListOnly &&
        !scrapeCurrentJobPost &&
        !scrapeJobPostsFromSavedList
    );
    let visitProposalPage = async () => {
        throw new Error('Proposal details scraper is not initialized for this mode.');
    };
    if (needsProposalDetailsScraper) {
        const proposalDetailsModule = globalThis.ProposalCopycatProposalDetailsPageModule;
        if (!proposalDetailsModule || typeof proposalDetailsModule.createProposalDetailsScraper !== 'function') {
            throw new Error('Proposal details scraper module is not available in page context.');
        }

        const proposalDetailsScraper = proposalDetailsModule.createProposalDetailsScraper({
            debugLog,
            recordError,
            parseNuxtScalarsInSandbox,
            fetchJobPostRawData,
            setIfPresent,
            removeEmptySections
        });

        visitProposalPage = async (linkData) => {
            const result = await proposalDetailsScraper.visitProposalPage(linkData);
            if (!result?.proposalData) {
                return null;
            }

            existingUrls.add(linkData.href);
            existingDetailedUrls.add(linkData.href);
            tableData.push(result.proposalData);
            debugLog(`[Proposal] ${linkData.href}: complete.`);

            return {
                description: result.description,
                coverLetter: result.coverLetter
            };
        };
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
                    itemTotal: 1,
                    runComplete: true,
                    runStatus: 'invalid-target'
                });
                return [];
            }

            const jobPostFetchResult = await fetchJobPostRawData(currentPageUrl, currentPageUrl);
            throwIfStopRequested();
            const jobPostData = jobPostFetchResult?.data || null;

            if (!jobPostData || Object.keys(jobPostData).length === 0) {
                updateStatus({
                    action: `Could not extract job post data${errorState.total > 0 ? ` (errors: ${errorState.total})` : ''}.`,
                    listCurrent: '1',
                    listTotal: '1',
                    itemCurrent: 1,
                    itemTotal: 1,
                    runComplete: true,
                    runStatus: 'no-data'
                });
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
            persistedRecordCount = 1;

            updateStatus({
                action: `Active job post saved${errorState.total > 0 ? ` with ${errorState.total} tracked errors` : ''}.`,
                listCurrent: '1',
                listTotal: '1',
                itemCurrent: 1,
                itemTotal: 1,
                runComplete: true,
                runStatus: 'completed'
            });

            return [jobPostRecord];
        } catch (error) {
            if (isStopRequestedError(error)) {
                updateStatus({
                    action: 'Stopped from the side panel.',
                    runComplete: true,
                    runStatus: 'stopped'
                });
                return [];
            }
            updateStatus({
                action: `Error: ${error.message}${errorState.total > 0 ? ` (tracked errors: ${errorState.total})` : ''}`,
                runComplete: true,
                runStatus: 'failed'
            });
            console.error('Current job post scraping error:', error);
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
                if (!proposalListPageScraper.isReasonAllowed(reason)) {
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
                    ),
                    runComplete: true,
                    runStatus: 'no-targets'
                });
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
                await waitWhilePaused();

                updateStatus({
                    listCurrent: '1',
                    listTotal: '1',
                    itemCurrent: index + 1,
                    itemTotal: jobTargets.length,
                    action: `Scraping saved job post ${index + 1}/${jobTargets.length}`
                });

                const jobPostFetchResult = await fetchJobPostRawData(target.jobUrl, target.sourceProposalUrl || target.jobUrl);
                throwIfStopRequested();
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
                persistedRecordCount = savedRecords.length;
                if (savedRecords.length % 5 === 0 || index === jobTargets.length - 1) {
                    await chrome.storage.local.set({ jobPosts: Array.from(jobPostsByUrl.values()) });
                }
                runMetrics.processedItems += 1;
                updateStatus();
                await new Promise(resolve => setTimeout(resolve, 600));
                throwIfStopRequested();
            }

            await chrome.storage.local.set({ jobPosts: Array.from(jobPostsByUrl.values()) });

            updateStatus({
                listCurrent: '1',
                listTotal: '1',
                itemCurrent: savedRecords.length,
                itemTotal: jobTargets.length,
                action: (
                    `Job post scraping from saved details done (${savedRecords.length}/${jobTargets.length} saved` +
                    `${fallbackSavedCount > 0 ? `, fallback from details: ${fallbackSavedCount}` : ''}).`
                ),
                runComplete: true,
                runStatus: 'completed'
            });

            return savedRecords;
        } catch (error) {
            if (isStopRequestedError(error)) {
                updateStatus({
                    action: 'Stopped from the side panel.',
                    runComplete: true,
                    runStatus: 'stopped'
                });
                return [];
            }
            updateStatus({
                action: `Error: ${error.message}${errorState.total > 0 ? ` (tracked errors: ${errorState.total})` : ''}`,
                runComplete: true,
                runStatus: 'failed'
            });
            console.error('Saved-list job post scraping error:', error);
            return [];
        } finally {
            teardownNetworkBridge();
            await teardownSandboxBridge();
        }
    }

    try {
        let interceptedMissCount = 0;
        let ranDebuggerFirstPageWarmup = false;
        if (scrapeDetailsFromSavedList) {
            const links = proposalListPageScraper.getLinksFromStoredProposalList();
            if (!existingProposalList.length) {
                updateStatus({
                    listCurrent: '1',
                    listTotal: '1',
                    itemCurrent: 0,
                    itemTotal: 0,
                    action: 'No saved archived list found. Run "Scrape List Only" first.'
                });
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
                await waitWhilePaused();

                allLinks.push(link);
                updateStatus({
                    listCurrent: '1',
                    listTotal: '1',
                    itemCurrent: index + 1,
                    itemTotal: links.length,
                    action: 'Opening proposals from saved list'
                });
                await visitProposalPage(link);
                throwIfStopRequested();
                runMetrics.processedItems += 1;
                updateStatus();
                await new Promise(resolve => setTimeout(resolve, 2000));
                throwIfStopRequested();
            }
            runMetrics.completedPages += 1;
            runMetrics.observedItemsInPages += links.length;
        } else {
            while (true) {
                await waitWhilePaused();

                const result = await proposalListPageScraper.waitForTable();
                throwIfStopRequested();
                if (!result) {
                    updateStatus({ action: 'No table found after timeout' });
                    debugLog('Scraping timeout - no table found');
                    break;
                }

                if (isDebuggerListCaptureMode && !ranDebuggerFirstPageWarmup) {
                    ranDebuggerFirstPageWarmup = true;
                    const warmedUp = await proposalListPageScraper.warmupDebuggerCaptureForFirstPage(result);
                    throwIfStopRequested();
                    if (warmedUp) {
                        continue;
                    }
                }

                const currentPageResult = proposalListPageScraper.mergeCurrentPageResult(result);
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
                    await waitWhilePaused();

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
                        throwIfStopRequested();
                    } else {
                        existingUrls.add(link.href);
                    }
                    runMetrics.processedItems += 1;
                    updateStatus();
                    if (!scrapeArchivedListOnly) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        throwIfStopRequested();
                    }
                }
                runMetrics.completedPages += 1;
                runMetrics.observedItemsInPages += links.length;

                if (scrapeArchivedListOnly && links.length > 0 && !useDebuggerProposalListCapture) {
                    await proposalListPageScraper.upsertArchivedProposalListEntries(links, `page ${listCurrent || '?'}`);
                }

                // Re-read pagination from the live DOM in case Upwork re-rendered the section.
                const latestPageState = proposalListPageScraper.scrapeCurrentPage();
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
                    proposalListPageScraper.waitForNextPageLoad(currentPage, tableSignature),
                    (useNetworkMonitor
                        ? proposalListPageScraper.waitForNextInterceptedProposalResponse({ minRequestStartedAtMs: clickStartedAtMs })
                        : Promise.resolve(null))
                ]);
                throwIfStopRequested();

                if (interceptedResponse) {
                    proposalListPageScraper.rememberInterceptedResponse(interceptedResponse);
                    interceptedMissCount = 0;
                } else {
                    interceptedMissCount += 1;
                    if (useNetworkMonitor && (interceptedMissCount === 1 || interceptedMissCount % 5 === 0)) {
                        const networkSnapshot = proposalListPageScraper.getNetworkDebugSnapshot();
                        const stats = networkSnapshot?.stats || {};
                        const lastEventSummary = networkSnapshot?.lastEventSummary || null;
                        debugLog(
                            `[Network] No intercepted proposals response captured for this pagination click ` +
                            `(misses=${interceptedMissCount}). Falling back to DOM table extraction. ` +
                            `Stats=${stats.received || 0}/${stats.targetClassified || 0}/` +
                            `${stats.fallbackRecovered || 0}/${stats.parseFailed || 0}/` +
                            `${stats.droppedNoSignal || 0}. LastEvent=` +
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
            await proposalListPageScraper.upsertArchivedProposalListEntries(allLinks, 'final run merge');
        }

        let archivedListRunCount = allLinks.length;
        if (isDebuggerListCaptureMode) {
            const finalStorage = await chrome.storage.local.get('proposalList');
            const finalProposalList = Array.isArray(finalStorage?.proposalList) ? finalStorage.proposalList : [];
            archivedListRunCount = Math.max(finalProposalList.length - initialProposalListCount, 0);
        }

        updateStatus({
            action: errorState.total > 0
                ? `All done with ${errorState.total} tracked errors.`
                : (scrapeArchivedListOnly
                    ? `Archived list done (${archivedListRunCount} entries this run).`
                    : (scrapeDetailsFromSavedList
                        ? `Proposal details from saved list done (${allLinks.length} entries this run).`
                        : 'All done!')),
            runComplete: true,
            runStatus: 'completed'
        });
        debugLog('Finished processing all proposals');

    } catch (error) {
        if (isStopRequestedError(error)) {
            updateStatus({
                action: 'Stopped from the side panel.',
                runComplete: true,
                runStatus: 'stopped'
            });
            debugLog('Run stopped from the side panel.');
        } else {
            updateStatus({
                action: `Error: ${error.message}${errorState.total > 0 ? ` (tracked errors: ${errorState.total})` : ''}`,
                runComplete: true,
                runStatus: 'failed'
            });
            console.error('Scraping error:', error);
        }
    } finally {
        await finalizeRunState();
        teardownNetworkBridge();
        await teardownSandboxBridge();
        delete globalThis[ACTIVE_RUN_FLAG];
    }

    return allLinks;
}
