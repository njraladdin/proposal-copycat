(() => {
    if (window.__zitounaNetworkMonitorInstalled) {
        return;
    }

    const SOURCE = 'zitouna-network-monitor';
    const EVENT_TYPE = 'zitouna-transaction-response';
    const TARGET_ORIGIN = 'https://tawassol.banquezitouna.com';
    const TARGET_PATH_HINT = 'BankAccount/SeeMore';
    const LOG_PREFIX = '[ZitounaNetworkMonitor]';
    let monitorSequence = 0;

    const isTargetUrl = (urlValue) => {
        try {
            const url = new URL(String(urlValue || ''), window.location.origin);
            return (
                url.origin === TARGET_ORIGIN &&
                url.pathname.includes(TARGET_PATH_HINT)
            );
        } catch (error) {
            return false;
        }
    };

    const extractBankAccountId = (urlValue) => {
        try {
            const url = new URL(String(urlValue || ''), window.location.origin);
            return url.searchParams.get('bankAccountId') || '';
        } catch (error) {
            return '';
        }
    };

    const extractCurrency = (urlValue) => {
        try {
            const url = new URL(String(urlValue || ''), window.location.origin);
            return url.searchParams.get('currency') || '';
        } catch (error) {
            return '';
        }
    };

    const safeParseJson = (text) => {
        try {
            return JSON.parse(String(text || ''));
        } catch (error) {
            return null;
        }
    };

    const emit = (payload) => {
        window.postMessage({
            source: SOURCE,
            type: EVENT_TYPE,
            payload
        }, '*');
    };

    const processResponse = (requestUrl, responseText, transport) => {
        if (!isTargetUrl(requestUrl)) {
            return;
        }

        const parsed = safeParseJson(responseText);
        if (!parsed || !Array.isArray(parsed.Transaction) || parsed.Transaction.length === 0) {
            return;
        }

        monitorSequence += 1;
        const bankAccountId = extractBankAccountId(requestUrl);
        const currency = extractCurrency(requestUrl);

        const payload = {
            monitorSeq: monitorSequence,
            transport,
            url: String(requestUrl),
            bankAccountId,
            currency,
            capturedAtMs: Date.now(),
            transactionCount: parsed.Transaction.length,
            transactions: parsed.Transaction
        };

        emit(payload);
        console.log(
            `${LOG_PREFIX} captured ${parsed.Transaction.length} transactions ` +
            `(seq=${monitorSequence}, transport=${transport}, account=${bankAccountId})`
        );
    };

    // --- Patch fetch ---
    if (typeof window.fetch === 'function') {
        const originalFetch = window.fetch;
        window.fetch = async function zitounaPatchedFetch(input, init) {
            const requestUrl = typeof input === 'string'
                ? input
                : (input && input.url) || '';
            const response = await originalFetch.apply(this, arguments);

            if (isTargetUrl(requestUrl)) {
                try {
                    const responseText = await response.clone().text();
                    processResponse(requestUrl, responseText, 'fetch');
                } catch (error) {
                    // Ignore response read errors.
                }
            }

            return response;
        };
    }

    // --- Patch XMLHttpRequest ---
    if (window.XMLHttpRequest && XMLHttpRequest.prototype) {
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function zitounaPatchedOpen(method, url) {
            this.__zitounaRequestMeta = {
                method: String(method || 'GET').toUpperCase(),
                url: String(url || '')
            };
            return originalOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function zitounaPatchedSend(body) {
            const meta = this.__zitounaRequestMeta || {};

            if (isTargetUrl(meta.url)) {
                this.addEventListener('loadend', function zitounaOnLoadEnd() {
                    try {
                        let responseText = '';
                        if (typeof this.responseText === 'string') {
                            responseText = this.responseText;
                        } else if (this.responseType === 'json' && this.response != null) {
                            responseText = JSON.stringify(this.response);
                        }
                        processResponse(meta.url, responseText, 'xhr');
                    } catch (error) {
                        // Ignore XHR response read errors.
                    }
                }, { once: true });
            }

            return originalSend.apply(this, arguments);
        };
    }

    window.__zitounaNetworkMonitorInstalled = true;
    console.log(`${LOG_PREFIX} installed`);
})();
