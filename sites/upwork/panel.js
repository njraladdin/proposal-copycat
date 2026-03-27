// Upwork panel logic — loaded dynamically when the Upwork site tab is active.
// Mounted by the shared side panel shell.

window.mountUpworkPanel = function() {
    const upworkRunStatusModule = globalThis.ProposalCopycatUpworkRunStatusModule || {};
    const UPWORK_JOB_POST_URL_PATTERN = /^https:\/\/www\.upwork\.com\/jobs\/[^/?#]+/i;
    const UPWORK_SUBTAB_STORAGE_KEY = 'upworkActiveSubTab';
    const UPWORK_RUN_STATUS_STORAGE_KEY = upworkRunStatusModule.RUN_STATUS_STORAGE_KEY || 'upworkRunStatus';
    const UPWORK_RUN_CONTROL_STORAGE_KEY = upworkRunStatusModule.RUN_CONTROL_STORAGE_KEY || 'upworkRunControl';

    let isAuthValid = true;
    let isOnJobPostPage = false;
    let latestUpworkRunStatus = null;
    let latestUpworkRunControl = { paused: false, stopRequested: false };
    const DATASET_CONFIG = {
        proposalList: {
            storageKey: 'proposalList',
            countId: 'proposalListCount',
            textareaId: 'proposalListJsonOutput',
            loadButtonId: 'loadProposalListJson'
        },
        proposals: {
            storageKey: 'proposals',
            countId: 'proposalCount',
            textareaId: 'rawJsonOutput',
            loadButtonId: 'loadRawJson'
        },
        activeJobPost: {
            storageKey: 'activeJobPost',
            countId: 'activeJobPostCount',
            textareaId: 'activeJobJsonOutput',
            loadButtonId: 'loadActiveJobJson',
            autoLoad: true
        },
        jobPosts: {
            storageKey: 'jobPosts',
            countId: 'jobPostCount',
            textareaId: 'jobRawJsonOutput',
            loadButtonId: 'loadJobJson',
            autoLoad: true
        }
    };
    const datasetState = {
        proposalList: { loaded: false, dirty: false },
        proposals: { loaded: false, dirty: false },
        activeJobPost: { loaded: false, dirty: false },
        jobPosts: { loaded: false, dirty: false }
    };

    function normalizeScrapeMode(value) {
        return value === 'all' ? 'all' : 'successful';
    }

    function normalizeSubTab(value) {
        return value === 'jobPostsPanel' ? 'jobPostsPanel' : 'proposalsPanel';
    }

    function isUpworkJobPostUrl(url) {
        return UPWORK_JOB_POST_URL_PATTERN.test(String(url || ''));
    }

    function updateActionButtonState() {
        const startScrapingBtn = document.getElementById('startScraping');
        const startListScrapingBtn = document.getElementById('startListScraping');
        const startJobScrapingBtn = document.getElementById('startJobScraping');
        const startJobFromListScrapingBtn = document.getElementById('startJobFromListScraping');
        const repairSavedJobUrlsBtn = document.getElementById('repairSavedJobUrls');
        if (startScrapingBtn) startScrapingBtn.disabled = !isAuthValid;
        if (startListScrapingBtn) startListScrapingBtn.disabled = !isAuthValid;
        if (startJobFromListScrapingBtn) startJobFromListScrapingBtn.disabled = !isAuthValid;
        if (startJobScrapingBtn) startJobScrapingBtn.disabled = !isAuthValid || !isOnJobPostPage;
        if (repairSavedJobUrlsBtn) {
            repairSavedJobUrlsBtn.disabled = false;
        }
    }

    function showAuthWarning() {
        const warning = document.getElementById('authWarning');
        if (warning) warning.style.display = 'block';
        isAuthValid = false;
        updateActionButtonState();
    }

    function removeAuthWarning() {
        const warning = document.getElementById('authWarning');
        if (warning) warning.style.display = 'none';
        isAuthValid = true;
        updateActionButtonState();
    }

    function setJobPageWarning(isVisible) {
        const warning = document.getElementById('jobPageWarning');
        if (warning) warning.style.display = isVisible ? 'block' : 'none';
    }

    async function checkUpworkAuth() {
        try {
            const upworkTabs = await chrome.tabs.query({ url: ['https://www.upwork.com/*'] });

            if (!upworkTabs.length) {
                removeAuthWarning();
                return true;
            }

            const tabToCheck = upworkTabs.find((tab) => tab.active) || upworkTabs[0];
            if (!tabToCheck?.id) {
                removeAuthWarning();
                return true;
            }

            const [authCheck] = await chrome.scripting.executeScript({
                target: { tabId: tabToCheck.id },
                function: () => {
                    const currentUrl = window.location.href.toLowerCase();
                    const bodyText = (document.body?.innerText || '').toLowerCase();

                    const isLoginPage =
                        currentUrl.includes('/ab/account-security/login') ||
                        currentUrl.includes('/login');

                    const hasLoginPrompt =
                        bodyText.includes('log in to upwork') ||
                        bodyText.includes('continue with google') ||
                        bodyText.includes('forgot password');

                    return { isLoginPage, hasLoginPrompt };
                }
            });

            if (authCheck?.result?.isLoginPage || authCheck?.result?.hasLoginPrompt) {
                showAuthWarning();
                return false;
            }

            removeAuthWarning();
            return true;
        } catch (error) {
            console.warn('Unable to verify auth automatically:', error);
            removeAuthWarning();
            return true;
        }
    }

    async function refreshJobPageState() {
        try {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            isOnJobPostPage = isUpworkJobPostUrl(activeTab?.url);
            setJobPageWarning(!isOnJobPostPage);
        } catch (error) {
            console.warn('Unable to inspect active tab URL:', error);
            isOnJobPostPage = false;
            setJobPageWarning(true);
        }
        updateActionButtonState();
        return isOnJobPostPage;
    }

    function normalizeDatasetItems(value) {
        return Array.isArray(value) ? value : [];
    }

    function setDatasetCount(datasetKey, value) {
        const config = DATASET_CONFIG[datasetKey];
        if (!config) return;
        const items = normalizeDatasetItems(value);
        const el = document.getElementById(config.countId);
        if (el) el.textContent = String(items.length);
    }

    function setDatasetPlaceholder(datasetKey, message) {
        const config = DATASET_CONFIG[datasetKey];
        if (!config) return;
        const el = document.getElementById(config.textareaId);
        if (el) el.value = message;
    }

    function isAutoLoadDataset(datasetKey) {
        return DATASET_CONFIG[datasetKey]?.autoLoad === true;
    }

    function markDatasetDirty(datasetKey) {
        const state = datasetState[datasetKey];
        if (!state) return;
        state.loaded = false;
        state.dirty = true;
        setDatasetPlaceholder(datasetKey, 'Data changed. Click "Load JSON" to refresh.');
    }

    function renderDatasetJson(datasetKey, value) {
        const config = DATASET_CONFIG[datasetKey];
        if (!config) return;
        const items = normalizeDatasetItems(value);
        setDatasetCount(datasetKey, items);
        const el = document.getElementById(config.textareaId);
        if (el) el.value = JSON.stringify(items, null, 2);
        datasetState[datasetKey].loaded = true;
        datasetState[datasetKey].dirty = false;
    }

    async function loadDatasetJson(datasetKey, options = {}) {
        const config = DATASET_CONFIG[datasetKey];
        const state = datasetState[datasetKey];
        if (!config || !state) return;

        const force = options.force === true;
        if (!force && state.loaded && !state.dirty) return;

        const loadButton = document.getElementById(config.loadButtonId);
        const originalText = loadButton?.textContent || 'Load JSON';
        if (loadButton) {
            loadButton.disabled = true;
            loadButton.textContent = 'Loading...';
        }

        try {
            const storageData = await chrome.storage.local.get(config.storageKey);
            const items = normalizeDatasetItems(storageData[config.storageKey]);
            await new Promise((resolve) => setTimeout(resolve, 0));
            renderDatasetJson(datasetKey, items);
        } catch (error) {
            console.error(`Failed to load ${config.storageKey} JSON:`, error);
            setDatasetPlaceholder(datasetKey, `Failed to load ${config.storageKey}. Check console.`);
        } finally {
            if (loadButton) {
                loadButton.disabled = false;
                loadButton.textContent = originalText;
            }
        }
    }

    async function ensureDatasetLoaded(datasetKey) {
        const state = datasetState[datasetKey];
        if (!state || (state.loaded && !state.dirty)) return;
        await loadDatasetJson(datasetKey, { force: true });
    }

    async function refreshCountsOnly() {
        const data = await chrome.storage.local.get(['proposalList', 'proposals', 'activeJobPost', 'jobPosts']);
        setDatasetCount('proposalList', data.proposalList);
        setDatasetCount('proposals', data.proposals);
        setDatasetCount('activeJobPost', data.activeJobPost);
        setDatasetCount('jobPosts', data.jobPosts);
    }

    function formatDateTime(value) {
        const ms = Date.parse(String(value || ''));
        if (!Number.isFinite(ms)) return '-';
        return new Date(ms).toLocaleString();
    }

    function formatDurationShort(ms) {
        if (!Number.isFinite(ms) || ms <= 0) return '<1m';
        const totalSeconds = Math.max(1, Math.round(ms / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (hours > 0) return `${hours}h ${minutes}m`;
        if (minutes > 0) return `${minutes}m ${seconds}s`;
        return `${seconds}s`;
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function renderLiveRunStatus(runStatus, runControl = latestUpworkRunControl) {
        const modeEl = document.getElementById('liveRunMode');
        const headlineEl = document.getElementById('liveRunHeadline');
        const countsEl = document.getElementById('liveRunCounts');
        const etaEl = document.getElementById('liveRunEta');
        const scopeEl = document.getElementById('liveRunScope');
        const errorsEl = document.getElementById('liveRunErrors');
        const savedEl = document.getElementById('liveRunSaved');
        const updatedAtEl = document.getElementById('liveRunUpdatedAt');
        const pauseButton = document.getElementById('toggleUpworkRunPause');
        const stopButton = document.getElementById('stopUpworkRun');
        const recentErrorsSectionEl = document.getElementById('liveRunRecentErrorsSection');
        const recentErrorsEl = document.getElementById('liveRunRecentErrors');

        if (!modeEl || !headlineEl || !countsEl || !etaEl || !scopeEl || !errorsEl || !savedEl || !updatedAtEl || !pauseButton || !stopButton || !recentErrorsSectionEl || !recentErrorsEl) {
            return;
        }

        const safeStatus = runStatus && typeof runStatus === 'object' ? runStatus : null;
        latestUpworkRunStatus = safeStatus;
        latestUpworkRunControl = runControl && typeof runControl === 'object'
            ? {
                paused: runControl.paused === true,
                stopRequested: runControl.stopRequested === true
            }
            : { paused: false, stopRequested: false };

        if (!safeStatus) {
            modeEl.textContent = 'Mode: -';
            headlineEl.textContent = 'No active Upwork run.';
            countsEl.textContent = 'Items: -';
            etaEl.textContent = 'ETA: -';
            scopeEl.textContent = 'Scope: -';
            errorsEl.textContent = 'Errors: 0';
            savedEl.textContent = 'Saved: 0';
            updatedAtEl.textContent = 'Updated: -';
            recentErrorsSectionEl.style.display = 'none';
            recentErrorsEl.innerHTML = '';
            pauseButton.disabled = true;
            pauseButton.textContent = 'Pause Run';
            stopButton.disabled = true;
            stopButton.textContent = 'Stop Run';
            return;
        }

        const paused = latestUpworkRunControl.paused === true || safeStatus.isPaused === true;
        const stopRequested = latestUpworkRunControl.stopRequested === true || safeStatus.stopRequested === true;
        const itemCurrent = Number.parseInt(String(safeStatus.itemCurrent || 0), 10) || 0;
        const itemTotal = Number.parseInt(String(safeStatus.itemTotal || 0), 10) || 0;
        const totalSaved = Number.parseInt(String(safeStatus.totalSaved || 0), 10) || 0;
        const errorTotal = Number.parseInt(String(safeStatus.errorTotal || 0), 10) || 0;
        const etaMs = Number.parseInt(String(safeStatus.etaMs || 0), 10);
        const itemProgressText = itemTotal > 0 ? `${Math.min(itemCurrent, itemTotal)}/${itemTotal}` : '-';
        const statusTitle = String(safeStatus.statusTitle || 'Current Upwork Run').trim() || 'Current Upwork Run';
        const actionText = String(safeStatus.action || (safeStatus.inProgress ? 'Running...' : 'Idle')).trim();
        const scopeLabel = String(safeStatus.listProgressLabel || 'Scope').trim() || 'Scope';
        const scopeText = String(safeStatus.listProgressText || '-').trim() || '-';
        const errorSummary = String(safeStatus.errorSummary || '').trim();
        const recentErrors = Array.isArray(safeStatus.recentErrors) ? safeStatus.recentErrors.slice(0, 3) : [];

        modeEl.textContent = safeStatus.modeBadgeText
            ? `Mode: ${safeStatus.modeBadgeText}`
            : 'Mode: -';
        headlineEl.textContent = `${statusTitle}${safeStatus.inProgress ? (stopRequested ? ' (stopping)' : (paused ? ' (paused)' : '')) : ''}: ${actionText}`;
        countsEl.textContent = `Items: ${itemProgressText}`;
        etaEl.textContent = safeStatus.inProgress
            ? `ETA: ${stopRequested ? 'stopping...' : (paused ? 'paused' : (Number.isFinite(etaMs) && etaMs > 0 ? formatDurationShort(etaMs) : 'calculating...'))}`
            : 'ETA: done';
        scopeEl.textContent = `${scopeLabel}: ${scopeText}`;
        errorsEl.textContent = `Errors: ${errorTotal}${errorSummary ? ` (${errorSummary})` : ''}`;
        savedEl.textContent = `Saved: ${totalSaved}`;
        updatedAtEl.textContent = `Updated: ${formatDateTime(safeStatus.updatedAt)}`;
        if (recentErrors.length > 0) {
            recentErrorsSectionEl.style.display = 'block';
            recentErrorsEl.innerHTML = recentErrors
                .map((entry) => `
                    <div style="font-size: 11px; color: #495057; line-height: 1.35;">
                        <span style="font-weight: 700; color: #b02a37;">${escapeHtml(entry?.type || 'error')}</span>
                        <span>: ${escapeHtml(entry?.message || 'Unknown error')}</span>
                        ${entry?.source ? `<div style="color: #6c757d; margin-top: 2px;">${escapeHtml(entry.source)}</div>` : ''}
                    </div>
                `)
                .join('');
        } else {
            recentErrorsSectionEl.style.display = 'none';
            recentErrorsEl.innerHTML = '';
        }
        pauseButton.disabled = !(safeStatus.inProgress && safeStatus.pauseSupported === true && !stopRequested);
        pauseButton.textContent = paused ? 'Resume Run' : 'Pause Run';
        stopButton.disabled = !(safeStatus.inProgress && safeStatus.stopSupported === true) || stopRequested;
        stopButton.textContent = stopRequested && safeStatus.inProgress ? 'Stopping...' : 'Stop Run';
    }

    function buildExportFilename(prefix) {
        const now = new Date();
        const pad = (value) => String(value).padStart(2, '0');
        const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
        return `${prefix}-${timestamp}.json`;
    }

    async function copyFromTextarea(buttonId, textareaId) {
        const button = document.getElementById(buttonId);
        if (!button) return;
        const originalText = button.textContent;
        const textarea = document.getElementById(textareaId);
        if (textarea) await navigator.clipboard.writeText(textarea.value);
        button.textContent = 'Copied';
        setTimeout(() => { button.textContent = originalText; }, 1200);
    }

    async function downloadJson(buttonId, storageKey, filenamePrefix) {
        const button = document.getElementById(buttonId);
        if (!button) return;
        const originalText = button.textContent;

        try {
            const data = await chrome.storage.local.get(storageKey);
            const payload = Array.isArray(data[storageKey]) ? data[storageKey] : [];

            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = buildExportFilename(filenamePrefix);
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1500);

            button.textContent = 'Downloaded';
        } catch (error) {
            console.error(`Failed to export ${storageKey}:`, error);
            button.textContent = 'Failed';
        }

        setTimeout(() => { button.textContent = originalText; }, 1400);
    }

    function activateSubTab(panelId) {
        const nextPanelId = normalizeSubTab(panelId);
        const tabButtons = Array.from(document.querySelectorAll('.site-tab-btn'));
        const tabPanels = Array.from(document.querySelectorAll('.site-tab-panel'));

        for (const button of tabButtons) {
            button.classList.toggle('active', button.dataset.tab === nextPanelId);
        }
        for (const panel of tabPanels) {
            panel.classList.toggle('active', panel.id === nextPanelId);
        }

        chrome.storage.local.set({ [UPWORK_SUBTAB_STORAGE_KEY]: nextPanelId }).catch((error) => {
            console.warn('Failed to persist Upwork sub-tab state:', error);
        });
    }

    // --- Wire up event listeners ---

    function addClickListener(id, handler) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', handler);
    }

    addClickListener('tabProposals', () => activateSubTab('proposalsPanel'));
    addClickListener('tabJobPosts', async () => {
        activateSubTab('jobPostsPanel');
        await refreshJobPageState();
    });

    addClickListener('toggleUpworkRunPause', async () => {
        const canToggle = latestUpworkRunStatus?.inProgress &&
            latestUpworkRunStatus?.pauseSupported === true &&
            latestUpworkRunControl?.stopRequested !== true;
        if (!canToggle) return;

        const nextPaused = !(latestUpworkRunControl?.paused === true || latestUpworkRunStatus?.isPaused === true);
        latestUpworkRunControl = { paused: nextPaused, stopRequested: false };
        renderLiveRunStatus(latestUpworkRunStatus, latestUpworkRunControl);

        try {
            await chrome.storage.local.set({
                [UPWORK_RUN_CONTROL_STORAGE_KEY]: {
                    paused: nextPaused,
                    stopRequested: false,
                    updatedAt: new Date().toISOString()
                }
            });
        } catch (error) {
            console.error('Failed to update Upwork run pause state:', error);
            const refreshed = await chrome.storage.local.get(UPWORK_RUN_CONTROL_STORAGE_KEY);
            renderLiveRunStatus(latestUpworkRunStatus, refreshed[UPWORK_RUN_CONTROL_STORAGE_KEY]);
        }
    });

    addClickListener('stopUpworkRun', async () => {
        const canStop = latestUpworkRunStatus?.inProgress &&
            latestUpworkRunStatus?.stopSupported === true &&
            latestUpworkRunControl?.stopRequested !== true;
        if (!canStop) return;

        latestUpworkRunControl = { paused: false, stopRequested: true };
        renderLiveRunStatus(latestUpworkRunStatus, latestUpworkRunControl);

        try {
            await chrome.storage.local.set({
                [UPWORK_RUN_CONTROL_STORAGE_KEY]: {
                    paused: false,
                    stopRequested: true,
                    updatedAt: new Date().toISOString()
                }
            });
        } catch (error) {
            console.error('Failed to request Upwork run stop:', error);
            const refreshed = await chrome.storage.local.get(UPWORK_RUN_CONTROL_STORAGE_KEY);
            renderLiveRunStatus(latestUpworkRunStatus, refreshed[UPWORK_RUN_CONTROL_STORAGE_KEY]);
        }
    });

    const scrapeModeEl = document.getElementById('scrapeMode');
    if (scrapeModeEl) {
        scrapeModeEl.addEventListener('change', async (event) => {
            const scrapeMode = normalizeScrapeMode(event.target.value);
            await chrome.storage.local.set({ scrapeMode });
        });
    }

    addClickListener('startListScraping', async () => {
        const canProceed = await checkUpworkAuth();
        if (!canProceed) return;
        const scrapeMode = normalizeScrapeMode(document.getElementById('scrapeMode').value);
        await chrome.storage.local.set({ scrapeMode });
        chrome.runtime.sendMessage({ action: 'startArchivedListScraping', scrapeMode });
    });

    addClickListener('startScraping', async () => {
        const canProceed = await checkUpworkAuth();
        if (!canProceed) return;
        const scrapeMode = normalizeScrapeMode(document.getElementById('scrapeMode').value);
        await chrome.storage.local.set({ scrapeMode });
        chrome.runtime.sendMessage({ action: 'startScraping', scrapeMode });
    });

    addClickListener('startJobScraping', async () => {
        const canProceed = await checkUpworkAuth();
        if (!canProceed) return;
        const isValidJobPage = await refreshJobPageState();
        if (!isValidJobPage) return;
        chrome.runtime.sendMessage({ action: 'startCurrentJobPostScraping' });
    });

    addClickListener('startJobFromListScraping', async () => {
        const canProceed = await checkUpworkAuth();
        if (!canProceed) return;
        const scrapeMode = normalizeScrapeMode(document.getElementById('scrapeMode').value);
        await chrome.storage.local.set({ scrapeMode });
        chrome.runtime.sendMessage({ action: 'startJobPostsFromSavedListScraping', scrapeMode });
    });

    addClickListener('repairSavedJobUrls', async () => {
        const button = document.getElementById('repairSavedJobUrls');
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Repairing...';

        try {
            const result = await chrome.runtime.sendMessage({ action: 'repairSavedJobPostUrls' });
            if (!result?.ok) {
                throw new Error(result?.error || 'Unknown repair failure');
            }

            const summary = result.summary || {};
            await refreshCountsOnly();

            for (const datasetKey of ['proposalList', 'proposals', 'activeJobPost', 'jobPosts']) {
                if (!datasetState[datasetKey]) continue;
                if (isAutoLoadDataset(datasetKey)) {
                    await loadDatasetJson(datasetKey, { force: true });
                    continue;
                }
                markDatasetDirty(datasetKey);
            }

            alert(
                'Repair complete.\n' +
                `Proposal list: ${summary.proposalListCount || 0}\n` +
                `Detailed proposals: ${summary.proposalsCount || 0}\n` +
                `With raw GraphQL: ${summary.proposalsWithRawGraphql || 0}\n` +
                `Updated proposal URLs: ${summary.proposalsUpdated || 0}\n` +
                `Missing derived URL: ${summary.proposalsDerivedUrlMissing || 0}\n` +
                `Unique job URLs now: ${summary.uniqueJobUrlsAfterRepair || 0}\n` +
                `Updated existing job posts: ${summary.jobPostsUpdated || 0}`
            );
        } catch (error) {
            alert(`Repair failed: ${error?.message || 'unknown error'}`);
        } finally {
            button.disabled = false;
            button.textContent = originalText;
        }
    });

    addClickListener('clearData', async () => {
        if (!confirm('Are you sure you want to clear all scraped proposals?')) return;
        await chrome.storage.local.remove(['proposals', 'prompt', 'promptEdited', 'portfolio', 'dataView']);
        renderDatasetJson('proposals', []);
    });

    addClickListener('clearProposalList', async () => {
        if (!confirm('Are you sure you want to clear archived proposal list data?')) return;
        await chrome.storage.local.remove(['proposalList']);
        renderDatasetJson('proposalList', []);
    });

    addClickListener('clearProposalDetails', async () => {
        if (!confirm('Are you sure you want to clear captured proposal details data?')) return;
        await chrome.storage.local.remove(['proposals']);
        renderDatasetJson('proposals', []);
    });

    addClickListener('clearCurrentJobPost', async () => {
        if (!confirm('Are you sure you want to clear the active job page data?')) return;
        await chrome.storage.local.remove(['activeJobPost']);
        renderDatasetJson('activeJobPost', []);
    });

    addClickListener('clearJobPosts', async () => {
        if (!confirm('Are you sure you want to clear saved job post data?')) return;
        await chrome.storage.local.remove(['jobPosts']);
        renderDatasetJson('jobPosts', []);
    });

    addClickListener('copyRawJson', async () => {
        await ensureDatasetLoaded('proposals');
        await copyFromTextarea('copyRawJson', 'rawJsonOutput');
    });

    addClickListener('copyProposalListJson', async () => {
        await ensureDatasetLoaded('proposalList');
        await copyFromTextarea('copyProposalListJson', 'proposalListJsonOutput');
    });

    addClickListener('copyActiveJobJson', async () => {
        await ensureDatasetLoaded('activeJobPost');
        await copyFromTextarea('copyActiveJobJson', 'activeJobJsonOutput');
    });

    addClickListener('copyJobJson', async () => {
        await ensureDatasetLoaded('jobPosts');
        await copyFromTextarea('copyJobJson', 'jobRawJsonOutput');
    });

    addClickListener('loadRawJson', async () => {
        await loadDatasetJson('proposals', { force: true });
    });

    addClickListener('loadProposalListJson', async () => {
        await loadDatasetJson('proposalList', { force: true });
    });

    addClickListener('loadActiveJobJson', async () => {
        await loadDatasetJson('activeJobPost', { force: true });
    });

    addClickListener('loadJobJson', async () => {
        await loadDatasetJson('jobPosts', { force: true });
    });

    addClickListener('downloadProposalListJson', async () => {
        await downloadJson('downloadProposalListJson', 'proposalList', 'proposal-list');
    });

    addClickListener('downloadRawJson', async () => {
        await downloadJson('downloadRawJson', 'proposals', 'proposals');
    });

    addClickListener('downloadActiveJobJson', async () => {
        await downloadJson('downloadActiveJobJson', 'activeJobPost', 'active-job-post');
    });

    addClickListener('downloadJobJson', async () => {
        await downloadJson('downloadJobJson', 'jobPosts', 'job-posts');
    });

    // --- Storage change listener ---

    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace !== 'local') return;

        if (changes.proposals) {
            setDatasetCount('proposals', changes.proposals.newValue);
            if (datasetState.proposals.loaded) {
                markDatasetDirty('proposals');
            }
        }
        if (changes.proposalList) {
            setDatasetCount('proposalList', changes.proposalList.newValue);
            if (datasetState.proposalList.loaded) {
                markDatasetDirty('proposalList');
            }
        }
        if (changes.activeJobPost) {
            if (isAutoLoadDataset('activeJobPost')) {
                renderDatasetJson('activeJobPost', changes.activeJobPost.newValue);
            } else {
                setDatasetCount('activeJobPost', changes.activeJobPost.newValue);
                if (datasetState.activeJobPost.loaded) {
                    markDatasetDirty('activeJobPost');
                }
            }
        }
        if (changes.jobPosts) {
            if (isAutoLoadDataset('jobPosts')) {
                renderDatasetJson('jobPosts', changes.jobPosts.newValue);
            } else {
                setDatasetCount('jobPosts', changes.jobPosts.newValue);
                if (datasetState.jobPosts.loaded) {
                    markDatasetDirty('jobPosts');
                }
            }
        }
        if (changes[UPWORK_RUN_STATUS_STORAGE_KEY]) {
            renderLiveRunStatus(changes[UPWORK_RUN_STATUS_STORAGE_KEY].newValue, latestUpworkRunControl);
        }
        if (changes[UPWORK_RUN_CONTROL_STORAGE_KEY]) {
            renderLiveRunStatus(latestUpworkRunStatus, changes[UPWORK_RUN_CONTROL_STORAGE_KEY].newValue);
        }
    });

    // --- Initialize ---

    async function initializeUpworkPanel() {
        const data = await chrome.storage.local.get([
            'scrapeMode',
            UPWORK_SUBTAB_STORAGE_KEY,
            UPWORK_RUN_STATUS_STORAGE_KEY,
            UPWORK_RUN_CONTROL_STORAGE_KEY,
            'activeJobPost',
            'jobPosts'
        ]);

        setDatasetPlaceholder('proposalList', 'JSON not loaded yet. Click "Load JSON".');
        setDatasetPlaceholder('proposals', 'JSON not loaded yet. Click "Load JSON".');
        renderDatasetJson('activeJobPost', data.activeJobPost);
        renderDatasetJson('jobPosts', data.jobPosts);
        renderLiveRunStatus(data[UPWORK_RUN_STATUS_STORAGE_KEY], data[UPWORK_RUN_CONTROL_STORAGE_KEY]);

        const scrapeModeSelect = document.getElementById('scrapeMode');
        if (scrapeModeSelect) {
            scrapeModeSelect.value = normalizeScrapeMode(data.scrapeMode);
        }

        activateSubTab(normalizeSubTab(data[UPWORK_SUBTAB_STORAGE_KEY]));

        await checkUpworkAuth();
        await refreshJobPageState();

        setTimeout(() => {
            refreshCountsOnly().catch((error) => {
                console.warn('Failed to refresh dataset counts:', error);
            });
        }, 0);
    }

    initializeUpworkPanel().catch((error) => {
        console.error('Upwork panel initialization failed:', error);
    });
};
