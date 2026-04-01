const INJECTED_SCRAPER_HELPER_FILES = [
    'sites/upwork/shared/upwork-run-status.js',
    'sites/upwork/injected/job-post-page.js',
    'sites/upwork/injected/proposal-details-page.js',
    'sites/upwork/injected/proposal-list-page.js',
    'sites/upwork/injected/proposal-scrape-run-state.js'
];
const MAIN_WORLD_SCRAPER_HELPER_FILES = [
    'sites/upwork/injected/proposals-network-monitor.js'
];
const FIND_WORK_INJECTED_HELPER_FILES = [
    'sites/upwork/injected/find-work-capture-bridge.js'
];
const FIND_WORK_MAIN_WORLD_HELPER_FILES = [
    'sites/upwork/injected/find-work-network-monitor.js'
];

const DEBUGGER_ENABLED_FOR_LIST_SCRAPE = true;
const DEBUGGER_PROTOCOL_VERSION = '1.3';
const DEBUGGER_TARGET_ORIGIN = 'https://www.upwork.com';
const DEBUGGER_TARGET_PATH = '/api/graphql/v1';
const DEBUGGER_LIST_ALIAS = 'gql-query-proposalsbytype';
const DEBUGGER_DETAILS_ALIAS = 'gql-query-get-auth-job-details';
const DEBUGGER_GRAPHQL_PATH_PREFIX = '/api/graphql/';
const DEBUGGER_LOG_PREFIX = '[ProposalCopycatDebugger]';
const DEBUGGER_VERBOSE_LOGS = false;
const DEBUGGER_DETAILS_RESPONSE_WAIT_MS = 12000;
const DEBUGGER_DETAILS_INTER_ITEM_DELAY_MS = 250;
const DEBUGGER_DETAILS_DOM_WAIT_MS = 4000;
const DEBUGGER_DETAILS_DOM_POLL_MS = 200;
const DEBUGGER_STOP_REQUESTED_ERROR_CODE = 'proposal_copycat_stop_requested';
const FIND_WORK_URL = 'https://www.upwork.com/nx/find-work';
const FIND_WORK_GRAPHQL_ALIAS = 'bestMatchRecommendationsFeed.retrieve';
const FIND_WORK_JOB_LIST_STORAGE_KEY = 'findWorkJobList';
const FIND_WORK_TRACKING_SESSION_STORAGE_KEY = 'upworkFindWorkTrackingSession';
const FIND_WORK_SOURCE_TAB = 'best-matches';
const FIND_WORK_SOURCE_LABEL = 'find-work-best-matches';
const FIND_WORK_LOG_PREFIX = '[ProposalCopycatFindWork]';

const upworkRunStatusModule = globalThis.ProposalCopycatUpworkRunStatusModule || {};
const UPWORK_RUN_STATUS_STORAGE_KEY = upworkRunStatusModule.RUN_STATUS_STORAGE_KEY || 'upworkRunStatus';
const UPWORK_RUN_CONTROL_STORAGE_KEY = upworkRunStatusModule.RUN_CONTROL_STORAGE_KEY || 'upworkRunControl';
const createUpworkRunStatusPayload = typeof upworkRunStatusModule.createRunStatusPayload === 'function'
    ? upworkRunStatusModule.createRunStatusPayload
    : (value) => ({ ...(value || {}) });
const getUpworkRunDescriptor = typeof upworkRunStatusModule.getRunDescriptor === 'function'
    ? upworkRunStatusModule.getRunDescriptor
    : (options = {}) => ({
        runKind: 'proposal-list',
        statusTitle: options?.scrapeMode === 'all' ? 'Collecting Proposals' : 'Collecting Successful Proposals',
        modeBadgeText: options?.scrapeMode === 'all' ? 'All Proposals' : 'Successful Only'
    });
const normalizeUpworkRunControl = typeof upworkRunStatusModule.normalizeRunControl === 'function'
    ? upworkRunStatusModule.normalizeRunControl
    : (value = {}) => ({
        paused: value?.paused === true,
        stopRequested: value?.stopRequested === true
    });

const debuggerSessions = new Map();
let debuggerListenersInstalled = false;
let proposalListWriteQueue = Promise.resolve();
let proposalDetailsWriteQueue = Promise.resolve();
let findWorkJobListWriteQueue = Promise.resolve();
let upworkRunStatusWriteQueue = Promise.resolve();

function isReasonAllowedForMode(reason, scrapeMode) {
    if (scrapeMode === 'all') {
        return true;
    }
    return String(reason || '').trim().toLowerCase() === 'hired';
}

function parseSubmissionTimestamp(value) {
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
}

function pickFirstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return '';
}

function toAbsoluteUpworkUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        return '';
    }

    try {
        return new URL(raw, DEBUGGER_TARGET_ORIGIN).href;
    } catch (error) {
        return '';
    }
}

function normalizeProposalReason(candidate) {
    if (!candidate || typeof candidate !== 'object') {
        return '';
    }

    if (candidate.hired === true || candidate.isHired === true || candidate.wasHired === true) {
        return 'Hired';
    }

    const rawReason = pickFirstString(
        candidate.reason,
        candidate.archiveReason,
        candidate.archivedReason,
        candidate.archiveStatus,
        candidate.status,
        candidate.applicationStatus,
        candidate.result,
        candidate.state,
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
}

function collectObjectNodes(root) {
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
}

function safeParseJsonPayload(rawText) {
    const text = String(rawText || '').replace(/^\)\]\}'\s*/, '').trim();
    if (!text) {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch (error) {
        return null;
    }
}

function decodeBodyForMatching(rawText) {
    const raw = String(rawText || '').trim();
    if (!raw) {
        return '';
    }

    const normalized = raw.replace(/\+/g, ' ');
    try {
        return decodeURIComponent(normalized);
    } catch (error) {
        return raw;
    }
}

function buildProposalEntryFromNode(node, scrapeMode, options = {}) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return null;
    }

    let href = toAbsoluteUpworkUrl(pickFirstString(
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
            href = toAbsoluteUpworkUrl(`/ab/proposals/${ciphertext}`);
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
            href = toAbsoluteUpworkUrl(`/nx/proposals/${applicationId}`);
        }
    }

    if (!href || !/upwork\.com/i.test(href) || !/\/proposals\//i.test(href)) {
        return null;
    }

    const reason = normalizeProposalReason(node) || 'Unknown';
    if (!isReasonAllowedForMode(reason, scrapeMode)) {
        return null;
    }

    const title = pickFirstString(
        node.title,
        node.jobTitle,
        node.proposalTitle,
        node.job?.title,
        node.opening?.title,
        node.jobPost?.title,
        node.proposal?.title
    ) || 'Untitled Proposal';

    const submissionTime = parseSubmissionTimestamp(
        node.submittedOn ??
        node.submittedAt ??
        node.submissionTime ??
        node.createdAt ??
        node.createdOn ??
        node.createdDate ??
        node.auditDetails?.createdDateTime ??
        node.auditDetails?.modifiedDateTime ??
        node.proposal?.submittedOn ??
        node.proposal?.submittedAt ??
        node.application?.submittedOn ??
        node.application?.submittedAt
    );

    return {
        href,
        text: title,
        reason,
        submissionTime,
        rawGraphql: options.includeRawNode ? node : undefined
    };
}

function extractProposalLinksFromGraphqlResponse(rawResponseText, scrapeMode) {
    const parsedResponse = safeParseJsonPayload(rawResponseText);
    if (!parsedResponse) {
        return [];
    }

    const links = [];
    const seen = new Set();
    const pushIfEligible = (node, includeRawNode = false) => {
        const entry = buildProposalEntryFromNode(node, scrapeMode, { includeRawNode });
        if (!entry) {
            return;
        }
        if (seen.has(entry.href)) {
            return;
        }
        seen.add(entry.href);
        links.push(entry);
    };

    const applications = parsedResponse?.data?.proposalsByType?.applications;
    if (Array.isArray(applications) && applications.length > 0) {
        for (const application of applications) {
            pushIfEligible(application, true);
        }
        if (links.length > 0) {
            return links;
        }
    }

    const objectNodes = collectObjectNodes(parsedResponse);
    for (const node of objectNodes) {
        pushIfEligible(node, false);
    }

    return links;
}

function isFindWorkPageUrl(urlValue) {
    return String(urlValue || '').startsWith(FIND_WORK_URL);
}

function extractFindWorkFeedPayload(rawResponseText) {
    const parsedResponse = safeParseJsonPayload(rawResponseText);
    if (!parsedResponse) {
        return null;
    }

    const buildPayloadFromCandidate = (candidate, payloadPath = '') => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
            return null;
        }

        const results = Array.isArray(candidate.results) ? candidate.results : [];
        if (!results.length) {
            return null;
        }

        const likelyResults = results.filter((item) => (
            item &&
            typeof item === 'object' &&
            !Array.isArray(item) &&
            pickFirstString(
                item.uid,
                item.jobUid,
                item.id,
                item.job?.uid,
                item.job?.id
            ) &&
            pickFirstString(
                item.ciphertext,
                item.jobCiphertext,
                item.job?.ciphertext,
                item.jobPostUrl,
                item.url,
                item.job?.url
            ) &&
            pickFirstString(
                item.title,
                item.jobTitle,
                item.job?.title
            )
        ));

        if (!likelyResults.length) {
            return null;
        }

        const responseContext = {
            resultsCount: results.length,
            matchedResultsCount: likelyResults.length,
            payloadPath
        };

        for (const [key, value] of Object.entries(candidate)) {
            if (key === 'results') {
                continue;
            }
            responseContext[key] = value;
        }

        return {
            results: likelyResults,
            responseContext
        };
    };

    const directPayload = buildPayloadFromCandidate(
        parsedResponse?.data?.bestMatchRecommendationsFeed || parsedResponse?.bestMatchRecommendationsFeed,
        'data.bestMatchRecommendationsFeed'
    );
    if (directPayload) {
        return directPayload;
    }

    const objectNodes = collectObjectNodes(parsedResponse);
    for (const node of objectNodes) {
        const candidatePayload = buildPayloadFromCandidate(node, 'fallback.results');
        if (candidatePayload) {
            return candidatePayload;
        }
    }

    return null;
}

function buildFindWorkCaptureContext(eventPayload, senderTab, responseContext, resultIndex) {
    const payload = eventPayload && typeof eventPayload === 'object' ? eventPayload : {};
    return {
        capturedAt: new Date(Number(payload.capturedAtMs) || Date.now()).toISOString(),
        requestStartedAt: new Date(Number(payload.requestStartedAtMs) || Number(payload.capturedAtMs) || Date.now()).toISOString(),
        transport: String(payload.transport || ''),
        sourceTab: FIND_WORK_SOURCE_TAB,
        tabId: Number.isFinite(Number(senderTab?.id)) ? Number(senderTab.id) : null,
        pageUrl: String(payload.pageUrl || senderTab?.url || '').trim(),
        pageTitle: String(payload.pageTitle || senderTab?.title || '').trim(),
        requestUrl: String(payload.url || '').trim(),
        requestMethod: String(payload.method || 'POST').trim().toUpperCase(),
        graphqlAlias: String(payload.graphqlAlias || aliasFromGraphqlUrl(payload.url) || '').trim(),
        responseStatus: Number.isFinite(Number(payload.status)) ? Number(payload.status) : null,
        matchReason: String(payload.matchReason || '').trim(),
        monitorSeq: Number.isFinite(Number(payload.monitorSeq)) ? Number(payload.monitorSeq) : null,
        resultIndex: Number.isFinite(Number(resultIndex)) ? Number(resultIndex) : null,
        responseContext: responseContext && typeof responseContext === 'object' ? responseContext : null
    };
}

function sanitizeFindWorkCaptureContext(context) {
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
        return null;
    }

    const sanitized = {
        capturedAt: String(context.capturedAt || '').trim(),
        requestStartedAt: String(context.requestStartedAt || '').trim(),
        transport: String(context.transport || '').trim(),
        sourceTab: String(context.sourceTab || '').trim(),
        tabId: Number.isFinite(Number(context.tabId)) ? Number(context.tabId) : null,
        pageUrl: String(context.pageUrl || '').trim(),
        pageTitle: String(context.pageTitle || '').trim(),
        requestUrl: String(context.requestUrl || '').trim(),
        requestMethod: String(context.requestMethod || '').trim().toUpperCase(),
        graphqlAlias: String(context.graphqlAlias || '').trim(),
        responseStatus: Number.isFinite(Number(context.responseStatus)) ? Number(context.responseStatus) : null,
        matchReason: String(context.matchReason || '').trim(),
        monitorSeq: Number.isFinite(Number(context.monitorSeq)) ? Number(context.monitorSeq) : null,
        resultIndex: Number.isFinite(Number(context.resultIndex)) ? Number(context.resultIndex) : null,
        responseContext: context.responseContext && typeof context.responseContext === 'object' && !Array.isArray(context.responseContext)
            ? context.responseContext
            : null
    };

    for (const [key, value] of Object.entries(sanitized)) {
        if (
            value === null ||
            value === '' ||
            value === undefined ||
            (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
        ) {
            delete sanitized[key];
        }
    }

    return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function buildFindWorkJobEntryFromNode(node, eventPayload, senderTab, responseContext, resultIndex) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return null;
    }

    const uid = pickFirstString(
        node.uid,
        node.jobUid,
        node.id,
        node.job?.uid,
        node.job?.id
    );
    if (!uid) {
        return null;
    }

    const ciphertext = pickFirstString(
        node.ciphertext,
        node.jobCiphertext,
        node.job?.ciphertext
    );
    const jobPostUrl = normalizeJobPostHref(pickFirstString(
        node.jobPostUrl,
        node.url,
        node.canonicalUrl,
        node.job?.url,
        node.job?.jobPostUrl,
        ciphertext
    ));
    const title = pickFirstString(
        node.title,
        node.jobTitle,
        node.job?.title
    ) || 'Untitled Job';
    const description = pickFirstString(
        node.description,
        node.jobDescription,
        node.job?.description
    );

    return {
        uid,
        ciphertext,
        jobPostUrl,
        title,
        description,
        source: FIND_WORK_SOURCE_LABEL,
        sourceTab: FIND_WORK_SOURCE_TAB,
        rawGraphql: node,
        captureContext: buildFindWorkCaptureContext(eventPayload, senderTab, responseContext, resultIndex)
    };
}

