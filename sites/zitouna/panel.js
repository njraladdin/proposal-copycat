// Banque Zitouna panel logic — exposed via mount function
window.mountZitounaPanel = function() {
    const STORAGE_KEY = 'zitounaTransactions';

    // UI Elements
    const btnStart = document.getElementById('startZitounaRecording');
    const btnStop = document.getElementById('stopZitounaRecording');
    const btnClear = document.getElementById('clearZitounaData');
    const btnLoad = document.getElementById('loadZitounaJson');
    const btnDownload = document.getElementById('downloadZitounaJson');
    const btnCopy = document.getElementById('copyZitounaJson');
    const warningEl = document.getElementById('authWarningZitouna');
    const countEl = document.getElementById('zitounaTransactionCount');
    const textareaEl = document.getElementById('zitounaJsonOutput');
    const statusEl = document.getElementById('zitounaStatusHeadline');

    let isJsonLoaded = false;

    // Build export filename
    function buildExportFilename() {
        const now = new Date();
        const pad = (v) => String(v).padStart(2, '0');
        return `zitouna-transactions-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}.json`;
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
            console.error('Failed to load Zitouna transactions:', err);
            if (textareaEl) textareaEl.value = 'Failed to load JSON.';
        } finally {
            if (btnLoad) {
                btnLoad.disabled = false;
                btnLoad.textContent = 'Load JSON';
            }
        }
    }

    // Event Listeners
    if (btnStart) {
        btnStart.addEventListener('click', async () => {
            try {
                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (
                    !activeTab ||
                    !activeTab.url ||
                    !activeTab.url.startsWith('https://tawassol.banquezitouna.com')
                ) {
                    if (warningEl) warningEl.style.display = 'block';
                    if (statusEl) statusEl.textContent = 'Error: Not a Banque Zitouna page.';
                    return;
                }

                if (warningEl) warningEl.style.display = 'none';
                await chrome.storage.local.set({ zitounaIsMonitoring: true });

                chrome.runtime.sendMessage({ action: 'startZitounaMonitor' }, (response) => {
                    if (chrome.runtime.lastError) console.error(chrome.runtime.lastError);
                });
            } catch (err) {
                console.error(err);
            }
        });
    }

    if (btnStop) {
        btnStop.addEventListener('click', async () => {
            await chrome.storage.local.set({ zitounaIsMonitoring: false });
            chrome.runtime.sendMessage({ action: 'stopZitounaMonitor' });
        });
    }

    if (btnClear) {
        btnClear.addEventListener('click', async () => {
            if (confirm('Are you sure you want to clear all captured Zitouna transactions?')) {
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
            if (changes.zitounaIsMonitoring) {
                syncUIState(changes.zitounaIsMonitoring.newValue);
            }
            if (changes.zitounaMonitorStatus) {
                if (statusEl) statusEl.textContent = changes.zitounaMonitorStatus.newValue;
            }
        }
    });

    function syncUIState(isMonitoring) {
        if (isMonitoring) {
            if (btnStart) btnStart.style.display = 'none';
            if (btnStop) btnStop.style.display = 'inline-block';
            if (statusEl) statusEl.textContent = 'Recording... browse and paginate through transactions.';
        } else {
            if (btnStart) btnStart.style.display = 'inline-block';
            if (btnStop) btnStop.style.display = 'none';
            if (statusEl && statusEl.textContent.includes('Recording')) statusEl.textContent = 'Stopped.';
        }
    }

    // Init
    async function init() {
        if (textareaEl) textareaEl.value = 'JSON not loaded yet. Click "Load JSON".';

        try {
            const data = await chrome.storage.local.get([STORAGE_KEY, 'zitounaIsMonitoring', 'zitounaMonitorStatus']);
            const items = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
            if (countEl) countEl.textContent = String(items.length);
            syncUIState(data.zitounaIsMonitoring);
            if (data.zitounaMonitorStatus && statusEl) statusEl.textContent = data.zitounaMonitorStatus;
        } catch (e) {
            console.error(e);
        }
    }

    init();
};
