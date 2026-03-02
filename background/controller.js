const INJECTED_SCRAPER_HELPER_FILES = [
    'background/injected/job-post-page.js'
];
const MAIN_WORLD_SCRAPER_HELPER_FILES = [
    'background/injected/proposals-network-monitor.js'
];

const DEBUGGER_ENABLED_FOR_LIST_SCRAPE = true;
const DEBUGGER_PROTOCOL_VERSION = '1.3';
const DEBUGGER_TARGET_ORIGIN = 'https://www.upwork.com';
const DEBUGGER_TARGET_PATH = '/api/graphql/v1';
const DEBUGGER_TARGET_ALIAS = 'gql-query-proposalsbytype';
const DEBUGGER_GRAPHQL_PATH_PREFIX = '/api/graphql/';
const DEBUGGER_LOG_PREFIX = '[ProposalCopycatDebugger]';

const debuggerSessions = new Map();
let debuggerListenersInstalled = false;
let proposalListWriteQueue = Promise.resolve();

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

function isTargetGraphqlRequestUrl(urlValue) {
    try {
        const url = new URL(String(urlValue || ''), DEBUGGER_TARGET_ORIGIN);
        return (
            url.origin === DEBUGGER_TARGET_ORIGIN &&
            url.pathname === DEBUGGER_TARGET_PATH &&
            url.searchParams.get('alias') === DEBUGGER_TARGET_ALIAS
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

function aliasFromGraphqlUrl(urlValue) {
    try {
        const url = new URL(String(urlValue || ''), DEBUGGER_TARGET_ORIGIN);
        return String(url.searchParams.get('alias') || '').trim();
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
            debuggerSessions.delete(source.tabId);
            console.log(`${DEBUGGER_LOG_PREFIX} detached from tab ${source.tabId} (${reason}).`);
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
        const likelyProposals = isTargetGraphqlRequestUrl(request.url) ||
            isLikelyProposalsGraphqlRequest(request.url, request.postData);

        session.requests.set(requestId, {
            requestId,
            url: String(request.url || ''),
            method: String(request.method || 'GET').toUpperCase(),
            alias,
            likelyProposals,
            postData: String(request.postData || ''),
            requestStartedAtMs: Date.now(),
            responseMeta: null
        });
        session.stats.graphqlRequestsSeen += 1;
        if (likelyProposals) {
            session.stats.likelyProposalRequests += 1;
        }
        console.log(
            `${DEBUGGER_LOG_PREFIX} request captured tab=${tabId} id=${requestId} ` +
            `method=${String(request.method || 'GET').toUpperCase()} alias=${alias || 'none'} ` +
            `likely=${likelyProposals ? 'yes' : 'no'}`
        );
        if (likelyProposals || session.stats.graphqlRequestsSeen <= 10 || session.stats.graphqlRequestsSeen % 25 === 0) {
            await logDebuggerToTab(
                tabId,
                `${DEBUGGER_LOG_PREFIX} request captured alias=${alias || 'none'} likely=${likelyProposals ? 'yes' : 'no'} url=${String(request.url || '')}`
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
        if (!tracked.likelyProposals) {
            session.stats.nonProposalResponsesIgnored += 1;
            if (session.stats.nonProposalResponsesIgnored <= 8 || session.stats.nonProposalResponsesIgnored % 25 === 0) {
                const preview = responseText.replace(/\s+/g, ' ').slice(0, 100);
                console.log(
                    `${DEBUGGER_LOG_PREFIX} ignored non-proposal response tab=${tabId} id=${requestId} ` +
                    `alias=${tracked.alias || 'none'} len=${responseText.length} preview="${preview || '<empty>'}"`
                );
            }
            return;
        }
        const links = extractProposalLinksFromGraphqlResponse(responseText, session.scrapeMode);
        session.stats.responsesCaptured += 1;

        if (!links.length) {
            if (tracked.likelyProposals) {
                session.stats.parseFailed += 1;
            }
            if (tracked.likelyProposals || session.stats.responsesCaptured <= 10 || session.stats.responsesCaptured % 25 === 0) {
                const preview = responseText.replace(/\s+/g, ' ').slice(0, 100);
                console.log(
                    `${DEBUGGER_LOG_PREFIX} response captured tab=${tabId} id=${requestId} ` +
                    `alias=${tracked.alias || 'none'} likely=${tracked.likelyProposals ? 'yes' : 'no'} ` +
                    `len=${responseText.length} links=0 preview="${preview || '<empty>'}"`
                );
                await logDebuggerToTab(
                    tabId,
                    `${DEBUGGER_LOG_PREFIX} response alias=${tracked.alias || 'none'} likely=${tracked.likelyProposals ? 'yes' : 'no'} len=${responseText.length} links=0 preview="${preview || '<empty>'}"`
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
            `alias=${tracked.alias || 'none'} likely=${tracked.likelyProposals ? 'yes' : 'no'} ` +
            `len=${responseText.length} links=${links.length} ` +
            `upserted=${upsertResult?.upsertedCount || 0} totalList=${upsertResult?.totalSize || 0}`
        );
        await logDebuggerToTab(
            tabId,
            `${DEBUGGER_LOG_PREFIX} response alias=${tracked.alias || 'none'} likely=${tracked.likelyProposals ? 'yes' : 'no'} len=${responseText.length} links=${links.length} upserted=${upsertResult?.upsertedCount || 0} total=${upsertResult?.totalSize || 0}`
        );
    }
}

async function startDebuggerCaptureForTab(tabId, scrapeMode) {
    ensureDebuggerListeners();

    if (debuggerSessions.has(tabId)) {
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
            requests: new Map(),
            stats: {
                graphqlRequestsSeen: 0,
                likelyProposalRequests: 0,
                responsesCaptured: 0,
                nonProposalResponsesIgnored: 0,
                parseFailed: 0,
                linksRecovered: 0,
                upsertOps: 0,
                upsertedEntries: 0
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
            `likely=${stats.likelyProposalRequests} ` +
            `ignored=${stats.nonProposalResponsesIgnored} ` +
            `responses=${stats.responsesCaptured} links=${stats.linksRecovered} ` +
            `parseFailed=${stats.parseFailed} upserts=${stats.upsertOps}/${stats.upsertedEntries}`
        );
        console.log(summary);
        await logDebuggerToTab(tabId, summary);
    }
}

chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'startScraping') {
        const scrapeMode = normalizeScrapeMode(request.scrapeMode);
        startScrapingFlow(scrapeMode).catch((error) => {
            console.error('Failed to start proposal scraping:', error);
        });
        return;
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
    }
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
    await ensureInjectedScraperHelpers(targetTabId);
    await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        function: scrapeProposals,
        args: [{ scrapeMode, scrapeProposalDetailsFromList: true }]
    });
}

async function startArchivedListScrapingFlow(scrapeMode = DEFAULT_SCRAPE_MODE) {
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
        debuggerAttached = await startDebuggerCaptureForTab(targetTabId, scrapeMode);
    }
    await ensureInjectedScraperHelpers(targetTabId, {
        injectMainWorldHelpers: !debuggerAttached
    });

    try {
        await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            function: scrapeProposals,
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

async function startCurrentJobPostScrapingFlow() {
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
        function: scrapeProposals,
        args: [{ scrapeCurrentJobPost: true }]
    });
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
