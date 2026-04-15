(() => {
    if (window.__zitounaCaptureBridgeInstalled) {
        return;
    }

    const NETWORK_MONITOR_SOURCE = 'zitouna-network-monitor';
    const NETWORK_MONITOR_EVENT_TYPE = 'zitouna-transaction-response';
    const LOG_PREFIX = '[ZitounaCaptureBridge]';

    const handleMessage = (event) => {
        const data = event?.data;
        if (
            !data ||
            data.source !== NETWORK_MONITOR_SOURCE ||
            data.type !== NETWORK_MONITOR_EVENT_TYPE ||
            event.source !== window
        ) {
            return;
        }

        try {
            const payload = data.payload || null;
            if (payload && Array.isArray(payload.transactions) && payload.transactions.length > 0) {
                console.log(
                    `${LOG_PREFIX} forwarding ${payload.transactions.length} transactions ` +
                    `(seq=${payload.monitorSeq || '?'})`
                );
            }

            chrome.runtime.sendMessage({
                action: 'zitounaTransactionBatch',
                payload
            }, () => {
                if (chrome.runtime.lastError) {
                    // Ignore bridge delivery failures; the background may have reloaded.
                }
            });
        } catch (error) {
            // Ignore runtime bridge errors.
        }
    };

    window.addEventListener('message', handleMessage);
    window.__zitounaCaptureBridgeInstalled = true;
    console.log(`${LOG_PREFIX} installed`);
})();