function buildFindWorkCaptureContextSignature(context) {
    const normalizedContext = sanitizeFindWorkCaptureContext(context) || {};
    const normalized = {
        sourceTab: String(normalizedContext.sourceTab || ''),
        pageUrl: String(normalizedContext.pageUrl || ''),
        requestUrl: String(normalizedContext.requestUrl || ''),
        requestMethod: String(normalizedContext.requestMethod || ''),
        graphqlAlias: String(normalizedContext.graphqlAlias || ''),
        resultIndex: Number.isFinite(Number(normalizedContext.resultIndex)) ? Number(normalizedContext.resultIndex) : null,
        responseContext: normalizedContext.responseContext || null
    };

    try {
        return JSON.stringify(normalized);
    } catch (error) {
        return [
            normalized.sourceTab,
            normalized.pageUrl,
            normalized.requestUrl,
            normalized.requestMethod,
            normalized.graphqlAlias,
            String(normalized.resultIndex ?? '')
        ].join('|');
    }
}

function mergeFindWorkCaptureContexts(existingContexts, incomingContext) {
    const merged = Array.isArray(existingContexts)
        ? existingContexts
            .map((entry) => sanitizeFindWorkCaptureContext(entry))
            .filter(Boolean)
        : [];
    const sanitizedIncomingContext = sanitizeFindWorkCaptureContext(incomingContext);
    if (!sanitizedIncomingContext) {
        return merged;
    }

    const incomingSignature = buildFindWorkCaptureContextSignature(sanitizedIncomingContext);
    const existingIndex = merged.findIndex((entry) => (
        buildFindWorkCaptureContextSignature(entry) === incomingSignature
    ));

    if (existingIndex >= 0) {
        merged[existingIndex] = {
            ...merged[existingIndex],
            ...sanitizedIncomingContext
        };
        return merged;
    }

    merged.push(sanitizedIncomingContext);
    return merged;
}

function isTargetGraphqlRequestUrl(urlValue) {
    try {
        const url = new URL(String(urlValue || ''), DEBUGGER_TARGET_ORIGIN);
        return (
            url.origin === DEBUGGER_TARGET_ORIGIN &&
            url.pathname === DEBUGGER_TARGET_PATH &&
            url.searchParams.get('alias') === DEBUGGER_LIST_ALIAS
        );
    } catch (error) {
        return false;
    }
}

function isTargetDetailsGraphqlRequestUrl(urlValue) {
    try {
        const url = new URL(String(urlValue || ''), DEBUGGER_TARGET_ORIGIN);
        return (
            url.origin === DEBUGGER_TARGET_ORIGIN &&
            url.pathname === DEBUGGER_TARGET_PATH &&
            url.searchParams.get('alias') === DEBUGGER_DETAILS_ALIAS
        );
    } catch (error) {
        return false;
    }
}

function isGraphqlRequestUrl(urlValue) {
    try {
        const url = new URL(String(urlValue || ''), DEBUGGER_TARGET_ORIGIN);
        return (
            url.origin === DEBUGGER_TARGET_ORIGIN &&
            String(url.pathname || '').includes(DEBUGGER_GRAPHQL_PATH_PREFIX)
        );
    } catch (error) {
        return false;
    }
}

function isLikelyProposalsGraphqlRequest(urlValue, postDataValue) {
    const urlText = String(urlValue || '').toLowerCase();
    const postData = String(postDataValue || '').toLowerCase();
    return (
        urlText.includes('proposalsbytype') ||
        urlText.includes('gql-query-proposalsbytype') ||
        postData.includes('proposalsbytype') ||
        postData.includes('gql-query-proposalsbytype')
    );
}

function isLikelyProposalDetailsGraphqlRequest(urlValue, postDataValue) {
    const urlText = String(urlValue || '').toLowerCase();
    const postData = String(postDataValue || '').toLowerCase();
    return (
        urlText.includes('get-auth-job-details') ||
        urlText.includes(DEBUGGER_DETAILS_ALIAS) ||
        postData.includes('get-auth-job-details') ||
        postData.includes(DEBUGGER_DETAILS_ALIAS)
    );
}

function aliasFromGraphqlUrl(urlValue) {
    try {
        const url = new URL(String(urlValue || ''), DEBUGGER_TARGET_ORIGIN);
        return String(url.searchParams.get('alias') || '').trim();
    } catch (error) {
        return '';
    }
}

function shortPathFromUrl(urlValue) {
    try {
        return new URL(String(urlValue || ''), DEBUGGER_TARGET_ORIGIN).pathname || '';
    } catch (error) {
        return '';
    }
}

function decodeDebuggerResponseBody(responseBodyResult) {
    const body = String(responseBodyResult?.body || '');
    if (!body) {
        return '';
    }

    if (!responseBodyResult?.base64Encoded) {
        return body;
    }

    try {
        return atob(body);
    } catch (error) {
        return '';
    }
}

function debuggerAttach(tabId) {
    return new Promise((resolve, reject) => {
        chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION, () => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve();
        });
    });
}

function debuggerDetach(tabId) {
    return new Promise((resolve, reject) => {
        chrome.debugger.detach({ tabId }, () => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve();
        });
    });
}

function debuggerSendCommand(source, command, params = {}) {
    return new Promise((resolve, reject) => {
        chrome.debugger.sendCommand(source, command, params, (result) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(result || {});
        });
    });
}

function queueProposalListUpsert(entries, sourceLabel) {
    proposalListWriteQueue = proposalListWriteQueue
        .then(() => upsertProposalListEntries(entries, sourceLabel))
        .catch((error) => {
            console.warn(`${DEBUGGER_LOG_PREFIX} failed to upsert proposal list:`, error);
        });
    return proposalListWriteQueue;
}

function queueProposalDetailsUpsert(detailEntry, sourceLabel) {
    proposalDetailsWriteQueue = proposalDetailsWriteQueue
        .then(() => upsertProposalDetailsEntry(detailEntry, sourceLabel))
        .catch((error) => {
            console.warn(`${DEBUGGER_LOG_PREFIX} failed to upsert proposal details:`, error);
            return null;
        });
    return proposalDetailsWriteQueue;
}

function queueFindWorkJobListUpsert(entries, sourceLabel) {
    findWorkJobListWriteQueue = findWorkJobListWriteQueue
        .then(() => upsertFindWorkJobEntries(entries, sourceLabel))
        .catch((error) => {
            console.warn(`${DEBUGGER_LOG_PREFIX} failed to upsert find-work jobs:`, error);
            return null;
        });
    return findWorkJobListWriteQueue;
}

function queueUpworkRunStatusUpdate(update, options = {}) {
    upworkRunStatusWriteQueue = upworkRunStatusWriteQueue
        .then(async () => {
            const reset = options?.reset === true;
            const storage = await chrome.storage.local.get(UPWORK_RUN_STATUS_STORAGE_KEY);
            const previous = reset
                ? {}
                : (storage?.[UPWORK_RUN_STATUS_STORAGE_KEY] && typeof storage[UPWORK_RUN_STATUS_STORAGE_KEY] === 'object'
                    ? storage[UPWORK_RUN_STATUS_STORAGE_KEY]
                    : {});
            const nextStatus = createUpworkRunStatusPayload({
                ...previous,
                ...(update || {})
            });
            await chrome.storage.local.set({ [UPWORK_RUN_STATUS_STORAGE_KEY]: nextStatus });
            return nextStatus;
        })
        .catch((error) => {
            console.warn(`${DEBUGGER_LOG_PREFIX} failed to update Upwork run status:`, error);
            return null;
        });
    return upworkRunStatusWriteQueue;
}

async function setUpworkRunControlState(nextControl = {}) {
    const normalizedControl = normalizeUpworkRunControl(nextControl);
    await chrome.storage.local.set({
        [UPWORK_RUN_CONTROL_STORAGE_KEY]: {
            ...normalizedControl,
            updatedAt: new Date().toISOString()
        }
    });
    return normalizedControl;
}

async function getUpworkRunControlState() {
    const storage = await chrome.storage.local.get(UPWORK_RUN_CONTROL_STORAGE_KEY);
    return normalizeUpworkRunControl(storage?.[UPWORK_RUN_CONTROL_STORAGE_KEY]);
}

async function getFindWorkTrackingSession() {
    const storage = await chrome.storage.local.get(FIND_WORK_TRACKING_SESSION_STORAGE_KEY);
    const session = storage?.[FIND_WORK_TRACKING_SESSION_STORAGE_KEY];
    if (!session || typeof session !== 'object') {
        return null;
    }
    return session;
}

function createDebuggerStopRequestedError() {
    const error = new Error('Stopped from the side panel.');
    error.code = DEBUGGER_STOP_REQUESTED_ERROR_CODE;
    return error;
}

function isDebuggerStopRequestedError(error) {
    return error?.code === DEBUGGER_STOP_REQUESTED_ERROR_CODE;
}

async function waitForDebuggerRunControl(lastActiveAction) {
    let control = await getUpworkRunControlState();
    if (control.stopRequested) {
        await queueUpworkRunStatusUpdate({
            action: 'Stopping after current step...',
            stopRequested: true,
            isPaused: false
        });
        throw createDebuggerStopRequestedError();
    }

    if (!control.paused) {
        await queueUpworkRunStatusUpdate({
            action: lastActiveAction,
            stopRequested: false,
            isPaused: false
        });
        return control;
    }

    await queueUpworkRunStatusUpdate({
        action: 'Paused',
        isPaused: true,
        stopRequested: false
    });

    while (control.paused) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        control = await getUpworkRunControlState();
        if (control.stopRequested) {
            await queueUpworkRunStatusUpdate({
                action: 'Stopping after current step...',
                stopRequested: true,
                isPaused: false
            });
            throw createDebuggerStopRequestedError();
        }
    }

    await queueUpworkRunStatusUpdate({
        action: lastActiveAction,
        isPaused: false,
        stopRequested: false
    });
    return control;
}

