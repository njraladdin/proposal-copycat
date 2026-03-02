(() => {
    if (globalThis.ProposalCopycatJobPostPageModule) {
        return;
    }

    const fallbackSetIfPresent = (target, key, value) => {
        if (
            value === undefined ||
            value === null ||
            value === '' ||
            (Array.isArray(value) && value.length === 0) ||
            (typeof value === 'object' &&
                !Array.isArray(value) &&
                Object.keys(value).length === 0)
        ) {
            return;
        }

        target[key] = value;
    };

    const fallbackRemoveEmptySections = (obj) => {
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

    const createJobPostScraper = (deps = {}) => {
        const debugLog = typeof deps.debugLog === 'function' ? deps.debugLog : () => {};
        const recordError = typeof deps.recordError === 'function' ? deps.recordError : () => {};
        const setIfPresent = typeof deps.setIfPresent === 'function'
            ? deps.setIfPresent
            : fallbackSetIfPresent;
        const removeEmptySections = typeof deps.removeEmptySections === 'function'
            ? deps.removeEmptySections
            : fallbackRemoveEmptySections;

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

        const isJobPostPageUrl = (url) => /^https:\/\/www\.upwork\.com\/jobs\/[^/?#]+/i.test(String(url || ''));

        return {
            fetchJobPostRawData,
            isJobPostPageUrl
        };
    };

    globalThis.ProposalCopycatJobPostPageModule = {
        createJobPostScraper
    };
})();