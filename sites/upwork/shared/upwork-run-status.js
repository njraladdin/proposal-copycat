(() => {
    if (globalThis.ProposalCopycatUpworkRunStatusModule) {
        return;
    }

    const RUN_STATUS_STORAGE_KEY = 'upworkRunStatus';
    const RUN_CONTROL_STORAGE_KEY = 'upworkRunControl';

    const normalizeScrapeMode = (value) => value === 'all' ? 'all' : 'successful';

    const normalizeRunControl = (value = {}) => ({
        paused: value?.paused === true,
        stopRequested: value?.stopRequested === true
    });

    const getRunDescriptor = (options = {}) => {
        const scrapeMode = normalizeScrapeMode(options?.scrapeMode);
        const scrapeCurrentJobPost = options?.scrapeCurrentJobPost === true;
        const scrapeJobPostsFromSavedList = options?.scrapeJobPostsFromSavedList === true;
        const scrapeArchivedListOnly = options?.scrapeArchivedListOnly === true;
        const scrapeProposalDetailsFromList = options?.scrapeProposalDetailsFromList === true;
        const scrapeDetailsFromSavedList = (
            scrapeProposalDetailsFromList &&
            !scrapeArchivedListOnly &&
            !scrapeCurrentJobPost &&
            !scrapeJobPostsFromSavedList
        );

        if (scrapeCurrentJobPost) {
            return {
                runKind: 'current-job-post',
                statusTitle: 'Collecting Job Post',
                modeBadgeText: 'Current Job Page'
            };
        }

        if (scrapeJobPostsFromSavedList) {
            return {
                runKind: 'job-posts-from-saved-list',
                statusTitle: 'Collecting Job Posts',
                modeBadgeText: scrapeMode === 'all'
                    ? 'Job Posts From Saved Details: All Proposals'
                    : 'Job Posts From Saved Details: Successful Only'
            };
        }

        if (scrapeArchivedListOnly) {
            return {
                runKind: 'archived-proposal-list',
                statusTitle: 'Collecting Proposal List',
                modeBadgeText: scrapeMode === 'all'
                    ? 'Archived List: All Proposals'
                    : 'Archived List: Successful Only'
            };
        }

        if (scrapeDetailsFromSavedList) {
            return {
                runKind: 'proposal-details-from-saved-list',
                statusTitle: 'Collecting Proposal Details',
                modeBadgeText: scrapeMode === 'all'
                    ? 'Details From Saved List: All Proposals'
                    : 'Details From Saved List: Successful Only'
            };
        }

        return {
            runKind: 'proposal-list',
            statusTitle: scrapeMode === 'all'
                ? 'Collecting Proposals'
                : 'Collecting Successful Proposals',
            modeBadgeText: scrapeMode === 'all' ? 'All Proposals' : 'Successful Only'
        };
    };

    const createRunStatusPayload = (input = {}) => {
        const descriptor = getRunDescriptor({
            scrapeMode: input?.scrapeMode,
            scrapeCurrentJobPost: input?.runKind === 'current-job-post',
            scrapeJobPostsFromSavedList: input?.runKind === 'job-posts-from-saved-list',
            scrapeArchivedListOnly: input?.runKind === 'archived-proposal-list',
            scrapeProposalDetailsFromList: input?.runKind === 'proposal-details-from-saved-list'
        });

        return {
            statusTitle: String(input?.statusTitle || descriptor.statusTitle || 'Current Upwork Run'),
            modeBadgeText: String(input?.modeBadgeText || descriptor.modeBadgeText || ''),
            action: String(input?.action || ''),
            listProgressLabel: String(input?.listProgressLabel || 'Scope'),
            listProgressText: String(input?.listProgressText || '-'),
            listCurrent: input?.listCurrent || '',
            listTotal: input?.listTotal || '',
            itemCurrent: Number.isFinite(input?.itemCurrent) ? input.itemCurrent : 0,
            itemTotal: Number.isFinite(input?.itemTotal) ? input.itemTotal : 0,
            totalSaved: Number.isFinite(input?.totalSaved) ? input.totalSaved : 0,
            etaMs: Number.isFinite(input?.etaMs) ? input.etaMs : null,
            etaText: String(input?.etaText || ''),
            errorTotal: Number.isFinite(input?.errorTotal) ? input.errorTotal : 0,
            errorSummary: String(input?.errorSummary || ''),
            recentErrors: Array.isArray(input?.recentErrors) ? input.recentErrors : [],
            isPaused: input?.isPaused === true,
            stopRequested: input?.stopRequested === true,
            inProgress: input?.inProgress === true,
            status: String(input?.status || (input?.inProgress === true ? 'running' : 'idle')),
            pauseSupported: input?.pauseSupported === true,
            stopSupported: input?.stopSupported === true,
            runKind: String(input?.runKind || descriptor.runKind || 'proposal-list'),
            startedAt: input?.startedAt || null,
            updatedAt: input?.updatedAt || new Date().toISOString()
        };
    };

    globalThis.ProposalCopycatUpworkRunStatusModule = {
        RUN_STATUS_STORAGE_KEY,
        RUN_CONTROL_STORAGE_KEY,
        normalizeScrapeMode,
        normalizeRunControl,
        getRunDescriptor,
        createRunStatusPayload
    };
})();
