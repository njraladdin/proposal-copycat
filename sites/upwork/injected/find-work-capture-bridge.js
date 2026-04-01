(() => {
    if (window.__proposalCopycatFindWorkCaptureBridgeInstalled) {
        return;
    }

    const NETWORK_MONITOR_SOURCE = 'proposal-copycat-find-work-monitor';
    const NETWORK_MONITOR_RESPONSE_TYPE = 'graphql-response';
    const LOG_PREFIX = '[ProposalCopycatFindWorkBridge]';

    const handleMessage = (event) => {
        const data = event?.data;
        if (
            !data ||
            data.source !== NETWORK_MONITOR_SOURCE ||
            data.type !== NETWORK_MONITOR_RESPONSE_TYPE ||
            event.source !== window
        ) {
            return;
        }

        try {
            if (data?.payload?.isTargetOperation === true) {
                // eslint-disable-next-line no-console
                console.log(
                    `${LOG_PREFIX} forwarding ` +
                    `alias=${String(data?.payload?.graphqlAlias || '').trim() || 'none'} ` +
                    `match=${String(data?.payload?.matchReason || '').trim() || 'none'} ` +
                    `status=${data?.payload?.status ?? '?'}`
                );
            }
            chrome.runtime.sendMessage({
                action: 'upworkFindWorkCaptureEvent',
                payload: data.payload || null
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
    window.__proposalCopycatFindWorkCaptureBridgeInstalled = true;
    // eslint-disable-next-line no-console
    console.log(`${LOG_PREFIX} installed`);
})();