async function upsertProposalListEntries(entries, sourceLabel = 'debugger') {
    const normalizedEntries = Array.isArray(entries) ? entries : [];
    if (!normalizedEntries.length) {
        return { upsertedCount: 0, totalSize: 0 };
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
    for (const item of normalizedEntries) {
        const href = String(item?.href || '').trim();
        if (!href) {
            continue;
        }

        const previous = listByHref.get(href) || {};
        listByHref.set(href, {
            ...previous,
            href,
            text: item?.text || previous.text || '',
            reason: item?.reason || previous.reason || '',
            submissionTime: item?.submissionTime ?? previous.submissionTime ?? null,
            rawGraphql: (
                item?.rawGraphql !== undefined
                    ? item.rawGraphql
                    : (previous.rawGraphql ?? null)
            ),
            scrapedAt: scrapedAtIso,
            source: sourceLabel
        });
        upsertedCount += 1;
    }

    await chrome.storage.local.set({ proposalList: Array.from(listByHref.values()) });
    return {
        upsertedCount,
        totalSize: listByHref.size
    };
}

async function upsertFindWorkJobEntries(entries, sourceLabel = FIND_WORK_SOURCE_LABEL) {
    const normalizedEntries = Array.isArray(entries) ? entries : [];
    if (!normalizedEntries.length) {
        return {
            upsertedCount: 0,
            insertedCount: 0,
            updatedCount: 0,
            totalSize: 0
        };
    }

    const storageUpdate = await chrome.storage.local.get(FIND_WORK_JOB_LIST_STORAGE_KEY);
    const existingList = Array.isArray(storageUpdate[FIND_WORK_JOB_LIST_STORAGE_KEY])
        ? storageUpdate[FIND_WORK_JOB_LIST_STORAGE_KEY]
        : [];
    const listByUid = new Map();

    for (const entry of existingList) {
        const uid = String(entry?.uid || '').trim();
        if (uid) {
            listByUid.set(uid, entry);
        }
    }

    const scrapedAtIso = new Date().toISOString();
    let upsertedCount = 0;
    let insertedCount = 0;
    let updatedCount = 0;

    for (const item of normalizedEntries) {
        const uid = String(item?.uid || '').trim();
        if (!uid) {
            continue;
        }

        const previous = listByUid.get(uid) || {};
        const hadExisting = listByUid.has(uid);
        const mergedCaptureContexts = mergeFindWorkCaptureContexts(previous.captureContexts, item?.captureContext);

        listByUid.set(uid, {
            ...previous,
            uid,
            ciphertext: String(item?.ciphertext || previous.ciphertext || '').trim(),
            jobPostUrl: String(item?.jobPostUrl || previous.jobPostUrl || '').trim(),
            title: String(item?.title || previous.title || '').trim(),
            description: String(item?.description || previous.description || '').trim(),
            source: String(item?.source || previous.source || sourceLabel || FIND_WORK_SOURCE_LABEL).trim(),
            sourceTab: String(item?.sourceTab || previous.sourceTab || FIND_WORK_SOURCE_TAB).trim(),
            firstScrapedAt: previous.firstScrapedAt || scrapedAtIso,
            scrapedAt: scrapedAtIso,
            rawGraphql: (
                item?.rawGraphql !== undefined
                    ? item.rawGraphql
                    : (previous.rawGraphql ?? null)
            ),
            captureContexts: mergedCaptureContexts
        });

        upsertedCount += 1;
        if (hadExisting) {
            updatedCount += 1;
        } else {
            insertedCount += 1;
        }
    }

    await chrome.storage.local.set({
        [FIND_WORK_JOB_LIST_STORAGE_KEY]: Array.from(listByUid.values())
    });

    return {
        upsertedCount,
        insertedCount,
        updatedCount,
        totalSize: listByUid.size
    };
}

function extractExistingProposalHref(entry) {
    return String(
        entry?.proposalDetailsPage?.url ||
        entry?.proposalListPage?.href ||
        entry?.proposal?.proposalUrl ||
        entry?.href ||
        ''
    ).trim();
}

function normalizeLinkData(linkData) {
    const href = String(linkData?.href || '').trim();
    if (!href) {
        return null;
    }
    return {
        href,
        text: String(linkData?.text || '').trim(),
        reason: String(linkData?.reason || '').trim(),
        submissionTime: linkData?.submissionTime ?? null
    };
}

function normalizeJobPostHref(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) {
        return '';
    }

    if (/^https?:\/\//i.test(value)) {
        return value;
    }

    if (/^\/jobs\//i.test(value)) {
        return `${DEBUGGER_TARGET_ORIGIN}${value}`;
    }

    if (/^~0\d+/.test(value)) {
        return `${DEBUGGER_TARGET_ORIGIN}/jobs/${value}`;
    }

    return '';
}

function deriveCiphertextFromOpeningId(rawValue) {
    const value = String(rawValue || '').trim();
    if (!/^\d{8,}$/.test(value)) {
        return '';
    }
    return `~02${value}`;
}

function collectJobPostHrefCandidatesFromDetailsPayload(rawGraphql) {
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
        .map((value) => deriveCiphertextFromOpeningId(value))
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
}

function extractJobPostHrefFromDetailsPayload(rawGraphql) {
    const candidates = collectJobPostHrefCandidatesFromDetailsPayload(rawGraphql);
    for (const candidate of candidates) {
        const normalized = normalizeJobPostHref(candidate);
        if (normalized) {
            return normalized;
        }
    }

    return '';
}

function maybeSetNestedJobUrl(data, jobUrl) {
    if (!data || typeof data !== 'object' || !jobUrl) {
        return data;
    }
    if (!data.jobPost || typeof data.jobPost !== 'object') {
        return data;
    }
    return {
        ...data,
        jobPost: {
            ...data.jobPost,
            url: jobUrl
        }
    };
}

function normalizeMergedProposalTerms(terms) {
    const normalizedTerms = terms && typeof terms === 'object' && !Array.isArray(terms)
        ? { ...terms }
        : {};
    let pricingType = String(normalizedTerms.pricingType || '').trim().toLowerCase();

    if (!pricingType) {
        if (
            normalizedTerms.proposedRate !== undefined ||
            normalizedTerms.proposedRateDisplay ||
            /\/\s*hr\b/i.test(String(normalizedTerms.estimatedReceiveDisplay || ''))
        ) {
            pricingType = 'hourly';
        } else if (
            normalizedTerms.proposedTotalPrice !== undefined ||
            normalizedTerms.proposedTotalPriceDisplay ||
            /by project/i.test(String(normalizedTerms.paymentMethod || ''))
        ) {
            pricingType = 'fixed-price';
        }
    }

    if (pricingType === 'hourly') {
        normalizedTerms.pricingType = 'hourly';
        delete normalizedTerms.paymentMethod;
        delete normalizedTerms.proposedTotalPrice;
        delete normalizedTerms.proposedTotalPriceDisplay;
    } else if (pricingType === 'fixed-price') {
        normalizedTerms.pricingType = 'fixed-price';
        delete normalizedTerms.proposedRate;
        delete normalizedTerms.proposedRateDisplay;
    }

    return normalizedTerms;
}

function mergeProposalDetailsPageData(existingData, incomingData, jobUrl = '') {
    const baseData = existingData && typeof existingData === 'object'
        ? { ...existingData }
        : {};
    const nextData = incomingData && typeof incomingData === 'object'
        ? incomingData
        : null;

    const mergeSection = (sectionKey) => {
        const existingSection = baseData?.[sectionKey];
        const incomingSection = nextData?.[sectionKey];
        const hasExistingSection = existingSection && typeof existingSection === 'object' && !Array.isArray(existingSection);
        const hasIncomingSection = incomingSection && typeof incomingSection === 'object' && !Array.isArray(incomingSection);

        if (!hasExistingSection && !hasIncomingSection) {
            return;
        }

        baseData[sectionKey] = {
            ...(hasExistingSection ? existingSection : {}),
            ...(hasIncomingSection ? incomingSection : {})
        };
    };

    mergeSection('freelancer');
    mergeSection('client');
    mergeSection('jobPost');
    mergeSection('proposal');

    if (
        baseData?.proposal &&
        typeof baseData.proposal === 'object' &&
        !Array.isArray(baseData.proposal)
    ) {
        const existingTerms = existingData?.proposal?.terms;
        const incomingTerms = nextData?.proposal?.terms;
        const hasExistingTerms = existingTerms && typeof existingTerms === 'object' && !Array.isArray(existingTerms);
        const hasIncomingTerms = incomingTerms && typeof incomingTerms === 'object' && !Array.isArray(incomingTerms);

        if (hasExistingTerms || hasIncomingTerms) {
            baseData.proposal = {
                ...baseData.proposal,
                terms: normalizeMergedProposalTerms({
                    ...(hasExistingTerms ? existingTerms : {}),
                    ...(hasIncomingTerms ? incomingTerms : {})
                })
            };
        }
    }

    for (const key of Object.keys(baseData)) {
        const value = baseData[key];
        if (
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.keys(value).length === 0
        ) {
            delete baseData[key];
        }
    }

    const withJobUrl = maybeSetNestedJobUrl(baseData, jobUrl);
    return withJobUrl && Object.keys(withJobUrl).length > 0 ? withJobUrl : null;
}

async function repairSavedJobPostUrls() {
    const storageData = await chrome.storage.local.get(['proposalList', 'proposals', 'jobPosts']);
    const proposalList = Array.isArray(storageData.proposalList) ? storageData.proposalList : [];
    const proposals = Array.isArray(storageData.proposals) ? storageData.proposals : [];
    const jobPosts = Array.isArray(storageData.jobPosts) ? storageData.jobPosts : [];

    if (!proposals.length) {
        return {
            proposalListCount: proposalList.length,
            proposalsCount: 0,
            proposalsWithRawGraphql: 0,
            proposalsUpdated: 0,
            proposalsDerivedUrlMissing: 0,
            uniqueJobUrlsAfterRepair: 0,
            jobPostsUpdated: 0
        };
    }

    let proposalsWithRawGraphql = 0;
    let proposalsUpdated = 0;
    let proposalsDerivedUrlMissing = 0;
    const proposalUrlFixes = new Map();
    const repairedProposals = proposals.map((entry) => {
        const rawGraphql = entry?.proposalDetailsPage?.rawGraphql;
        if (rawGraphql != null) {
            proposalsWithRawGraphql += 1;
        }

        const derivedJobUrl = extractJobPostHrefFromDetailsPayload(rawGraphql);
        if (!derivedJobUrl) {
            proposalsDerivedUrlMissing += 1;
            return entry;
        }

        const currentDetailsUrl = normalizeJobPostHref(entry?.proposalDetailsPage?.jobPostHref);
        const currentJobPageUrl = normalizeJobPostHref(entry?.jobPostPage?.url);
        const needsUpdate = currentDetailsUrl !== derivedJobUrl || currentJobPageUrl !== derivedJobUrl;
        if (!needsUpdate) {
            return entry;
        }

        proposalsUpdated += 1;
        const proposalHref = extractExistingProposalHref(entry);
        if (proposalHref) {
            proposalUrlFixes.set(proposalHref, derivedJobUrl);
        }

        return {
            ...entry,
            proposalDetailsPage: {
                ...(entry?.proposalDetailsPage || {}),
                jobPostHref: derivedJobUrl
            },
            jobPostPage: {
                ...(entry?.jobPostPage || {}),
                url: derivedJobUrl
            }
        };
    });

    if (proposalsUpdated > 0) {
        await chrome.storage.local.set({ proposals: repairedProposals });
    }

    let jobPostsUpdated = 0;
    if (jobPosts.length > 0 && proposalUrlFixes.size > 0) {
        const repairedJobPosts = jobPosts.map((entry) => {
            const sourceProposalUrl = String(entry?.sourcePageUrl || '').trim();
            const derivedJobUrl = proposalUrlFixes.get(sourceProposalUrl);
            if (!derivedJobUrl) {
                return entry;
            }

            const currentJobPageUrl = normalizeJobPostHref(entry?.jobPostPage?.url || entry?.sourcePageUrl);
            if (currentJobPageUrl === derivedJobUrl) {
                return entry;
            }

            jobPostsUpdated += 1;
            return {
                ...entry,
                jobPostPage: {
                    ...(entry?.jobPostPage || {}),
                    url: derivedJobUrl,
                    data: maybeSetNestedJobUrl(entry?.jobPostPage?.data, derivedJobUrl)
                }
            };
        });

        if (jobPostsUpdated > 0) {
            await chrome.storage.local.set({ jobPosts: repairedJobPosts });
        }
    }

    const uniqueJobUrls = new Set(
        repairedProposals
            .map((entry) => normalizeJobPostHref(entry?.jobPostPage?.url || entry?.proposalDetailsPage?.jobPostHref))
            .filter(Boolean)
    );

    return {
        proposalListCount: proposalList.length,
        proposalsCount: proposals.length,
        proposalsWithRawGraphql,
        proposalsUpdated,
        proposalsDerivedUrlMissing,
        uniqueJobUrlsAfterRepair: uniqueJobUrls.size,
        jobPostsUpdated
    };
}

function isQuotaExceededError(error) {
    const message = String(error?.message || error || '');
    return /quota|QUOTA_BYTES|QUOTA_BYTES_PER_ITEM/i.test(message);
}

function getScrapedAtMs(entry) {
    const asMs = Date.parse(String(entry?.scrapedAt || ''));
    return Number.isFinite(asMs) ? asMs : 0;
}

async function writeProposalsWithQuotaGuard(proposals) {
    try {
        await chrome.storage.local.set({ proposals });
        return { droppedRawCount: 0 };
    } catch (error) {
        if (!isQuotaExceededError(error)) {
            throw error;
        }
    }

    const working = Array.isArray(proposals) ? proposals : [];
    const indicesByOldest = working
        .map((entry, index) => ({ index, scrapedAtMs: getScrapedAtMs(entry) }))
        .sort((a, b) => a.scrapedAtMs - b.scrapedAtMs)
        .map((item) => item.index);

    let droppedRawCount = 0;
    for (const index of indicesByOldest) {
        const entry = working[index];
        if (!entry?.proposalDetailsPage || entry.proposalDetailsPage.rawGraphql == null) {
            continue;
        }

        entry.proposalDetailsPage = {
            ...entry.proposalDetailsPage,
            rawGraphql: null,
            rawGraphqlDropped: true,
            rawGraphqlDroppedAt: new Date().toISOString()
        };
        droppedRawCount += 1;

        if (droppedRawCount % 10 !== 0) {
            continue;
        }

        try {
            await chrome.storage.local.set({ proposals: working });
            return { droppedRawCount };
        } catch (error) {
            if (!isQuotaExceededError(error)) {
                throw error;
            }
        }
    }

    await chrome.storage.local.set({ proposals: working });
    return { droppedRawCount };
}

