(() => {
    if (globalThis.ProposalCopycatProposalDetailsPageModule) {
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

    const createProposalDetailsScraper = (deps = {}) => {
        const debugLog = typeof deps.debugLog === 'function' ? deps.debugLog : () => {};
        const recordError = typeof deps.recordError === 'function' ? deps.recordError : () => {};
        const parseNuxtScalarsInSandbox = typeof deps.parseNuxtScalarsInSandbox === 'function'
            ? deps.parseNuxtScalarsInSandbox
            : async () => ({
                aliases: {},
                fields: {},
                assignments: {},
                rawParsedData: null
            });
        const fetchJobPostRawData = typeof deps.fetchJobPostRawData === 'function'
            ? deps.fetchJobPostRawData
            : async () => null;
        const setIfPresent = typeof deps.setIfPresent === 'function'
            ? deps.setIfPresent
            : fallbackSetIfPresent;
        const removeEmptySections = typeof deps.removeEmptySections === 'function'
            ? deps.removeEmptySections
            : fallbackRemoveEmptySections;

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

        const normalizeMultilineText = (value) => {
            const normalized = String(value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\r\n?/g, '\n')
                .split('\n')
                .map((line) => line.replace(/[ \t]+/g, ' ').trim())
                .join('\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim();

            return normalized || null;
        };

        const normalizeInlineText = (value) => {
            const normalized = String(value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            return normalized || null;
        };

        const parseConnectsCount = (value) => {
            const match = String(value || '').match(/(\d+)\s+connects?\b/i);
            if (!match) {
                return null;
            }

            const parsed = Number.parseInt(match[1], 10);
            return Number.isFinite(parsed) ? parsed : null;
        };

        const extractCoverLetterFromDom = (parsedDoc, sourceUrl = '') => {
            const coverLetterSection = parsedDoc?.querySelector('[data-cy="cover-letter-section"]');
            if (!coverLetterSection) {
                return null;
            }

            const contentNode =
                coverLetterSection.querySelector('p.text-pre-line') ||
                coverLetterSection.querySelector('.air3-card-section .text-pre-line') ||
                coverLetterSection.querySelector('.air3-card-section p.break') ||
                coverLetterSection.querySelector('.air3-card-section p');

            if (!contentNode) {
                return null;
            }

            const coverLetter = normalizeMultilineText(contentNode?.textContent || '');
            if (coverLetter) {
                debugLog(
                    `[Proposal] ${sourceUrl || 'unknown-url'}: extracted DOM cover letter ` +
                    `(${coverLetter.length} chars).`
                );
            }

            return coverLetter;
        };

        const extractAttachedHighlightsFromDom = (parsedDoc, sourceUrl = '') => {
            const attachedHighlightsSection = parsedDoc?.querySelector('.profile-highlights-section');
            if (!attachedHighlightsSection) {
                return null;
            }

            const sectionDescription = normalizeInlineText(
                attachedHighlightsSection.querySelector('header .subtitle')?.textContent || ''
            );
            const items = Array.from(
                attachedHighlightsSection.querySelectorAll('[data-test="highlights-item"]')
            )
                .map((item) => {
                    const secondaryTexts = Array.from(item.querySelectorAll('.secondary-text'))
                        .map((node) => normalizeInlineText(node.textContent))
                        .filter(Boolean);
                    const title = normalizeInlineText(
                        item.querySelector('.item-title')?.textContent || ''
                    );
                    const itemType = secondaryTexts[0] || null;
                    const meta = normalizeInlineText(
                        item.querySelector('.work-history-info')?.textContent || ''
                    ) || secondaryTexts.slice(1).join(' | ') || null;

                    const normalizedItem = {};
                    setIfPresent(normalizedItem, 'type', itemType);
                    setIfPresent(normalizedItem, 'title', title);
                    setIfPresent(normalizedItem, 'meta', meta);

                    return Object.keys(normalizedItem).length > 0 ? normalizedItem : null;
                })
                .filter(Boolean);

            if (!sectionDescription && items.length === 0) {
                return null;
            }

            const attachedHighlights = {};
            setIfPresent(attachedHighlights, 'description', sectionDescription);
            setIfPresent(attachedHighlights, 'items', items);

            debugLog(
                `[Proposal] ${sourceUrl || 'unknown-url'}: extracted DOM attached proposal highlights ` +
                `(${items.length} item(s)).`
            );

            return attachedHighlights;
        };

        const extractProposalConnectsFromDom = (parsedDoc, sourceUrl = '') => {
            const boostSection = parsedDoc?.querySelector('.boost-information-section');
            if (!boostSection) {
                return null;
            }

            const connectsText = normalizeInlineText(
                boostSection.querySelector('strong')?.textContent ||
                boostSection.querySelector('.text-body')?.textContent ||
                boostSection.textContent ||
                ''
            );
            const connectsSpent = parseConnectsCount(connectsText);

            if (connectsSpent !== null) {
                debugLog(
                    `[Proposal] ${sourceUrl || 'unknown-url'}: extracted DOM connects count ` +
                    `(${connectsSpent}).`
                );
            }

            return connectsSpent;
        };

        const mergeDomProposalFields = (proposalDetailsData, domFields = {}) => {
            const mergedData = proposalDetailsData && typeof proposalDetailsData === 'object'
                ? { ...proposalDetailsData }
                : {};
            const mergedProposal = mergedData.proposal && typeof mergedData.proposal === 'object'
                ? { ...mergedData.proposal }
                : {};
            const mergedTerms = mergedProposal.terms && typeof mergedProposal.terms === 'object'
                ? { ...mergedProposal.terms }
                : {};

            if (domFields.coverLetter) {
                mergedProposal.coverLetter = domFields.coverLetter;
            }
            if (domFields.attachedHighlights) {
                mergedProposal.attachedHighlights = domFields.attachedHighlights;
            }
            if (domFields.connectsSpent !== null && domFields.connectsSpent !== undefined) {
                mergedTerms.connectsSpent = domFields.connectsSpent;
            }
            if (Object.keys(mergedTerms).length > 0) {
                mergedProposal.terms = mergedTerms;
            }

            if (Object.keys(mergedProposal).length > 0) {
                mergedData.proposal = mergedProposal;
            }

            return removeEmptySections(mergedData);
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

        const buildCompactProposalData = (proposalRecord) => {
            const compact = JSON.parse(JSON.stringify(proposalRecord || {}));

            if (compact?.proposalDetailsPage?.pageData?.proposal) {
                delete compact.proposalDetailsPage.pageData.proposal.answersToQuestions;
            }
            if (compact?.proposalDetailsPage?.pageData?.jobPost) {
                delete compact.proposalDetailsPage.pageData.jobPost.jobPrompt;
            }
            if (compact?.proposalDetailsPage?.data?.proposal) {
                delete compact.proposalDetailsPage.data.proposal.answersToQuestions;
            }
            if (compact?.proposalDetailsPage?.data?.jobPost) {
                delete compact.proposalDetailsPage.data.jobPost.jobPrompt;
            }
            if (compact?.jobPostPage?.data) {
                delete compact.jobPostPage.data.clientPastJobs;
            }

            if (compact?.proposal) {
                delete compact.proposal.screeningAnswers;
            }
            if (compact?.jobPost) {
                delete compact.jobPost.jobPrompt;
            }

            return compact;
        };

        const persistProposalRecord = async (proposalData, linkData) => {
            const storageUpdate = await chrome.storage.local.get('proposals');
            const proposals = Array.isArray(storageUpdate.proposals) ? storageUpdate.proposals : [];
            proposals.push(proposalData);

            let savedProposalData = proposalData;
            const updateLatestProposal = (nextRecord) => {
                savedProposalData = nextRecord;
                proposals[proposals.length - 1] = nextRecord;
            };

            try {
                await chrome.storage.local.set({ proposals });
                debugLog(
                    `[Proposal] ${linkData?.href || 'unknown-url'}: saved grouped payload by source pages ` +
                    '(sections=list,details,jobPost).'
                );
            } catch (storageError) {
                debugLog(
                    `[Proposal] ${linkData?.href || 'unknown-url'}: storage write failed with grouped cleaned payload ` +
                    `(${storageError?.message || 'unknown error'}). Retrying with compact payload.`
                );
                updateLatestProposal(buildCompactProposalData(savedProposalData));
                await chrome.storage.local.set({ proposals });
                debugLog(`[Proposal] ${linkData?.href || 'unknown-url'}: saved with compact grouped payload.`);
            }

            return savedProposalData;
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
                const domCoverLetter = extractCoverLetterFromDom(doc, linkData.href);
                const domAttachedHighlights = extractAttachedHighlightsFromDom(doc, linkData.href);
                const domConnectsSpent = extractProposalConnectsFromDom(doc, linkData.href);
                const proposalPageData = mergeDomProposalFields(
                    buildCleanNuxtData(rawNuxtData, linkData),
                    {
                        coverLetter: domCoverLetter,
                        attachedHighlights: domAttachedHighlights,
                        connectsSpent: domConnectsSpent
                    }
                );
                const pageDataSources = [];
                if (nuxtScript) {
                    pageDataSources.push('nuxt');
                }
                if (domCoverLetter || domAttachedHighlights || domConnectsSpent !== null) {
                    pageDataSources.push('dom');
                }
                const jobPostUrl = proposalPageData?.jobPost?.url || null;
                const jobPostFetchResult = await fetchJobPostRawData(jobPostUrl, linkData.href);
                const jobPostData = jobPostFetchResult?.data || null;
                const coverLetter = proposalPageData?.proposal?.coverLetter || null;
                const connectsSpent = proposalPageData?.proposal?.terms?.connectsSpent ?? null;
                const attachedHighlightsCount = Array.isArray(
                    proposalPageData?.proposal?.attachedHighlights?.items
                )
                    ? proposalPageData.proposal.attachedHighlights.items.length
                    : 0;
                const description = proposalPageData?.jobPost?.description || null;
                const isHired = /hired/i.test(String(linkData.reason || ''));

                debugLog(
                    `[Proposal] ${linkData.href}: extracted details -> description=${description ? description.length : 0} chars, ` +
                    `coverLetter=${coverLetter ? coverLetter.length : 0} chars, domCoverLetter=${domCoverLetter ? domCoverLetter.length : 0} chars, ` +
                    `attachedHighlights=${attachedHighlightsCount}, connectsSpent=${connectsSpent ?? 'none'}, pageDataSources=${pageDataSources.join('+') || 'none'}, ` +
                    `pageDataSections=${Object.keys(proposalPageData || {}).join(',') || 'none'}, ` +
                    `hasJobPostData=${!!jobPostData}, isHired=${isHired}`
                );

                const proposalData = {
                    proposalListPage: {
                        href: linkData.href,
                        text: linkData.text,
                        reason: linkData.reason,
                        submissionTime: linkData.submissionTime,
                        isHired
                    },
                    proposalDetailsPage: {
                        url: linkData.href,
                        pageData: proposalPageData,
                        pageDataSources
                    },
                    jobPostPage: {
                        url: jobPostUrl,
                        data: jobPostData
                    }
                };

                const savedProposalData = await persistProposalRecord(proposalData, linkData);

                return {
                    proposalData: savedProposalData,
                    description,
                    coverLetter
                };
            } catch (error) {
                recordError('proposal_visit_exception', {
                    message: error?.message || 'unexpected proposal visit failure',
                    sourceUrl: linkData?.href || 'unknown-url'
                });
                console.error('Error visiting proposal:', linkData?.href, error);
                return null;
            }
        };

        return {
            visitProposalPage
        };
    };

    globalThis.ProposalCopycatProposalDetailsPageModule = {
        createProposalDetailsScraper
    };
})();
