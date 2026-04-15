/**
 * Background controller for Banque Zitouna transaction history capture.
 *
 * Handles start/stop monitoring and incoming transaction batches from
 * the content-script capture bridge.
 */

const ZITOUNA_STORAGE_KEY = 'zitounaTransactions';
const ZITOUNA_IS_MONITORING_KEY = 'zitounaIsMonitoring';
const ZITOUNA_STATUS_KEY = 'zitounaMonitorStatus';
const ZITOUNA_TARGET_ORIGIN = 'https://tawassol.banquezitouna.com';
const ZITOUNA_LOG_PREFIX = '[ZitounaController]';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startZitounaMonitor') {
        handleStartZitounaMonitor(sendResponse);
        return true;
    } else if (message.action === 'stopZitounaMonitor') {
        handleStopZitounaMonitor();
        sendResponse({ success: true });
    } else if (message.action === 'zitounaTransactionBatch') {
        handleIncomingTransactions(message.payload);
        // No response needed
    }
});

async function handleStartZitounaMonitor(sendResponse) {
    try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (
            !activeTab ||
            !activeTab.id ||
            !activeTab.url ||
            !activeTab.url.startsWith(ZITOUNA_TARGET_ORIGIN)
        ) {
            await chrome.storage.local.set({
                [ZITOUNA_IS_MONITORING_KEY]: false,
                [ZITOUNA_STATUS_KEY]: 'Error: Active tab is not a Banque Zitouna page.'
            });
            sendResponse({ success: false, error: 'Active tab is not a Banque Zitouna page.' });
            return;
        }

        // Inject network monitor into MAIN world (to patch fetch/XHR)
        try {
            await chrome.scripting.executeScript({
                target: { tabId: activeTab.id },
                world: 'MAIN',
                files: ['sites/zitouna/injected/network-monitor.js']
            });
        } catch (error) {
            console.warn(`${ZITOUNA_LOG_PREFIX} Network monitor injection failed:`, error);
        }

        // Inject capture bridge into ISOLATED world (to forward via chrome.runtime)
        try {
            await chrome.scripting.executeScript({
                target: { tabId: activeTab.id },
                files: ['sites/zitouna/injected/capture-bridge.js']
            });
        } catch (error) {
            console.warn(`${ZITOUNA_LOG_PREFIX} Capture bridge injection failed:`, error);
        }

        await chrome.storage.local.set({
            [ZITOUNA_IS_MONITORING_KEY]: true,
            [ZITOUNA_STATUS_KEY]: 'Recording... browse and paginate through transactions.'
        });

        console.log(`${ZITOUNA_LOG_PREFIX} monitoring started for tab=${activeTab.id}`);
        sendResponse({ success: true });
    } catch (error) {
        console.error(`${ZITOUNA_LOG_PREFIX} Error starting monitor:`, error);
        await chrome.storage.local.set({
            [ZITOUNA_IS_MONITORING_KEY]: false,
            [ZITOUNA_STATUS_KEY]: 'Error: ' + error.message
        });
        sendResponse({ success: false, error: error.toString() });
    }
}

async function handleStopZitounaMonitor() {
    await chrome.storage.local.set({
        [ZITOUNA_IS_MONITORING_KEY]: false,
        [ZITOUNA_STATUS_KEY]: 'Stopped.'
    });
    console.log(`${ZITOUNA_LOG_PREFIX} monitoring stopped.`);
}

/**
 * Build a unique key for a transaction to prevent duplicates.
 * TransactionId alone is not unique (multiple entries share the same one),
 * so we combine TransactionId + OperationDate + Amount.
 */
function buildTransactionKey(tx) {
    const id = String(tx.TransactionId || '').trim();
    const date = String(tx.OperationDate || '').trim();
    const amount = String(tx.Amount || '').trim();
    return `${id}|${date}|${amount}`;
}

async function handleIncomingTransactions(payload) {
    try {
        const isMonitoringObj = await chrome.storage.local.get(ZITOUNA_IS_MONITORING_KEY);
        if (!isMonitoringObj[ZITOUNA_IS_MONITORING_KEY]) {
            return; // Discard if stopped
        }

        const newTransactions = Array.isArray(payload?.transactions) ? payload.transactions : [];
        if (newTransactions.length === 0) {
            return;
        }

        const bankAccountId = String(payload?.bankAccountId || '').trim();
        const currency = String(payload?.currency || '').trim();
        const capturedAt = new Date(payload?.capturedAtMs || Date.now()).toISOString();

        const storageData = await chrome.storage.local.get(ZITOUNA_STORAGE_KEY);
        const existingTransactions = Array.isArray(storageData[ZITOUNA_STORAGE_KEY])
            ? storageData[ZITOUNA_STORAGE_KEY]
            : [];

        // Build set of existing keys for dedup
        const existingKeys = new Set(existingTransactions.map(buildTransactionKey));

        let addedCount = 0;
        const updatedList = [...existingTransactions];

        for (const tx of newTransactions) {
            const key = buildTransactionKey(tx);
            if (existingKeys.has(key)) {
                continue;
            }
            existingKeys.add(key);
            updatedList.push({
                ...tx,
                _bankAccountId: bankAccountId,
                _currency: currency,
                _capturedAt: capturedAt
            });
            addedCount++;
        }

        if (addedCount > 0) {
            // Sort by OperationDate descending (DD/MM/YYYY format)
            updatedList.sort((a, b) => {
                const parseDate = (dateStr) => {
                    const parts = String(dateStr || '').split('/');
                    if (parts.length !== 3) return 0;
                    return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`).getTime() || 0;
                };
                return parseDate(b.OperationDate) - parseDate(a.OperationDate);
            });

            await chrome.storage.local.set({ [ZITOUNA_STORAGE_KEY]: updatedList });
            await chrome.storage.local.set({
                [ZITOUNA_STATUS_KEY]: `Recording... ${updatedList.length} transactions captured (added ${addedCount} new).`
            });

            console.log(
                `${ZITOUNA_LOG_PREFIX} added ${addedCount} new transactions, total=${updatedList.length}`
            );
        }
    } catch (err) {
        console.error(`${ZITOUNA_LOG_PREFIX} Error handling incoming transactions:`, err);
    }
}