async function upsertProposalDetailsEntry(detailEntry, sourceLabel = 'debugger:details') {
    const normalized = normalizeLinkData(detailEntry);
    if (!normalized) {
        return null;
    }

    const storageUpdate = await chrome.storage.local.get('proposals');
    const proposals = Array.isArray(storageUpdate.proposals) ? storageUpdate.proposals : [];
    const href = normalized.href;
    const existingIndex = proposals.findIndex((entry) => extractExistingProposalHref(entry) === href);
    const existingRecord = existingIndex >= 0 ? (proposals[existingIndex] || {}) : {};
    const scrapedAtIso = new Date().toISOString();
    const isHired = /hired/i.test(String(normalized.reason || ''));
    const hasIncomingRawGraphql = !!(
        detailEntry &&
        Object.prototype.hasOwnProperty.call(detailEntry, 'rawGraphql')
    );
    const rawGraphql = hasIncomingRawGraphql
        ? detailEntry.rawGraphql
        : (existingRecord?.proposalDetailsPage?.rawGraphql ?? null);
    const extractedJobPostHref = extractJobPostHrefFromDetailsPayload(rawGraphql);
    const incomingPageData = detailEntry?.pageData || detailEntry?.data || null;
    const mergedPageData = mergeProposalDetailsPageData(
        existingRecord?.proposalDetailsPage?.pageData || existingRecord?.proposalDetailsPage?.data,
        incomingPageData,
        extractedJobPostHref || existingRecord?.proposalDetailsPage?.jobPostHref || ''
    );
    const hasMergedPageData = !!(
        mergedPageData &&
        typeof mergedPageData === 'object' &&
        Object.keys(mergedPageData).length > 0
    );
    const hasExistingDebuggerCapture = /debugger-graphql/i.test(
        String(existingRecord?.proposalDetailsPage?.captureMethod || '')
    ) || rawGraphql != null;
    const hasIncomingPageData = !!incomingPageData;
    const pageDataSources = Array.from(new Set([
        ...(
            Array.isArray(existingRecord?.proposalDetailsPage?.pageDataSources)
                ? existingRecord.proposalDetailsPage.pageDataSources
                : []
        ),
        ...(hasIncomingPageData ? ['dom'] : [])
    ]));
    const captureMethod = hasIncomingRawGraphql
        ? (hasMergedPageData ? 'debugger-graphql+page' : 'debugger-graphql')
        : (
            hasIncomingPageData && hasExistingDebuggerCapture
                ? 'debugger-graphql+page'
                : (
                    existingRecord?.proposalDetailsPage?.captureMethod ||
                    (hasMergedPageData ? 'page' : 'debugger-graphql')
                )
        );
    const nextProposalDetailsPage = {
        ...(existingRecord.proposalDetailsPage || {}),
        url: href,
        rawGraphql,
        graphqlAlias: DEBUGGER_DETAILS_ALIAS,
        source: hasIncomingRawGraphql
            ? sourceLabel
            : (existingRecord?.proposalDetailsPage?.source || sourceLabel),
        capturedAt: hasIncomingRawGraphql
            ? scrapedAtIso
            : (existingRecord?.proposalDetailsPage?.capturedAt || scrapedAtIso),
        captureMethod,
        jobPostHref: extractedJobPostHref || existingRecord?.proposalDetailsPage?.jobPostHref || null
    };
    delete nextProposalDetailsPage.data;
    delete nextProposalDetailsPage.domSupplementedAt;
    delete nextProposalDetailsPage.domSupplementalSource;

    if (hasMergedPageData) {
        nextProposalDetailsPage.pageData = mergedPageData;
    }
    if (pageDataSources.length > 0) {
        nextProposalDetailsPage.pageDataSources = pageDataSources;
    }
    if (incomingPageData) {
        nextProposalDetailsPage.pageDataUpdatedAt = scrapedAtIso;
        nextProposalDetailsPage.pageDataLastSource = sourceLabel;
    }

    const nextRecord = {
        ...existingRecord,
        scrapedAt: scrapedAtIso,
        proposalListPage: {
            ...(existingRecord.proposalListPage || {}),
            href,
            text: normalized.text || existingRecord?.proposalListPage?.text || '',
            reason: normalized.reason || existingRecord?.proposalListPage?.reason || '',
            submissionTime: normalized.submissionTime ?? existingRecord?.proposalListPage?.submissionTime ?? null,
            isHired: (
                existingRecord?.proposalListPage?.isHired !== undefined
                    ? existingRecord.proposalListPage.isHired
                    : isHired
            )
        },
        proposalDetailsPage: nextProposalDetailsPage,
        jobPostPage: {
            ...(existingRecord.jobPostPage || {}),
            url: extractedJobPostHref || existingRecord?.jobPostPage?.url || null
        }
    };

    if (existingIndex >= 0) {
        proposals[existingIndex] = nextRecord;
    } else {
        proposals.push(nextRecord);
    }

    const writeResult = await writeProposalsWithQuotaGuard(proposals);
    if (writeResult?.droppedRawCount > 0) {
        console.warn(
            `${DEBUGGER_LOG_PREFIX} quota guard dropped rawGraphql from ${writeResult.droppedRawCount} older proposal record(s).`
        );
    }
    return {
        updated: existingIndex >= 0,
        totalSize: proposals.length,
        href,
        droppedRawCount: writeResult?.droppedRawCount || 0
    };
}

function setActiveDetailContext(tabId, linkData) {
    const session = debuggerSessions.get(tabId);
    if (!session) {
        return;
    }
    const normalized = normalizeLinkData(linkData);
    if (!normalized) {
        return;
    }
    session.activeDetailContext = {
        ...normalized,
        startedAtMs: Date.now()
    };
}

function clearActiveDetailContext(tabId) {
    const session = debuggerSessions.get(tabId);
    if (!session) {
        return;
    }
    session.activeDetailContext = null;
}

function resolveDetailCaptureWaiters(session, href, detailPayload) {
    if (!session || !href) {
        return;
    }

    session.capturedDetailHrefs.add(href);
    for (let index = 0; index < session.detailCaptureWaiters.length; index += 1) {
        const waiter = session.detailCaptureWaiters[index];
        if (waiter.href !== href) {
            continue;
        }
        clearTimeout(waiter.timeoutId);
        session.detailCaptureWaiters.splice(index, 1);
        index -= 1;
        waiter.resolve(detailPayload || null);
    }
}

function waitForDetailCapture(tabId, href, timeoutMs = DEBUGGER_DETAILS_RESPONSE_WAIT_MS) {
    const session = debuggerSessions.get(tabId);
    if (!session || !href) {
        return Promise.resolve(null);
    }

    if (session.capturedDetailHrefs.has(href)) {
        session.capturedDetailHrefs.delete(href);
        return Promise.resolve({ href, fromBuffer: true });
    }

    return new Promise((resolve) => {
        const waiter = {
            href,
            resolve,
            timeoutId: null
        };
        waiter.timeoutId = setTimeout(() => {
            const waiterIndex = session.detailCaptureWaiters.indexOf(waiter);
            if (waiterIndex >= 0) {
                session.detailCaptureWaiters.splice(waiterIndex, 1);
            }
            resolve(null);
        }, timeoutMs);

        session.detailCaptureWaiters.push(waiter);
    });
}

async function logDebuggerToTab(tabId, message) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: (msg) => console.log(msg),
            args: [message]
        });
    } catch (error) {
        // Ignore tab-console mirror failures.
    }
}

