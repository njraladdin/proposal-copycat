// TikTok panel logic — exposed via mount function
window.mountTiktokPanel = function() {
    const STORAGE_KEY = 'tiktokComments';
    
    // UI Elements
    const btnScrape = document.getElementById('startTiktokScraping');
    const btnStopScrape = document.getElementById('stopTiktokScraping');
    const btnClear = document.getElementById('clearTiktokData');
    const btnLoad = document.getElementById('loadTiktokJson');
    const btnDownload = document.getElementById('downloadTiktokJson');
    const btnCopy = document.getElementById('copyTiktokJson');
    const warningEl = document.getElementById('authWarningTiktok');
    const countEl = document.getElementById('tiktokCommentCount');
    const textareaEl = document.getElementById('tiktokJsonOutput');
    const statusEl = document.getElementById('tiktokStatusHeadline');
    const limitEl = document.getElementById('tiktokScrapeLimit');

    let isJsonLoaded = false;

    // Build export filename
    function buildExportFilename() {
        const now = new Date();
        const pad = (v) => String(v).padStart(2, '0');
        return `tiktok-comments-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}.json`;
    }

    // Update UI state
    function updateDatasetView(dataArray) {
        const items = Array.isArray(dataArray) ? dataArray : [];
        if (countEl) countEl.textContent = String(items.length);
        if (textareaEl) textareaEl.value = JSON.stringify(items, null, 2);
        isJsonLoaded = true;
    }

    // Load from storage
    async function loadData(force = false) {
        if (!force && isJsonLoaded) return;
        
        try {
            if (btnLoad) {
                btnLoad.disabled = true;
                btnLoad.textContent = 'Loading...';
            }
            const data = await chrome.storage.local.get(STORAGE_KEY);
            updateDatasetView(data[STORAGE_KEY]);
        } catch (err) {
            console.error('Failed to load TikTok comments:', err);
            if (textareaEl) textareaEl.value = 'Failed to load JSON.';
        } finally {
            if (btnLoad) {
                btnLoad.disabled = false;
                btnLoad.textContent = 'Load JSON';
            }
        }
    }

    // Event Listeners
    if (btnScrape) {
        btnScrape.addEventListener('click', async () => {
            try {
                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!activeTab || !activeTab.url || !activeTab.url.includes('tiktok.com')) {
                    if (warningEl) warningEl.style.display = 'block';
                    if (statusEl) statusEl.textContent = 'Error: Not a TikTok page.';
                    return;
                }
                
                if (warningEl) warningEl.style.display = 'none';
                
                const maxLimit = parseInt(limitEl.value, 10) || 50;
                await chrome.storage.local.set({ tiktokIsMonitoring: true, tiktokMaxLimit: maxLimit });
                
                // Send message to background
                chrome.runtime.sendMessage({ action: 'startTiktokMonitor', maxLimit }, (response) => {
                    if (chrome.runtime.lastError) console.error(chrome.runtime.lastError);
                });
            } catch (err) {
                console.error(err);
            }
        });
    }

    if (btnStopScrape) {
        btnStopScrape.addEventListener('click', async () => {
            await chrome.storage.local.set({ tiktokIsMonitoring: false });
            chrome.runtime.sendMessage({ action: 'stopTiktokMonitor' });
        });
    }

    if (btnClear) {
        btnClear.addEventListener('click', async () => {
            if (confirm('Are you sure you want to clear all scraped TikTok comments?')) {
                await chrome.storage.local.remove(STORAGE_KEY);
                updateDatasetView([]);
                if (statusEl) statusEl.textContent = 'Data cleared.';
            }
        });
    }

    if (btnLoad) {
        btnLoad.addEventListener('click', () => loadData(true));
    }

    if (btnCopy) {
        btnCopy.addEventListener('click', async () => {
            if (!isJsonLoaded) await loadData(true);
            if (textareaEl && textareaEl.value) {
                await navigator.clipboard.writeText(textareaEl.value);
                const original = btnCopy.textContent;
                btnCopy.textContent = 'Copied!';
                setTimeout(() => btnCopy.textContent = original, 1500);
            }
        });
    }

    if (btnDownload) {
        btnDownload.addEventListener('click', async () => {
            try {
                const data = await chrome.storage.local.get(STORAGE_KEY);
                const payload = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
                
                const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = buildExportFilename();
                document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1500);
            } catch (err) {
                console.error('Download failed:', err);
                alert('Download failed.');
            }
        });
    }

    // Listen for storage changes
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local') {
            if (changes[STORAGE_KEY]) {
                if (countEl) {
                    const items = Array.isArray(changes[STORAGE_KEY].newValue) ? changes[STORAGE_KEY].newValue : [];
                    countEl.textContent = String(items.length);
                }
                if (isJsonLoaded) {
                    isJsonLoaded = false;
                    if (textareaEl) textareaEl.value = 'Data changed. Click "Load JSON" to refresh.';
                }
            }
            if (changes.tiktokIsMonitoring) {
                syncUIState(changes.tiktokIsMonitoring.newValue);
            }
            if (changes.tiktokMonitorStatus) {
                if (statusEl) statusEl.textContent = changes.tiktokMonitorStatus.newValue;
            }
        }
    });

    function syncUIState(isMonitoring) {
        if (isMonitoring) {
            if (btnScrape) btnScrape.style.display = 'none';
            if (btnStopScrape) btnStopScrape.style.display = 'inline-block';
            if (statusEl) statusEl.textContent = 'Monitoring... scroll comments down manually.';
        } else {
            if (btnScrape) btnScrape.style.display = 'inline-block';
            if (btnStopScrape) btnStopScrape.style.display = 'none';
            if (statusEl && statusEl.textContent.includes('Monitoring')) statusEl.textContent = 'Stopped.';
        }
    }

    // Init
    async function init() {
        if (textareaEl) textareaEl.value = 'JSON not loaded yet. Click "Load JSON".';
        
        // Initial state check
        try {
            const data = await chrome.storage.local.get([STORAGE_KEY, 'tiktokIsMonitoring', 'tiktokMonitorStatus']);
            const items = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
            if (countEl) countEl.textContent = String(items.length);
            syncUIState(data.tiktokIsMonitoring);
            if (data.tiktokMonitorStatus && statusEl) statusEl.textContent = data.tiktokMonitorStatus;
        } catch (e) {
            console.error(e);
        }
    }

    init();
};
