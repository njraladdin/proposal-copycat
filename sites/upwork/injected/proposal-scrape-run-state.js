(() => {
    if (globalThis.ProposalCopycatScrapeRunStateModule) {
        return;
    }

    const DEFAULT_RUN_STATUS_STORAGE_KEY = 'upworkRunStatus';
    const DEFAULT_RUN_CONTROL_STORAGE_KEY = 'upworkRunControl';
    const STOP_REQUESTED_ERROR_CODE = 'proposal_copycat_stop_requested';

    const createScrapeRunState = (deps = {}) => {
        const statusTitle = String(deps?.statusTitle || '');
        const modeBadgeText = String(deps?.modeBadgeText || '');
        const scrapeCurrentJobPost = deps?.scrapeCurrentJobPost === true;
        const scrapeJobPostsFromSavedList = deps?.scrapeJobPostsFromSavedList === true;
        const scrapeArchivedListOnly = deps?.scrapeArchivedListOnly === true;
        const scrapeDetailsFromSavedList = deps?.scrapeDetailsFromSavedList === true;
        const getTotalSavedCount = typeof deps?.getTotalSavedCount === 'function'
            ? deps.getTotalSavedCount
            : () => 0;
        const debugLog = typeof deps?.debugLog === 'function' ? deps.debugLog : () => {};
        const runStatusStorageKey = typeof deps?.runStatusStorageKey === 'string' && deps.runStatusStorageKey.trim()
            ? deps.runStatusStorageKey.trim()
            : DEFAULT_RUN_STATUS_STORAGE_KEY;
        const runControlStorageKey = typeof deps?.runControlStorageKey === 'string' && deps.runControlStorageKey.trim()
            ? deps.runControlStorageKey.trim()
            : DEFAULT_RUN_CONTROL_STORAGE_KEY;

        let lastActiveAction = 'Starting scraper...';
        let runStatusFlushTimer = null;
        let runControlListener = null;
        const runControlState = { paused: false, stopRequested: false };
        const runLifecycle = { inProgress: true, status: 'running' };

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
        const runStartedAtIso = new Date(runMetrics.startedAtMs).toISOString();
        const usesPagedListProgress = (
            !scrapeCurrentJobPost &&
            !scrapeJobPostsFromSavedList &&
            !scrapeDetailsFromSavedList
        );
        const MAX_RECENT_ERRORS = 5;

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

        const buildRunStatusSnapshot = () => {
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
            const recentErrors = errorState.recent.slice(0, 3);

            return {
                listProgressLabel,
                listProgressText,
                pageProgressText,
                etaRemainingMs,
                etaText,
                errorTypeSummary,
                recentErrors
            };
        };

        const flushRunStatus = async () => {
            runStatusFlushTimer = null;
            const snapshot = buildRunStatusSnapshot();

            try {
                await chrome.storage.local.set({
                    [runStatusStorageKey]: {
                        statusTitle,
                        modeBadgeText,
                        action: progressState.action,
                        listProgressLabel: snapshot.listProgressLabel,
                        listProgressText: snapshot.listProgressText,
                        listCurrent: progressState.listCurrent || '',
                        listTotal: progressState.listTotal || '',
                        itemCurrent: Number.isFinite(progressState.itemCurrent) ? progressState.itemCurrent : 0,
                        itemTotal: Number.isFinite(progressState.itemTotal) ? progressState.itemTotal : 0,
                        totalSaved: getTotalSavedCount(),
                        etaMs: snapshot.etaRemainingMs,
                        etaText: snapshot.etaText,
                        errorTotal: errorState.total,
                        errorSummary: snapshot.errorTypeSummary,
                        recentErrors: snapshot.recentErrors,
                        isPaused: runControlState.paused,
                        stopRequested: runControlState.stopRequested,
                        inProgress: runLifecycle.inProgress,
                        status: runLifecycle.status,
                        pauseSupported: true,
                        stopSupported: true,
                        runKind: (
                            scrapeCurrentJobPost
                                ? 'current-job-post'
                                : (scrapeJobPostsFromSavedList
                                    ? 'job-posts-from-saved-list'
                                    : (scrapeArchivedListOnly
                                        ? 'archived-proposal-list'
                                        : (scrapeDetailsFromSavedList
                                            ? 'proposal-details-from-saved-list'
                                            : 'proposal-list')))
                        ),
                        startedAt: runStartedAtIso,
                        updatedAt: new Date().toISOString()
                    }
                });
            } catch (error) {
                console.warn('Failed to persist Upwork run status:', error);
            }
        };

        const scheduleRunStatusPersist = (options = {}) => {
            const force = options?.force === true;
            if (force) {
                if (runStatusFlushTimer !== null) {
                    clearTimeout(runStatusFlushTimer);
                    runStatusFlushTimer = null;
                }
                return flushRunStatus();
            }

            if (runStatusFlushTimer !== null) {
                return Promise.resolve();
            }

            runStatusFlushTimer = setTimeout(() => {
                flushRunStatus().catch((error) => {
                    console.warn('Deferred Upwork run status flush failed:', error);
                });
            }, 150);
            return Promise.resolve();
        };

        const updateStatus = (updates = {}) => {
            const nextUpdates = updates && typeof updates === 'object' ? updates : {};
            const progressUpdates = { ...nextUpdates };
            const runComplete = progressUpdates.runComplete === true;
            const nextRunStatus = typeof progressUpdates.runStatus === 'string' && progressUpdates.runStatus.trim()
                ? progressUpdates.runStatus.trim()
                : '';

            delete progressUpdates.runComplete;
            delete progressUpdates.runStatus;

            Object.assign(progressState, progressUpdates);

            if (nextRunStatus) {
                runLifecycle.status = nextRunStatus;
            }
            if (runComplete) {
                runLifecycle.inProgress = false;
                if (!nextRunStatus) {
                    runLifecycle.status = runLifecycle.status || 'completed';
                }
            }

            if (progressUpdates.action && progressUpdates.action !== 'Paused') {
                lastActiveAction = progressUpdates.action;
            }

            scheduleRunStatusPersist();
        };

        const createStopRequestedError = () => {
            const error = new Error('Stopped from the side panel.');
            error.code = STOP_REQUESTED_ERROR_CODE;
            return error;
        };

        const isStopRequestedError = (error) => error?.code === STOP_REQUESTED_ERROR_CODE;

        const throwIfStopRequested = () => {
            if (runControlState.stopRequested) {
                throw createStopRequestedError();
            }
        };

        const applyRunControlState = (nextControl = {}) => {
            const normalizedPaused = nextControl?.paused === true;
            const normalizedStopRequested = nextControl?.stopRequested === true;
            const pauseChanged = runControlState.paused !== normalizedPaused;
            const stopChanged = runControlState.stopRequested !== normalizedStopRequested;

            runControlState.paused = normalizedPaused;
            runControlState.stopRequested = normalizedStopRequested;

            if (normalizedStopRequested) {
                if (stopChanged) {
                    updateStatus({ action: 'Stopping after current step...' });
                } else {
                    scheduleRunStatusPersist();
                }
                return;
            }

            if (!pauseChanged) {
                if (stopChanged) {
                    scheduleRunStatusPersist();
                }
                return;
            }

            if (normalizedPaused) {
                updateStatus({ action: 'Paused' });
                return;
            }

            updateStatus({ action: lastActiveAction || 'Resuming...' });
        };

        const waitWhilePaused = async () => {
            while (runControlState.paused) {
                throwIfStopRequested();
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
            throwIfStopRequested();
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

        const initialize = async () => {
            runControlListener = (changes, namespace) => {
                if (namespace !== 'local' || !changes[runControlStorageKey]) {
                    return;
                }

                applyRunControlState(changes[runControlStorageKey]?.newValue || {});
            };

            chrome.storage.onChanged.addListener(runControlListener);

            try {
                await chrome.storage.local.set({
                    [runControlStorageKey]: {
                        paused: false,
                        stopRequested: false,
                        updatedAt: new Date().toISOString()
                    }
                });
            } catch (error) {
                console.warn('Failed to initialize Upwork run control state:', error);
            }
        };

        const finalize = async () => {
            if (runLifecycle.inProgress) {
                runLifecycle.inProgress = false;
                if (!runLifecycle.status || runLifecycle.status === 'running') {
                    runLifecycle.status = 'completed';
                }
            }

            if (runControlListener) {
                chrome.storage.onChanged.removeListener(runControlListener);
                runControlListener = null;
            }

            runControlState.paused = false;
            runControlState.stopRequested = false;

            try {
                await chrome.storage.local.set({
                    [runControlStorageKey]: {
                        paused: false,
                        stopRequested: false,
                        updatedAt: new Date().toISOString()
                    }
                });
            } catch (error) {
                console.warn('Failed to reset Upwork run control state:', error);
            }

            await scheduleRunStatusPersist({ force: true });
        };

        return {
            progressState,
            errorState,
            runMetrics,
            updateStatus,
            isStopRequestedError,
            throwIfStopRequested,
            waitWhilePaused,
            recordError,
            initialize,
            finalize
        };
    };

    globalThis.ProposalCopycatScrapeRunStateModule = {
        createScrapeRunState
    };
})();