async function extractProposalDomSupplementalData(tabId, href = '') {
    try {
        const executionResults = await chrome.scripting.executeScript({
            target: { tabId },
            func: async (options = {}) => {
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

                const parseMoneyAmount = (value) => {
                    const normalized = normalizeInlineText(value);
                    if (!normalized) {
                        return null;
                    }

                    const match = normalized.match(/-?\d[\d,]*(?:\.\d+)?/);
                    if (!match) {
                        return null;
                    }

                    const parsed = Number.parseFloat(match[0].replace(/,/g, ''));
                    return Number.isFinite(parsed) ? parsed : null;
                };

                const normalizeResolvedUrl = (href) => {
                    const normalizedHref = normalizeInlineText(href);
                    if (!normalizedHref) {
                        return null;
                    }

                    try {
                        return new URL(normalizedHref, window.location.href).href;
                    } catch (error) {
                        return normalizedHref;
                    }
                };

                const extractTermsBlockValue = (block) => {
                    if (!block) {
                        return null;
                    }

                    const candidates = Array.from(
                        block.querySelectorAll('.text-body, .text-body-sm, p.rate')
                    )
                        .map((node) => normalizeInlineText(node.textContent))
                        .filter(Boolean);
                    if (candidates.length > 0) {
                        return candidates[candidates.length - 1];
                    }

                    const clonedBlock = block.cloneNode(true);
                    clonedBlock.querySelector('strong')?.remove();
                    return normalizeInlineText(clonedBlock.textContent || '');
                };

                const extractShortestMatchingText = (root, pattern) => {
                    if (!root) {
                        return null;
                    }

                    const uniqueMatches = Array.from(root.querySelectorAll('*'))
                        .map((node) => normalizeInlineText(node.textContent))
                        .filter((text, index, allTexts) => (
                            !!text &&
                            pattern.test(text) &&
                            allTexts.indexOf(text) === index
                        ))
                        .sort((left, right) => left.length - right.length);

                    return uniqueMatches[0] || null;
                };

                const selectBestScoredCandidate = (candidates = []) => candidates.reduce((best, candidate) => {
                    if (!candidate) {
                        return best;
                    }

                    if (!best || Number(candidate.score) > Number(best.score)) {
                        return candidate;
                    }

                    return best;
                }, null);

                const parseProposalPricingTermsSection = (pricingSection) => {
                    if (!pricingSection) {
                        return null;
                    }

                    const extractedTerms = {};
                    let inferredPricingType = null;
                    let score = 0;
                    const termBlocks = Array.from(pricingSection.children)
                        .filter((node) => node?.nodeType === 1 && node.tagName !== 'HR');

                    for (const block of termBlocks) {
                        const label = normalizeInlineText(block.querySelector('strong')?.textContent || '');
                        const valueText = extractTermsBlockValue(block);
                        if (!label || !valueText) {
                            continue;
                        }

                        switch (label.toLowerCase()) {
                            case 'hourly rate':
                                {
                                    inferredPricingType = 'hourly';
                                    const proposedRate = parseMoneyAmount(valueText);
                                    if (proposedRate !== null) {
                                        extractedTerms.proposedRate = proposedRate;
                                    }
                                    extractedTerms.proposedRateDisplay = valueText;
                                    score += 4;
                                    if (/\/\s*hr\b/i.test(valueText)) {
                                        score += 2;
                                    }
                                }
                                break;
                            case 'total price of project':
                                {
                                    inferredPricingType = 'fixed-price';
                                    const proposedTotalPrice = parseMoneyAmount(valueText);
                                    if (proposedTotalPrice !== null) {
                                        extractedTerms.proposedTotalPrice = proposedTotalPrice;
                                    }
                                    extractedTerms.proposedTotalPriceDisplay = valueText;
                                    score += 4;
                                }
                                break;
                            case 'how do you want to be paid?':
                                extractedTerms.paymentMethod = valueText;
                                score += 1;
                                if (/by project/i.test(valueText)) {
                                    inferredPricingType = inferredPricingType || 'fixed-price';
                                    score += 1;
                                }
                                break;
                            case 'you\'ll receive':
                                {
                                    const estimatedReceiveAmount = parseMoneyAmount(valueText);
                                    if (estimatedReceiveAmount !== null) {
                                        extractedTerms.estimatedReceiveAmount = estimatedReceiveAmount;
                                    }
                                    extractedTerms.estimatedReceiveDisplay = valueText;
                                    score += 1;
                                    if (/\/\s*hr\b/i.test(valueText)) {
                                        score += 1;
                                    }
                                }
                                break;
                            default:
                                break;
                        }
                    }

                    const dataTestValue = normalizeInlineText(pricingSection.getAttribute('data-test') || '');
                    if (!inferredPricingType) {
                        if (/terms-review-hourly/i.test(dataTestValue || '')) {
                            inferredPricingType = 'hourly';
                        } else if (/terms-review-fixed-price/i.test(dataTestValue || '')) {
                            inferredPricingType = 'fixed-price';
                        }
                    } else if (
                        (inferredPricingType === 'hourly' && /terms-review-hourly/i.test(dataTestValue || '')) ||
                        (inferredPricingType === 'fixed-price' && /terms-review-fixed-price/i.test(dataTestValue || ''))
                    ) {
                        score += 1;
                    }

                    if (inferredPricingType) {
                        extractedTerms.pricingType = inferredPricingType;
                    }

                    return Object.keys(extractedTerms).length > 0
                        ? { terms: extractedTerms, score }
                        : null;
                };

                const extractProposalTermsFromDom = () => {
                    const termsSections = Array.from(document.querySelectorAll('[data-test="terms-review"]'));
                    if (!termsSections.length) {
                        return null;
                    }

                    const bestTermsCandidate = selectBestScoredCandidate(
                        termsSections.map((termsSection) => {
                            const terms = {};
                            let score = 0;
                            const profileLink = termsSection.querySelector('.specialized-profile-info a');
                            if (profileLink) {
                                const profileName = normalizeInlineText(profileLink.textContent || '');
                                const profileUrl = normalizeResolvedUrl(profileLink.getAttribute('href') || '');
                                if (profileName) {
                                    terms.profileName = profileName;
                                    score += 1;
                                }
                                if (profileUrl) {
                                    terms.profileUrl = profileUrl;
                                    score += 1;
                                }
                            }

                            const clientBudgetText = extractShortestMatchingText(
                                termsSection,
                                /^Client's budget:/i
                            );
                            const clientBudgetDisplay = normalizeInlineText(
                                (clientBudgetText || '').replace(/^Client's budget:\s*/i, '')
                            );
                            const clientBudget = parseMoneyAmount(clientBudgetDisplay);
                            if (clientBudget !== null) {
                                terms.clientBudget = clientBudget;
                                score += 1;
                            }
                            if (clientBudgetDisplay) {
                                terms.clientBudgetDisplay = clientBudgetDisplay;
                                score += 1;
                            }

                            const bestPricingCandidate = selectBestScoredCandidate(
                                Array.from(
                                    termsSection.querySelectorAll(
                                        '[data-test="terms-review-hourly"], [data-test="terms-review-fixed-price"]'
                                    )
                                ).map((pricingSection) => parseProposalPricingTermsSection(pricingSection))
                            );
                            if (bestPricingCandidate?.terms) {
                                Object.assign(terms, bestPricingCandidate.terms);
                                score += bestPricingCandidate.score;
                            }

                            const rateIncrease = normalizeInlineText(
                                termsSection.querySelector('.sri-review p.rate')?.textContent ||
                                termsSection.querySelector('.sri-review .rate')?.textContent ||
                                ''
                            );
                            if (rateIncrease) {
                                terms.rateIncrease = rateIncrease;
                                score += 1;
                            }

                            return Object.keys(terms).length > 0
                                ? { terms, score }
                                : null;
                        })
                    );

                    return bestTermsCandidate?.terms || null;
                };

                const readDomSupplement = () => {
                    const data = {};
                    const proposal = {};
                    const terms = {};

                    const coverLetterSection = document.querySelector('[data-cy="cover-letter-section"]');
                    if (coverLetterSection) {
                        const contentNode =
                            coverLetterSection.querySelector('p.text-pre-line') ||
                            coverLetterSection.querySelector('.air3-card-section .text-pre-line') ||
                            coverLetterSection.querySelector('.air3-card-section p.break') ||
                            coverLetterSection.querySelector('.air3-card-section p');
                        const coverLetter = normalizeMultilineText(contentNode?.textContent || '');
                        if (coverLetter) {
                            proposal.coverLetter = coverLetter;
                        }
                    }

                    const attachedHighlightsSection = document.querySelector('.profile-highlights-section');
                    if (attachedHighlightsSection) {
                        const description = normalizeInlineText(
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
                                const meta = normalizeInlineText(
                                    item.querySelector('.work-history-info')?.textContent || ''
                                ) || secondaryTexts.slice(1).join(' | ') || null;
                                const normalizedItem = {};

                                if (secondaryTexts[0]) {
                                    normalizedItem.type = secondaryTexts[0];
                                }
                                if (title) {
                                    normalizedItem.title = title;
                                }
                                if (meta) {
                                    normalizedItem.meta = meta;
                                }

                                return Object.keys(normalizedItem).length > 0 ? normalizedItem : null;
                            })
                            .filter(Boolean);

                        const attachedHighlights = {};
                        if (description) {
                            attachedHighlights.description = description;
                        }
                        if (items.length > 0) {
                            attachedHighlights.items = items;
                        }
                        if (Object.keys(attachedHighlights).length > 0) {
                            proposal.attachedHighlights = attachedHighlights;
                        }
                    }

                    const proposalTerms = extractProposalTermsFromDom();
                    if (proposalTerms) {
                        Object.assign(terms, proposalTerms);
                    }

                    const boostSection = document.querySelector('.boost-information-section');
                    if (boostSection) {
                        const connectsText = normalizeInlineText(
                            boostSection.querySelector('strong')?.textContent ||
                            boostSection.querySelector('.text-body')?.textContent ||
                            boostSection.textContent ||
                            ''
                        );
                        const connectsSpent = parseConnectsCount(connectsText);
                        if (connectsSpent !== null) {
                            terms.connectsSpent = connectsSpent;
                        }
                    }

                    if (Object.keys(terms).length > 0) {
                        proposal.terms = terms;
                    }
                    if (Object.keys(proposal).length > 0) {
                        data.proposal = proposal;
                    }

                    return Object.keys(data).length > 0 ? data : null;
                };

                const getTermsFieldCount = (payload) => {
                    const termPayload = payload?.proposal?.terms;
                    return termPayload && typeof termPayload === 'object' && !Array.isArray(termPayload)
                        ? Object.keys(termPayload).length
                        : 0;
                };

                const hasData = (payload) => (
                    !!payload?.proposal?.coverLetter ||
                    getTermsFieldCount(payload) > 0 ||
                    !!payload?.proposal?.attachedHighlights?.description ||
                    (
                        Array.isArray(payload?.proposal?.attachedHighlights?.items) &&
                        payload.proposal.attachedHighlights.items.length > 0
                    )
                );

                const timeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : 4000;
                const pollMs = Number(options?.pollMs) > 0 ? Number(options.pollMs) : 200;
                const deadline = Date.now() + timeoutMs;
                let lastPayload = readDomSupplement();

                if (hasData(lastPayload)) {
                    return lastPayload;
                }

                while (Date.now() < deadline) {
                    await new Promise((resolve) => setTimeout(resolve, pollMs));
                    lastPayload = readDomSupplement();
                    if (hasData(lastPayload)) {
                        return lastPayload;
                    }
                }

                return lastPayload;
            },
            args: [{
                timeoutMs: DEBUGGER_DETAILS_DOM_WAIT_MS,
                pollMs: DEBUGGER_DETAILS_DOM_POLL_MS
            }]
        });

        const result = executionResults?.[0]?.result || null;
        const coverLetterLength = result?.proposal?.coverLetter
            ? result.proposal.coverLetter.length
            : 0;
        const connectsSpent = result?.proposal?.terms?.connectsSpent;
        const termsFieldCount = result?.proposal?.terms &&
            typeof result.proposal.terms === 'object' &&
            !Array.isArray(result.proposal.terms)
            ? Object.keys(result.proposal.terms).length
            : 0;
        const attachedHighlightsCount = Array.isArray(result?.proposal?.attachedHighlights?.items)
            ? result.proposal.attachedHighlights.items.length
            : 0;
        const hasData = !!(
            coverLetterLength > 0 ||
            termsFieldCount > 0 ||
            attachedHighlightsCount > 0 ||
            result?.proposal?.attachedHighlights?.description
        );
        const summaryMessage = (
            `${DEBUGGER_LOG_PREFIX} DOM supplement ${hasData ? 'captured' : 'empty'} ` +
            `href=${href || 'unknown'} coverLetter=${coverLetterLength} ` +
            `attachedHighlights=${attachedHighlightsCount} termsFields=${termsFieldCount} ` +
            `connectsSpent=${connectsSpent ?? 'none'}`
        );

        console.log(summaryMessage);
        await logDebuggerToTab(tabId, summaryMessage);
        return hasData ? result : null;
    } catch (error) {
        const errorMessage = (
            `${DEBUGGER_LOG_PREFIX} DOM supplement failed ` +
            `href=${href || 'unknown'} error=${error?.message || 'unknown error'}`
        );
        console.warn(errorMessage, error);
        await logDebuggerToTab(tabId, errorMessage);
        return null;
    }
}

function ensureDebuggerListeners() {
    if (debuggerListenersInstalled) {
        return;
    }

    chrome.debugger.onEvent.addListener((source, method, params) => {
        handleDebuggerEvent(source, method, params).catch((error) => {
            console.warn(`${DEBUGGER_LOG_PREFIX} event handling failed:`, error);
        });
    });

    chrome.debugger.onDetach.addListener((source, reason) => {
        if (!source?.tabId) {
            return;
        }
        const existingSession = debuggerSessions.get(source.tabId);
        if (existingSession) {
            if (existingSession.detailCaptureWaiters?.length) {
                for (const waiter of existingSession.detailCaptureWaiters) {
                    clearTimeout(waiter.timeoutId);
                    waiter.resolve(null);
                }
                existingSession.detailCaptureWaiters.length = 0;
            }
            debuggerSessions.delete(source.tabId);
            console.log(`${DEBUGGER_LOG_PREFIX} detached from tab ${source.tabId} (${reason}).`);
            if (existingSession.captureMode === 'find-work') {
                getFindWorkTrackingSession()
                    .then((trackingSession) => {
                        if (!trackingSession?.active || Number(trackingSession.tabId) !== Number(source.tabId)) {
                            return null;
                        }
                        return stopFindWorkTrackingSession({
                            session: trackingSession,
                            status: 'stopped',
                            action: `Find Work tracking detached (${reason}).`,
                            detachDebugger: false
                        });
                    })
                    .catch((error) => {
                        console.warn('Failed to clear Find Work tracking session after debugger detach:', error);
                    });
            }
        }
    });

    debuggerListenersInstalled = true;
}

async function handleDebuggerEvent(source, method, params) {
    const tabId = source?.tabId;
    if (!tabId || !debuggerSessions.has(tabId)) {
        return;
    }

    const session = debuggerSessions.get(tabId);
    if (!session) {
        return;
    }

    if (method === 'Network.requestWillBeSent') {
        const requestId = String(params?.requestId || '');
        const request = params?.request || {};
        if (!requestId || !isGraphqlRequestUrl(request.url)) {
            return;
        }

        const alias = aliasFromGraphqlUrl(request.url);
        const likelyProposalList = isTargetGraphqlRequestUrl(request.url) ||
            isLikelyProposalsGraphqlRequest(request.url, request.postData);
        const likelyProposalDetails = isTargetDetailsGraphqlRequestUrl(request.url) ||
            isLikelyProposalDetailsGraphqlRequest(request.url, request.postData);

        session.requests.set(requestId, {
            requestId,
            url: String(request.url || ''),
            method: String(request.method || 'GET').toUpperCase(),
            alias,
            likelyProposalList,
            likelyProposalDetails,
            postData: String(request.postData || ''),
            requestStartedAtMs: Date.now(),
            responseMeta: null
        });
        session.stats.graphqlRequestsSeen += 1;
        if (likelyProposalList) {
            session.stats.likelyListRequests += 1;
        }
        if (likelyProposalDetails) {
            session.stats.likelyDetailsRequests += 1;
        }
        console.log(
            `${DEBUGGER_LOG_PREFIX} request captured tab=${tabId} id=${requestId} ` +
            `method=${String(request.method || 'GET').toUpperCase()} alias=${alias || 'none'} ` +
            `list=${likelyProposalList ? 'yes' : 'no'} details=${likelyProposalDetails ? 'yes' : 'no'}`
        );
        if (
            likelyProposalList ||
            likelyProposalDetails ||
            (DEBUGGER_VERBOSE_LOGS && (session.stats.graphqlRequestsSeen <= 10 || session.stats.graphqlRequestsSeen % 25 === 0))
        ) {
            await logDebuggerToTab(
                tabId,
                `${DEBUGGER_LOG_PREFIX} request captured alias=${alias || 'none'} list=${likelyProposalList ? 'yes' : 'no'} details=${likelyProposalDetails ? 'yes' : 'no'} url=${String(request.url || '')}`
            );
        }
        return;
    }

    if (method === 'Network.responseReceived') {
        const requestId = String(params?.requestId || '');
        const tracked = session.requests.get(requestId);
        if (!tracked) {
            return;
        }
        tracked.responseMeta = params?.response || null;
        return;
    }

    if (method === 'Network.loadingFailed') {
        const requestId = String(params?.requestId || '');
        if (!session.requests.has(requestId)) {
            return;
        }
        session.requests.delete(requestId);
        console.warn(`${DEBUGGER_LOG_PREFIX} request failed tab=${tabId} id=${requestId}`);
        return;
    }

    if (method === 'Network.loadingFinished') {
        const requestId = String(params?.requestId || '');
        const tracked = session.requests.get(requestId);
        if (!tracked) {
            return;
        }

        session.requests.delete(requestId);

        let responseBodyResult;
        try {
            responseBodyResult = await debuggerSendCommand(source, 'Network.getResponseBody', { requestId });
        } catch (error) {
            session.stats.parseFailed += 1;
            console.warn(`${DEBUGGER_LOG_PREFIX} getResponseBody failed for ${requestId}:`, error.message);
            return;
        }

        const responseText = decodeDebuggerResponseBody(responseBodyResult);

        if (session.captureMode === 'details') {
            if (!tracked.likelyProposalDetails) {
                session.stats.nonTargetResponsesIgnored += 1;
                return;
            }

            session.stats.detailsResponsesCaptured += 1;
            const parsedResponse = safeParseJsonPayload(responseText);
            if (!parsedResponse) {
                session.stats.parseFailed += 1;
                console.warn(
                    `${DEBUGGER_LOG_PREFIX} details response parse failed tab=${tabId} id=${requestId} alias=${tracked.alias || 'none'}`
                );
                return;
            }

            const activeContext = session.activeDetailContext ? { ...session.activeDetailContext } : null;
            const href = String(activeContext?.href || '').trim();
            if (!href) {
                session.stats.nonTargetResponsesIgnored += 1;
                if (DEBUGGER_VERBOSE_LOGS) {
                    console.log(
                        `${DEBUGGER_LOG_PREFIX} details response ignored because active context is missing ` +
                        `tab=${tabId} id=${requestId} alias=${tracked.alias || 'none'}`
                    );
                }
                return;
            }

            const upsertResult = await queueProposalDetailsUpsert(
                {
                    ...activeContext,
                    rawGraphql: parsedResponse?.data ?? parsedResponse
                },
                `debugger:${tracked.method.toLowerCase()}`
            );
            session.stats.detailsUpsertOps += 1;
            if (upsertResult) {
                session.stats.detailsUpsertedEntries += 1;
            }

            const detailPayload = {
                href,
                alias: tracked.alias || '',
                len: responseText.length
            };
            resolveDetailCaptureWaiters(session, href, detailPayload);

            await logDebuggerToTab(
                tabId,
                `${DEBUGGER_LOG_PREFIX} details response alias=${tracked.alias || 'none'} href=${href} len=${responseText.length} total=${upsertResult?.totalSize || '?'}`
            );
            return;
        }

        if (session.captureMode === 'find-work') {
            const senderTab = {
                id: tabId,
                url: String(session.findWorkPageUrl || ''),
                title: String(session.findWorkPageTitle || '')
            };
            const eventPayload = {
                isTargetOperation: tracked.alias === FIND_WORK_GRAPHQL_ALIAS,
                matchReason: tracked.alias === FIND_WORK_GRAPHQL_ALIAS ? 'url-alias' : '',
                transport: 'debugger',
                path: shortPathFromUrl(tracked.url),
                url: tracked.url,
                method: tracked.method,
                status: Number(tracked?.responseMeta?.status) || 0,
                ok: Number(tracked?.responseMeta?.status) >= 200 && Number(tracked?.responseMeta?.status) < 300,
                graphqlAlias: tracked.alias || '',
                pageUrl: senderTab.url,
                pageTitle: senderTab.title,
                requestStartedAtMs: Number(tracked.requestStartedAtMs) || Date.now(),
                capturedAtMs: Date.now(),
                responseTextLength: responseText.length,
                responseText
            };

            const result = await handleFindWorkCaptureEvent(eventPayload, senderTab);
            if (result?.ignored) {
                session.stats.nonTargetResponsesIgnored += 1;
                if (result.reason === 'parse-failed' || result.reason === 'non-target') {
                    session.stats.parseFailed += 1;
                }
                return;
            }

            session.stats.findWorkResponsesCaptured += 1;
            if (tracked.alias !== FIND_WORK_GRAPHQL_ALIAS) {
                session.stats.findWorkRecoveredByPayload += 1;
            }
            session.stats.findWorkUpsertOps += 1;
            session.stats.findWorkUpsertedEntries += Number(result?.upsertedCount) || 0;
            await logDebuggerToTab(
                tabId,
                `${FIND_WORK_LOG_PREFIX} debugger response alias=${tracked.alias || 'none'} ` +
                `upserted=${Number(result?.upsertedCount) || 0} total=${Number(result?.totalSaved) || 0}`
            );
            return;
        }

        if (!tracked.likelyProposalList) {
            session.stats.nonTargetResponsesIgnored += 1;
            return;
        }

        const links = extractProposalLinksFromGraphqlResponse(responseText, session.scrapeMode);
        session.stats.responsesCaptured += 1;

        if (!links.length) {
            session.stats.parseFailed += 1;
            if (DEBUGGER_VERBOSE_LOGS) {
                const preview = responseText.replace(/\s+/g, ' ').slice(0, 100);
                console.log(
                    `${DEBUGGER_LOG_PREFIX} response captured tab=${tabId} id=${requestId} ` +
                    `alias=${tracked.alias || 'none'} likely=${tracked.likelyProposalList ? 'yes' : 'no'} ` +
                    `len=${responseText.length} links=0 preview="${preview || '<empty>'}"`
                );
            }
            return;
        }

        session.stats.linksRecovered += links.length;
        const upsertResult = await queueProposalListUpsert(
            links,
            `debugger:${tracked.method.toLowerCase()}`
        );
        session.stats.upsertOps += 1;
        session.stats.upsertedEntries += upsertResult?.upsertedCount || 0;

        console.log(
            `${DEBUGGER_LOG_PREFIX} response captured tab=${tabId} id=${requestId} ` +
            `alias=${tracked.alias || 'none'} likely=${tracked.likelyProposalList ? 'yes' : 'no'} ` +
            `len=${responseText.length} links=${links.length} ` +
            `upserted=${upsertResult?.upsertedCount || 0} totalList=${upsertResult?.totalSize || 0}`
        );
        await logDebuggerToTab(
            tabId,
            `${DEBUGGER_LOG_PREFIX} response alias=${tracked.alias || 'none'} likely=${tracked.likelyProposalList ? 'yes' : 'no'} len=${responseText.length} links=${links.length} upserted=${upsertResult?.upsertedCount || 0} total=${upsertResult?.totalSize || 0}`
        );
    }
}

async function startDebuggerCaptureForTab(tabId, options = {}) {
    ensureDebuggerListeners();
    const scrapeMode = options?.scrapeMode === 'all' ? 'all' : 'successful';
    const captureMode = options?.captureMode === 'details'
        ? 'details'
        : (options?.captureMode === 'find-work' ? 'find-work' : 'list');

    if (debuggerSessions.has(tabId)) {
        const existingSession = debuggerSessions.get(tabId);
        if (existingSession) {
            existingSession.scrapeMode = scrapeMode;
            existingSession.captureMode = captureMode;
        }
        return true;
    }

    try {
        await debuggerAttach(tabId);
        const source = { tabId };
        await debuggerSendCommand(source, 'Network.enable', {});
        await debuggerSendCommand(source, 'Network.setCacheDisabled', { cacheDisabled: true });

        debuggerSessions.set(tabId, {
            tabId,
            source,
            scrapeMode,
            captureMode,
            requests: new Map(),
            activeDetailContext: null,
            capturedDetailHrefs: new Set(),
            detailCaptureWaiters: [],
            stats: {
                graphqlRequestsSeen: 0,
                likelyListRequests: 0,
                likelyDetailsRequests: 0,
                responsesCaptured: 0,
                findWorkResponsesCaptured: 0,
                findWorkRecoveredByPayload: 0,
                detailsResponsesCaptured: 0,
                nonTargetResponsesIgnored: 0,
                parseFailed: 0,
                linksRecovered: 0,
                upsertOps: 0,
                upsertedEntries: 0,
                findWorkUpsertOps: 0,
                findWorkUpsertedEntries: 0,
                detailsUpsertOps: 0,
                detailsUpsertedEntries: 0
            }
        });

        console.log(`${DEBUGGER_LOG_PREFIX} attached to tab ${tabId}.`);
        await logDebuggerToTab(tabId, `${DEBUGGER_LOG_PREFIX} attached to tab ${tabId}.`);
        return true;
    } catch (error) {
        console.warn(`${DEBUGGER_LOG_PREFIX} could not attach to tab ${tabId}:`, error.message);
        await logDebuggerToTab(tabId, `${DEBUGGER_LOG_PREFIX} could not attach: ${error.message}`);
        return false;
    }
}

async function stopDebuggerCaptureForTab(tabId) {
    const session = debuggerSessions.get(tabId);
    debuggerSessions.delete(tabId);

    if (session?.detailCaptureWaiters?.length) {
        for (const waiter of session.detailCaptureWaiters) {
            clearTimeout(waiter.timeoutId);
            waiter.resolve(null);
        }
        session.detailCaptureWaiters.length = 0;
    }

    try {
        await new Promise((resolve) => setTimeout(resolve, 600));
        await debuggerDetach(tabId);
    } catch (error) {
        console.warn(`${DEBUGGER_LOG_PREFIX} detach failed for tab ${tabId}:`, error.message);
    }

    if (session) {
        const stats = session.stats;
        const summary = (
            `${DEBUGGER_LOG_PREFIX} summary tab=${tabId} graphql=${stats.graphqlRequestsSeen} ` +
            `likelyList=${stats.likelyListRequests} likelyDetails=${stats.likelyDetailsRequests} ` +
            `ignored=${stats.nonTargetResponsesIgnored} ` +
            `listResponses=${stats.responsesCaptured} links=${stats.linksRecovered} ` +
            `findWorkResponses=${stats.findWorkResponsesCaptured || 0} ` +
            `findWorkRecovered=${stats.findWorkRecoveredByPayload || 0} ` +
            `detailResponses=${stats.detailsResponsesCaptured} ` +
            `parseFailed=${stats.parseFailed} listUpserts=${stats.upsertOps}/${stats.upsertedEntries} ` +
            `findWorkUpserts=${stats.findWorkUpsertOps || 0}/${stats.findWorkUpsertedEntries || 0} ` +
            `detailUpserts=${stats.detailsUpsertOps}/${stats.detailsUpsertedEntries}`
        );
        console.log(summary);
        await logDebuggerToTab(tabId, summary);
    }
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'startScraping') {
        const scrapeMode = normalizeScrapeMode(request.scrapeMode);
        startScrapingFlow(scrapeMode).catch((error) => {
            if (isDebuggerStopRequestedError(error)) {
                console.log(`${DEBUGGER_LOG_PREFIX} proposal details capture stopped from side panel.`);
                return;
            }
            console.error('Failed to start proposal scraping:', error);
        });
        return;
    }

    if (request.action === 'startFindWorkJobListTracking') {
        startFindWorkJobListTrackingFlow()
            .then(() => {
                sendResponse({ ok: true });
            })
            .catch((error) => {
                console.error('Failed to start Find Work tracking:', error);
                sendResponse({ ok: false, error: error?.message || 'Unknown Find Work tracking failure' });
            });
        return true;
    }

    if (request.action === 'stopFindWorkJobListTracking') {
        stopFindWorkTrackingSession({
            status: 'stopped',
            action: 'Stopped from the side panel.',
            forceRunStatus: true
        })
            .then(() => {
                sendResponse({ ok: true });
            })
            .catch((error) => {
                console.error('Failed to stop Find Work tracking:', error);
                sendResponse({ ok: false, error: error?.message || 'Unknown Find Work stop failure' });
            });
        return true;
    }

    if (request.action === 'startArchivedListScraping') {
        const scrapeMode = normalizeScrapeMode(request.scrapeMode);
        startArchivedListScrapingFlow(scrapeMode).catch((error) => {
            console.error('Failed to start archived proposal list scraping:', error);
        });
        return;
    }

    if (request.action === 'startCurrentJobPostScraping') {
        startCurrentJobPostScrapingFlow().catch((error) => {
            console.error('Failed to start current job post scraping:', error);
        });
        return;
    }

    if (request.action === 'startJobPostsFromSavedListScraping') {
        const scrapeMode = normalizeScrapeMode(request.scrapeMode);
        startJobPostsFromSavedListScrapingFlow(scrapeMode).catch((error) => {
            console.error('Failed to start saved-list job post scraping:', error);
        });
        return;
    }

    if (request.action === 'repairSavedJobPostUrls') {
        repairSavedJobPostUrls()
            .then((summary) => {
                sendResponse({ ok: true, summary });
            })
            .catch((error) => {
                console.error('Failed to repair saved job post URLs:', error);
                sendResponse({ ok: false, error: error?.message || 'Unknown repair failure' });
            });
        return true;
    }

    if (request.action === 'upworkFindWorkCaptureEvent') {
        handleFindWorkCaptureEvent(request.payload, _sender?.tab)
            .then((result) => {
                sendResponse({ ok: true, result });
            })
            .catch((error) => {
                console.warn('Failed to handle Find Work capture event:', error);
                sendResponse({ ok: false, error: error?.message || 'Unknown Find Work capture failure' });
            });
        return true;
    }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[UPWORK_RUN_CONTROL_STORAGE_KEY]) {
        return;
    }

    const nextControl = normalizeUpworkRunControl(changes[UPWORK_RUN_CONTROL_STORAGE_KEY].newValue);
    if (nextControl.stopRequested !== true) {
        return;
    }

    getFindWorkTrackingSession()
        .then((session) => {
            if (!session?.active) {
                return null;
            }
            return stopFindWorkTrackingSession({
                session,
                status: 'stopped',
                action: 'Stopped from the side panel.'
            });
        })
        .catch((error) => {
            console.warn('Failed to stop Find Work tracking from run control change:', error);
        });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    maybeRefreshFindWorkTrackingForTab(tabId, changeInfo, tab).catch((error) => {
        console.warn('Failed to refresh Find Work tracking after tab update:', error);
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
    getFindWorkTrackingSession()
        .then((session) => {
            if (!session?.active || Number(session.tabId) !== Number(tabId)) {
                return null;
            }
            return stopFindWorkTrackingSession({
                session,
                status: 'stopped',
                action: 'Tracked Find Work tab was closed.'
            });
        })
        .catch((error) => {
            console.warn('Failed to stop Find Work tracking after tab close:', error);
        });
});

function hasCapturedDetailsRaw(entry) {
    return entry?.proposalDetailsPage?.rawGraphql !== undefined &&
        entry?.proposalDetailsPage?.rawGraphql !== null;
}

async function buildPendingDetailLinks(scrapeMode) {
    const storageData = await chrome.storage.local.get(['proposalList', 'proposals']);
    const proposalList = Array.isArray(storageData.proposalList) ? storageData.proposalList : [];
    const proposals = Array.isArray(storageData.proposals) ? storageData.proposals : [];
    const capturedByHref = new Set();

    for (const entry of proposals) {
        const href = extractExistingProposalHref(entry);
        if (!href) {
            continue;
        }
        if (hasCapturedDetailsRaw(entry)) {
            capturedByHref.add(href);
        }
    }

    const pending = [];
    const seen = new Set();
    for (const entry of proposalList) {
        const normalized = normalizeLinkData(entry);
        if (!normalized) {
            continue;
        }
        if (!isReasonAllowedForMode(normalized.reason, scrapeMode)) {
            continue;
        }
        if (capturedByHref.has(normalized.href)) {
            continue;
        }
        if (seen.has(normalized.href)) {
            continue;
        }
        seen.add(normalized.href);
        pending.push(normalized);
    }

    return {
        proposalList,
        proposals,
        pending
    };
}

async function runDebuggerProposalDetailsFlow(tabId, scrapeMode) {
    const { pending, proposalList, proposals } = await buildPendingDetailLinks(scrapeMode);
    const runDescriptor = getUpworkRunDescriptor({
        scrapeMode,
        scrapeProposalDetailsFromList: true
    });
    const startedAtIso = new Date().toISOString();
    const estimateEtaMs = (processedCount, totalCount) => {
        if (!processedCount || processedCount <= 0 || totalCount <= processedCount) {
            return null;
        }

        const elapsedMs = Math.max(Date.now() - Date.parse(startedAtIso), 0);
        if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
            return null;
        }

        const avgMsPerItem = elapsedMs / processedCount;
        return Number.isFinite(avgMsPerItem) && avgMsPerItem > 0
            ? Math.max((totalCount - processedCount) * avgMsPerItem, 0)
            : null;
    };
    const buildErrorSummary = (timedOut, failedCount) => {
        const parts = [];
        if (timedOut > 0) {
            parts.push(`timeout: ${timedOut}`);
        }
        if (failedCount > 0) {
            parts.push(`failed: ${failedCount}`);
        }
        return parts.join(', ');
    };
    const buildRecentErrors = (timedOut, failureMessage = '') => {
        const entries = [];
        if (failureMessage) {
            entries.push({
                type: 'run_failure',
                message: failureMessage
            });
        }
        if (timedOut > 0) {
            entries.push({
                type: 'detail_timeout',
                message: `${timedOut} detail capture timeout${timedOut === 1 ? '' : 's'}`
            });
        }
        return entries;
    };
    await setUpworkRunControlState({ paused: false, stopRequested: false });
    await queueUpworkRunStatusUpdate({
        ...runDescriptor,
        action: 'Preparing saved proposal details...',
        listProgressLabel: 'Run Scope',
        listProgressText: pending.length > 0
            ? `${pending.length} saved proposals pending details capture`
            : 'Saved proposal list',
        itemCurrent: 0,
        itemTotal: pending.length,
        totalSaved: proposals.length,
        etaMs: null,
        etaText: 'Calculating...',
        errorTotal: 0,
        errorSummary: '',
        recentErrors: [],
        isPaused: false,
        stopRequested: false,
        inProgress: true,
        status: 'running',
        pauseSupported: true,
        stopSupported: true,
        startedAt: startedAtIso,
        updatedAt: startedAtIso
    }, { reset: true });
    await logDebuggerToTab(
        tabId,
        `${DEBUGGER_LOG_PREFIX} details run started. list=${proposalList.length} proposals=${proposals.length} pending=${pending.length} mode=${scrapeMode}`
    );

    if (!pending.length) {
        console.log(`${DEBUGGER_LOG_PREFIX} details run found no pending proposal links.`);
        await logDebuggerToTab(tabId, `${DEBUGGER_LOG_PREFIX} details run found no pending proposal links.`);
        await queueUpworkRunStatusUpdate({
            inProgress: false,
            status: 'no-pending-links',
            action: 'No saved proposal details left to capture.',
            itemCurrent: 0,
            itemTotal: 0,
            etaMs: 0,
            etaText: 'done',
            pauseSupported: false,
            stopSupported: false
        });
        await setUpworkRunControlState({ paused: false, stopRequested: false });
        return;
    }

    let captured = 0;
    let timedOut = 0;
    for (let index = 0; index < pending.length; index += 1) {
        const link = pending[index];
        const actionText = `Opening saved proposal ${index + 1} of ${pending.length}`;
        await waitForDebuggerRunControl(actionText);
        await queueUpworkRunStatusUpdate({
            action: actionText,
            itemCurrent: index + 1,
            itemTotal: pending.length,
            listProgressText: link.href,
            totalSaved: proposals.length + captured,
            etaMs: estimateEtaMs(index, pending.length),
            etaText: index > 0 ? '' : 'Calculating...',
            errorTotal: timedOut,
            errorSummary: buildErrorSummary(timedOut, 0),
            recentErrors: buildRecentErrors(timedOut)
        });
        setActiveDetailContext(tabId, link);
        await logDebuggerToTab(
            tabId,
            `${DEBUGGER_LOG_PREFIX} details ${index + 1}/${pending.length} navigating ${link.href}`
        );

        await chrome.tabs.update(tabId, { url: link.href });
        await waitForTabReady(tabId, UPWORK_ROOT_URL);
        const capturedPayload = await waitForDetailCapture(tabId, link.href, DEBUGGER_DETAILS_RESPONSE_WAIT_MS);

        if (capturedPayload) {
            captured += 1;
            const domSupplementalData = await extractProposalDomSupplementalData(tabId, link.href);
            if (domSupplementalData) {
                await queueProposalDetailsUpsert(
                    {
                        ...link,
                        pageData: domSupplementalData
                    },
                    'debugger:dom'
                );
            }
            await queueUpworkRunStatusUpdate({
                totalSaved: proposals.length + captured
            });
            await logDebuggerToTab(
                tabId,
                `${DEBUGGER_LOG_PREFIX} details ${index + 1}/${pending.length} captured alias=${capturedPayload.alias || 'unknown'} href=${link.href}`
            );
        } else {
            timedOut += 1;
            await queueUpworkRunStatusUpdate({
                errorTotal: timedOut,
                errorSummary: buildErrorSummary(timedOut, 0),
                recentErrors: buildRecentErrors(timedOut)
            });
            console.warn(`${DEBUGGER_LOG_PREFIX} details capture timeout for ${link.href}`);
            await logDebuggerToTab(
                tabId,
                `${DEBUGGER_LOG_PREFIX} details ${index + 1}/${pending.length} timed out for ${link.href}`
            );
        }

        await new Promise((resolve) => setTimeout(resolve, DEBUGGER_DETAILS_INTER_ITEM_DELAY_MS));
    }

    clearActiveDetailContext(tabId);
    await queueUpworkRunStatusUpdate({
        inProgress: false,
        status: 'completed',
        action: `Captured ${captured} proposal detail${captured === 1 ? '' : 's'}.`,
        listProgressText: 'Saved proposal details',
        itemCurrent: pending.length,
        itemTotal: pending.length,
        totalSaved: proposals.length + captured,
        etaMs: 0,
        etaText: 'done',
        errorTotal: timedOut,
        errorSummary: buildErrorSummary(timedOut, 0),
        recentErrors: buildRecentErrors(timedOut),
        isPaused: false,
        stopRequested: false,
        pauseSupported: false,
        stopSupported: false
    });
    await setUpworkRunControlState({ paused: false, stopRequested: false });
    await logDebuggerToTab(
        tabId,
        `${DEBUGGER_LOG_PREFIX} details run complete. captured=${captured} timedOut=${timedOut} total=${pending.length}`
    );
}

async function startScrapingFlow(scrapeMode = DEFAULT_SCRAPE_MODE) {
    await stopFindWorkTrackingSession({ updateRunStatus: false });

    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    let targetTabId;
    if (currentTab?.url?.startsWith(ARCHIVED_PROPOSALS_URL)) {
        targetTabId = currentTab.id;
    } else {
        const newTab = await chrome.tabs.create({ url: ARCHIVED_PROPOSALS_URL });
        targetTabId = newTab.id;
    }

    await waitForTabReady(targetTabId, ARCHIVED_PROPOSALS_URL);
    const debuggerAttached = await startDebuggerCaptureForTab(targetTabId, {
        scrapeMode,
        captureMode: 'details'
    });
    if (!debuggerAttached) {
        throw new Error(
            'Proposal details capture requires debugger attachment. ' +
            'Close DevTools for this tab (if open) and retry.'
        );
    }

    try {
        try {
            await runDebuggerProposalDetailsFlow(targetTabId, scrapeMode);
        } catch (error) {
            const stopped = isDebuggerStopRequestedError(error);
            await queueUpworkRunStatusUpdate({
                inProgress: false,
                status: stopped ? 'stopped' : 'failed',
                action: stopped
                    ? 'Stopped from the side panel.'
                    : 'Proposal details capture failed.',
                etaMs: 0,
                etaText: 'done',
                isPaused: false,
                stopRequested: false,
                pauseSupported: false,
                stopSupported: false,
                errorTotal: stopped ? 0 : 1,
                errorSummary: stopped ? '' : 'failed: 1',
                recentErrors: stopped
                    ? []
                    : [{
                        type: 'run_failure',
                        message: error?.message || 'unknown details capture failure'
                    }]
            });
            throw error;
        }
    } finally {
        await setUpworkRunControlState({ paused: false, stopRequested: false });
        await stopDebuggerCaptureForTab(targetTabId);
        await chrome.tabs.update(targetTabId, { url: ARCHIVED_PROPOSALS_URL });
    }
}

async function startArchivedListScrapingFlow(scrapeMode = DEFAULT_SCRAPE_MODE) {
    await stopFindWorkTrackingSession({ updateRunStatus: false });

    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    let targetTabId;
    if (currentTab?.url?.startsWith(ARCHIVED_PROPOSALS_URL)) {
        targetTabId = currentTab.id;
    } else {
        const newTab = await chrome.tabs.create({ url: ARCHIVED_PROPOSALS_URL });
        targetTabId = newTab.id;
    }

    await waitForTabReady(targetTabId, ARCHIVED_PROPOSALS_URL);
    let debuggerAttached = false;
    if (DEBUGGER_ENABLED_FOR_LIST_SCRAPE) {
        debuggerAttached = await startDebuggerCaptureForTab(targetTabId, {
            scrapeMode,
            captureMode: 'list'
        });
        if (!debuggerAttached) {
            throw new Error(
                'Archived list capture requires debugger attachment. ' +
                'Close DevTools for this tab (if open) and retry.'
            );
        }
    }
    await ensureInjectedScraperHelpers(targetTabId, {
        injectMainWorldHelpers: !debuggerAttached
    });

    try {
        await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            function: runUpworkScrape,
            args: [{
                scrapeMode,
                scrapeArchivedListOnly: true,
                useDebuggerProposalListCapture: debuggerAttached,
                disableNetworkMonitor: debuggerAttached
            }]
        });
    } finally {
        if (debuggerAttached) {
            await stopDebuggerCaptureForTab(targetTabId);
        }
    }
}

async function startJobPostsFromSavedListScrapingFlow(scrapeMode = DEFAULT_SCRAPE_MODE) {
    await stopFindWorkTrackingSession({ updateRunStatus: false });

    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    let targetTabId;
    if (currentTab?.url?.startsWith(ARCHIVED_PROPOSALS_URL)) {
        targetTabId = currentTab.id;
    } else {
        const newTab = await chrome.tabs.create({ url: ARCHIVED_PROPOSALS_URL });
        targetTabId = newTab.id;
    }

    await waitForTabReady(targetTabId, ARCHIVED_PROPOSALS_URL);
    await ensureInjectedScraperHelpers(targetTabId);
    await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        function: runUpworkScrape,
        args: [{ scrapeMode, scrapeJobPostsFromSavedList: true }]
    });
}

async function startCurrentJobPostScrapingFlow() {
    await stopFindWorkTrackingSession({ updateRunStatus: false });

    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!currentTab?.id) {
        throw new Error('No active tab found for current job post scraping.');
    }
    if (!String(currentTab.url || '').startsWith(UPWORK_ROOT_URL)) {
        throw new Error('Current job post scraping requires an active Upwork tab.');
    }

    await waitForTabReady(currentTab.id, UPWORK_ROOT_URL);
    await ensureInjectedScraperHelpers(currentTab.id);
    await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        function: runUpworkScrape,
        args: [{ scrapeCurrentJobPost: true }]
    });
}

function createFindWorkRunStatusUpdate(overrides = {}) {
    const update = overrides && typeof overrides === 'object' ? { ...overrides } : {};
    return {
        runKind: 'find-work-job-list',
        statusTitle: 'Tracking Find Work Jobs',
        modeBadgeText: 'Find Work: Best Matches',
        listProgressLabel: 'Run Scope',
        listProgressText: 'Best matches tab',
        listCurrent: '1',
        listTotal: '1',
        itemCurrent: 0,
        itemTotal: 0,
        totalSaved: 0,
        etaMs: null,
        etaText: 'waiting for activity',
        errorTotal: 0,
        errorSummary: '',
        recentErrors: [],
        isPaused: false,
        stopRequested: false,
        pauseSupported: false,
        stopSupported: true,
        inProgress: true,
        status: 'running',
        ...update
    };
}

async function setFindWorkTrackingSession(nextSession) {
    if (!nextSession || typeof nextSession !== 'object') {
        await chrome.storage.local.remove(FIND_WORK_TRACKING_SESSION_STORAGE_KEY);
        return null;
    }

    await chrome.storage.local.set({
        [FIND_WORK_TRACKING_SESSION_STORAGE_KEY]: nextSession
    });
    return nextSession;
}

async function ensureFindWorkTrackingHelpers(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            files: FIND_WORK_MAIN_WORLD_HELPER_FILES
        });
    } catch (error) {
        console.warn('Failed to inject Find Work main-world helpers:', error);
        throw error;
    }

    await chrome.scripting.executeScript({
        target: { tabId },
        files: FIND_WORK_INJECTED_HELPER_FILES
    });
}

async function stopFindWorkTrackingSession(options = {}) {
    const session = options?.session || await getFindWorkTrackingSession();
    const hadSession = !!session;
    const tabId = Number(session?.tabId);
    if (hadSession) {
        console.log(
            `${FIND_WORK_LOG_PREFIX} stopping session tab=${session?.tabId ?? 'unknown'} ` +
            `status=${options?.status || 'stopped'} totalSaved=${session?.totalSaved ?? 0}`
        );
        await setFindWorkTrackingSession(null);
    }

    if (
        options?.detachDebugger !== false &&
        Number.isFinite(tabId) &&
        debuggerSessions.get(tabId)?.captureMode === 'find-work'
    ) {
        await stopDebuggerCaptureForTab(tabId);
    }

    if (options?.resetRunControl !== false) {
        await setUpworkRunControlState({ paused: false, stopRequested: false });
    }

    if (options?.updateRunStatus === false) {
        return hadSession;
    }

    if (!hadSession && options?.forceRunStatus !== true) {
        return false;
    }

    const totalSaved = Number.isFinite(Number(options?.totalSaved))
        ? Number(options.totalSaved)
        : (Number.isFinite(Number(session?.totalSaved)) ? Number(session.totalSaved) : 0);
    const startedAt = String(options?.startedAt || session?.startedAt || '').trim() || null;
    const action = String(options?.action || '').trim() || 'Find Work tracking stopped.';
    const status = String(options?.status || '').trim() || 'stopped';

    await queueUpworkRunStatusUpdate(createFindWorkRunStatusUpdate({
        action,
        totalSaved,
        itemCurrent: totalSaved,
        itemTotal: totalSaved,
        etaMs: 0,
        etaText: 'done',
        inProgress: false,
        status,
        stopSupported: false,
        startedAt
    }), { reset: true });

    return hadSession;
}

async function handleFindWorkCaptureEvent(eventPayload, senderTab) {
    const session = await getFindWorkTrackingSession();
    if (!session?.active) {
        return { ignored: true, reason: 'no-session' };
    }

    const senderTabId = Number(senderTab?.id);
    if (!Number.isFinite(senderTabId) || senderTabId !== Number(session.tabId)) {
        return { ignored: true, reason: 'wrong-tab' };
    }

    const pageUrl = String(eventPayload?.pageUrl || senderTab?.url || session.pageUrl || '').trim();
    if (!isFindWorkPageUrl(pageUrl)) {
        console.warn(`${FIND_WORK_LOG_PREFIX} tracked tab left Find Work page: ${pageUrl || 'unknown-url'}`);
        await stopFindWorkTrackingSession({
            session,
            status: 'invalid-target',
            action: 'Tracked tab left the Find Work page.'
        });
        return { ignored: true, reason: 'invalid-page' };
    }

        const payloadAlias = String(eventPayload?.graphqlAlias || aliasFromGraphqlUrl(eventPayload?.url) || '').trim();
    if (
        String(session?.transport || '').trim() === 'debugger' &&
        String(eventPayload?.transport || '').trim() !== 'debugger'
    ) {
        return { ignored: true, reason: 'non-debugger-transport' };
    }

    const feedPayload = extractFindWorkFeedPayload(String(eventPayload?.responseText || ''));
    if (!feedPayload) {
        return {
            ignored: true,
            reason: eventPayload?.isTargetOperation === true ? 'parse-failed' : 'non-target'
        };
    }

    const recoveredViaPayload = !(
        eventPayload?.isTargetOperation === true ||
        payloadAlias === FIND_WORK_GRAPHQL_ALIAS ||
        String(eventPayload?.url || '').includes(FIND_WORK_GRAPHQL_ALIAS)
    );
    if (recoveredViaPayload) {
        console.log(
            `${FIND_WORK_LOG_PREFIX} recovered find-work payload from alias=${payloadAlias || 'none'} ` +
            `status=${eventPayload?.status || '?'} via response parsing.`
        );
    }

    const entries = [];
    const seenUids = new Set();
    for (let index = 0; index < feedPayload.results.length; index += 1) {
        const entry = buildFindWorkJobEntryFromNode(
            feedPayload.results[index],
            eventPayload,
            senderTab,
            feedPayload.responseContext,
            index
        );
        if (!entry || seenUids.has(entry.uid)) {
            continue;
        }
        seenUids.add(entry.uid);
        entries.push(entry);
    }

    const upsertResult = entries.length > 0
        ? await queueFindWorkJobListUpsert(entries, FIND_WORK_SOURCE_LABEL)
        : {
            upsertedCount: 0,
            insertedCount: 0,
            updatedCount: 0,
            totalSize: Number.isFinite(Number(session.totalSaved)) ? Number(session.totalSaved) : 0
        };

    const nowIso = new Date().toISOString();
    const totalSaved = Number.isFinite(Number(upsertResult?.totalSize))
        ? Number(upsertResult.totalSize)
        : (Number.isFinite(Number(session.totalSaved)) ? Number(session.totalSaved) : 0);
    const responsesCaptured = (Number(session.responsesCaptured) || 0) + 1;
    const nextSession = {
        ...session,
        active: true,
        pageUrl,
        pageTitle: String(eventPayload?.pageTitle || senderTab?.title || session.pageTitle || '').trim(),
        updatedAt: nowIso,
        responsesCaptured,
        jobsObserved: (Number(session.jobsObserved) || 0) + feedPayload.results.length,
        totalSaved,
        lastResponseAt: nowIso,
        lastEventSummary: {
            alias: payloadAlias || FIND_WORK_GRAPHQL_ALIAS,
            resultsCount: feedPayload.results.length,
            savedCount: totalSaved,
            upsertedCount: Number(upsertResult?.upsertedCount) || 0,
            insertedCount: Number(upsertResult?.insertedCount) || 0,
            updatedCount: Number(upsertResult?.updatedCount) || 0,
            responseStatus: Number(eventPayload?.status) || 0,
            pageUrl
        }
    };
    await setFindWorkTrackingSession(nextSession);

    const responseSummary = (
        `Captured response ${responsesCaptured} ` +
        `(${feedPayload.results.length} result${feedPayload.results.length === 1 ? '' : 's'}, ` +
        `${Number(upsertResult?.upsertedCount) || 0} upserted, ${totalSaved} saved total). ` +
        'Waiting for more Find Work requests...'
    );
    console.log(
        `${FIND_WORK_LOG_PREFIX} tab=${senderTabId} response#${responsesCaptured} ` +
        `results=${feedPayload.results.length} upserted=${Number(upsertResult?.upsertedCount) || 0} ` +
        `inserted=${Number(upsertResult?.insertedCount) || 0} updated=${Number(upsertResult?.updatedCount) || 0} ` +
        `savedTotal=${totalSaved}`
    );
    await logDebuggerToTab(
        senderTabId,
        `${FIND_WORK_LOG_PREFIX} response#${responsesCaptured} results=${feedPayload.results.length} upserted=${Number(upsertResult?.upsertedCount) || 0} total=${totalSaved}`
    );
    await queueUpworkRunStatusUpdate(createFindWorkRunStatusUpdate({
        action: responseSummary,
        itemCurrent: totalSaved,
        itemTotal: totalSaved,
        totalSaved,
        etaMs: null,
        etaText: 'waiting for activity',
        startedAt: nextSession.startedAt
    }));

    return {
        ignored: false,
        upsertedCount: Number(upsertResult?.upsertedCount) || 0,
        totalSaved
    };
}

async function maybeRefreshFindWorkTrackingForTab(tabId, changeInfo, tab) {
    const session = await getFindWorkTrackingSession();
    if (!session?.active || Number(session.tabId) !== Number(tabId)) {
        return;
    }

    if (changeInfo?.status !== 'complete') {
        return;
    }

    const tabUrl = String(tab?.url || session.pageUrl || '').trim();
    if (!isFindWorkPageUrl(tabUrl)) {
        console.warn(`${FIND_WORK_LOG_PREFIX} stopping after tab navigation to ${tabUrl || 'unknown-url'}`);
        await stopFindWorkTrackingSession({
            session,
            status: 'invalid-target',
            action: 'Tracked tab left the Find Work page.'
        });
        return;
    }

    const debuggerSession = debuggerSessions.get(tabId);
    if (debuggerSession && debuggerSession.captureMode === 'find-work') {
        debuggerSession.findWorkPageUrl = tabUrl;
        debuggerSession.findWorkPageTitle = String(tab?.title || session.pageTitle || '').trim();
    }
    console.log(`${FIND_WORK_LOG_PREFIX} refreshed tracking context for tab=${tabId} after navigation/load.`);

    const nextSession = {
        ...session,
        pageUrl: tabUrl,
        pageTitle: String(tab?.title || session.pageTitle || '').trim(),
        updatedAt: new Date().toISOString()
    };
    await setFindWorkTrackingSession(nextSession);

    await queueUpworkRunStatusUpdate(createFindWorkRunStatusUpdate({
        action: 'Tracking Find Work requests. Click filters or pagination to capture jobs.',
        itemCurrent: Number(nextSession.totalSaved) || 0,
        itemTotal: Number(nextSession.totalSaved) || 0,
        totalSaved: Number(nextSession.totalSaved) || 0,
        etaMs: null,
        etaText: 'waiting for activity',
        startedAt: nextSession.startedAt
    }));
}

async function startFindWorkJobListTrackingFlow() {
    await stopFindWorkTrackingSession({ updateRunStatus: false });

    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!currentTab?.id) {
        throw new Error('No active tab found for Find Work tracking.');
    }
    if (!isFindWorkPageUrl(currentTab.url)) {
        throw new Error('Find Work tracking requires the active tab to already be on an Upwork Find Work page.');
    }

    await waitForTabReady(currentTab.id, FIND_WORK_URL);
    const debuggerAttached = await startDebuggerCaptureForTab(currentTab.id, {
        captureMode: 'find-work'
    });
    if (!debuggerAttached) {
        throw new Error(
            'Find Work tracking requires debugger attachment. Close DevTools for this tab (if open) and retry.'
        );
    }
    const debuggerSession = debuggerSessions.get(currentTab.id);
    if (debuggerSession) {
        debuggerSession.findWorkPageUrl = String(currentTab.url || '').trim();
        debuggerSession.findWorkPageTitle = String(currentTab.title || '').trim();
    }
    console.log(`${FIND_WORK_LOG_PREFIX} debugger armed for tab=${currentTab.id} url=${currentTab.url}`);
    await logDebuggerToTab(
        currentTab.id,
        `${FIND_WORK_LOG_PREFIX} tracking armed for best matches. Click filters or pagination to capture requests.`
    );

    const storageData = await chrome.storage.local.get(FIND_WORK_JOB_LIST_STORAGE_KEY);
    const existingItems = Array.isArray(storageData[FIND_WORK_JOB_LIST_STORAGE_KEY])
        ? storageData[FIND_WORK_JOB_LIST_STORAGE_KEY]
        : [];
    const startedAtIso = new Date().toISOString();
    const session = {
        active: true,
        tabId: currentTab.id,
        transport: 'debugger',
        sourceTab: FIND_WORK_SOURCE_TAB,
        pageUrl: String(currentTab.url || '').trim(),
        pageTitle: String(currentTab.title || '').trim(),
        startedAt: startedAtIso,
        updatedAt: startedAtIso,
        responsesCaptured: 0,
        jobsObserved: 0,
        totalSaved: existingItems.length,
        lastResponseAt: null,
        lastEventSummary: null
    };

    await setUpworkRunControlState({ paused: false, stopRequested: false });
    await setFindWorkTrackingSession(session);
    console.log(
        `${FIND_WORK_LOG_PREFIX} session started tab=${currentTab.id} existingSaved=${existingItems.length}`
    );
    await queueUpworkRunStatusUpdate(createFindWorkRunStatusUpdate({
        action: 'Tracking Find Work requests. Click filters or pagination to capture jobs.',
        itemCurrent: existingItems.length,
        itemTotal: existingItems.length,
        totalSaved: existingItems.length,
        etaMs: null,
        etaText: 'waiting for activity',
        startedAt: startedAtIso
    }), { reset: true });
}

async function ensureInjectedScraperHelpers(tabId, options = {}) {
    const injectMainWorldHelpers = options.injectMainWorldHelpers !== false;

    if (injectMainWorldHelpers) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                files: MAIN_WORLD_SCRAPER_HELPER_FILES
            });
        } catch (error) {
            console.warn('Failed to inject main-world scraper helpers:', error);
        }
    }

    await chrome.scripting.executeScript({
        target: { tabId },
        files: INJECTED_SCRAPER_HELPER_FILES
    });
}
