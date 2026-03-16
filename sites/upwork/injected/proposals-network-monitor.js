(() => {
    if (window.__proposalCopycatNetworkMonitorInstalled) {
        return;
    }

    const SOURCE = 'proposal-copycat-network-monitor';
    const EVENT_TYPE = 'graphql-response';
    const TARGET_ALIAS = 'gql-query-proposalsbytype';
    const TARGET_ORIGIN = 'https://www.upwork.com';
    const GRAPHQL_PATH_HINTS = ['/api/graphql/'];
    const VERBOSE_MONITOR_LOGS = false;
    const REQUEST_OPERATION_HINTS = [
        'gql-query-proposalsbytype',
        'proposalsbytype'
    ];
    const RESPONSE_OPERATION_HINTS = [
        '/nx/proposals/',
        '"proposalsbytype"',
        '"proposalurl"',
        '"proposalciphertext"'
    ];
    const LOG_PREFIX = '[ProposalCopycatMonitor]';
    const monitorStats = {
        totalGraphqlEndpointResponses: 0,
        matchedTargetResponses: 0,
        droppedNoHintResponses: 0
    };
    let monitorSequence = 0;

    const normalizeUrl = (value) => {
        try {
            return new URL(String(value || ''), window.location.origin).href;
        } catch (error) {
            return '';
        }
    };

    const getUrlMeta = (value) => {
        const normalizedUrl = normalizeUrl(value);
        if (!normalizedUrl) {
            return {
                normalizedUrl: '',
                parsedUrl: null
            };
        }

        try {
            return {
                normalizedUrl,
                parsedUrl: new URL(normalizedUrl)
            };
        } catch (error) {
            return {
                normalizedUrl,
                parsedUrl: null
            };
        }
    };

    const isGraphqlEndpoint = (parsedUrl) => {
        if (!parsedUrl || parsedUrl.origin !== TARGET_ORIGIN) {
            return false;
        }
        const pathname = parsedUrl.pathname || '';
        return GRAPHQL_PATH_HINTS.some((hint) => pathname.includes(hint));
    };

    const normalizeBodyText = (body) => {
        if (body === undefined || body === null) {
            return '';
        }

        if (typeof body === 'string') {
            return body;
        }

        if (body instanceof URLSearchParams) {
            return body.toString();
        }

        if (typeof FormData !== 'undefined' && body instanceof FormData) {
            const parts = [];
            for (const [key, value] of body.entries()) {
                if (typeof value === 'string') {
                    parts.push(`${key}=${value}`);
                }
            }
            return parts.join('&');
        }

        if (typeof body === 'object') {
            if (body instanceof ArrayBuffer) {
                try {
                    return new TextDecoder('utf-8').decode(new Uint8Array(body));
                } catch (error) {
                    return '';
                }
            }

            if (ArrayBuffer.isView(body)) {
                try {
                    return new TextDecoder('utf-8').decode(
                        new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
                    );
                } catch (error) {
                    return '';
                }
            }

            try {
                return JSON.stringify(body);
            } catch (error) {
                return '';
            }
        }

        return '';
    };

    const decodeBodyForMatching = (bodyText) => {
        const raw = String(bodyText || '').trim();
        if (!raw) {
            return '';
        }

        const normalized = raw.replace(/\+/g, ' ');
        try {
            return decodeURIComponent(normalized);
        } catch (error) {
            return raw;
        }
    };

    const includesAnyHint = (text, hints) => {
        const haystack = String(text || '').toLowerCase();
        if (!haystack) {
            return false;
        }
        for (const hint of hints) {
            if (haystack.includes(hint)) {
                return true;
            }
        }
        return false;
    };

    const detectMatchReason = ({ parsedUrl, requestBodyText, responseText }) => {
        if (!isGraphqlEndpoint(parsedUrl)) {
            return '';
        }

        const aliasFromUrl = String(parsedUrl.searchParams.get('alias') || '');
        if (aliasFromUrl === TARGET_ALIAS) {
            return 'url-alias';
        }

        const requestBodyRaw = String(requestBodyText || '');
        const requestBodyDecoded = decodeBodyForMatching(requestBodyRaw);
        if (
            includesAnyHint(requestBodyRaw, REQUEST_OPERATION_HINTS) ||
            includesAnyHint(requestBodyDecoded, REQUEST_OPERATION_HINTS)
        ) {
            return 'request-body';
        }

        if (includesAnyHint(responseText, RESPONSE_OPERATION_HINTS)) {
            return 'response-body';
        }

        return '';
    };

    const emit = (payload) => {
        window.postMessage({
            source: SOURCE,
            type: EVENT_TYPE,
            payload
        }, '*');
    };

    const shortPathFromUrl = (url) => {
        try {
            return new URL(String(url || ''), window.location.origin).pathname || '';
        } catch (error) {
            return '';
        }
    };

    const logMonitorEvent = (payload) => {
        if (!VERBOSE_MONITOR_LOGS && payload?.isTargetOperation !== true) {
            return;
        }
        const seq = Number(payload?.monitorSeq) || 0;
        const shouldLog = VERBOSE_MONITOR_LOGS ? (seq <= 8 || seq % 20 === 0) : true;
        if (!shouldLog) {
            return;
        }

        // eslint-disable-next-line no-console
        console.log(
            `${LOG_PREFIX} event#${seq} transport=${payload?.transport || 'unknown'} ` +
            `path=${payload?.path || '?'} status=${payload?.status ?? '?'} ` +
            `len=${payload?.responseTextLength ?? 0} target=${payload?.isTargetOperation ? 'yes' : 'no'} ` +
            `match=${payload?.matchReason || 'none'} ` +
            `req="${String(payload?.requestBodySnippet || '').replace(/\s+/g, ' ').slice(0, 90)}" ` +
            `res="${String(payload?.responsePreview || '').replace(/\s+/g, ' ').slice(0, 90)}" ` +
            `totals=` +
            `${monitorStats.totalGraphqlEndpointResponses}/${monitorStats.matchedTargetResponses}/${monitorStats.droppedNoHintResponses}`
        );
    };

    const readFetchRequestBody = async (input, init) => {
        if (init && init.body !== undefined && init.body !== null) {
            return normalizeBodyText(init.body);
        }

        if (typeof Request !== 'undefined' && input instanceof Request) {
            try {
                return await input.clone().text();
            } catch (error) {
                return '';
            }
        }

        return '';
    };

    const readFetchResponseText = async (response) => {
        if (!response) {
            return '';
        }

        try {
            const rawText = await response.clone().text();
            if (rawText && rawText.length > 2) {
                return rawText;
            }
        } catch (error) {
            // Ignore and continue with JSON fallback.
        }

        try {
            const asJson = await response.clone().json();
            return JSON.stringify(asJson);
        } catch (error) {
            return '';
        }
    };

    const readXhrResponseText = (xhr) => {
        if (!xhr) {
            return '';
        }

        try {
            if (typeof xhr.responseText === 'string' && xhr.responseText.length > 0) {
                return xhr.responseText;
            }
        } catch (error) {
            // responseText is not readable for this responseType.
        }

        try {
            if (xhr.responseType === 'json' && xhr.response !== undefined && xhr.response !== null) {
                return JSON.stringify(xhr.response);
            }
        } catch (error) {
            // Ignore JSON stringify issues.
        }

        try {
            if (xhr.response instanceof ArrayBuffer) {
                return new TextDecoder('utf-8').decode(new Uint8Array(xhr.response));
            }
            if (ArrayBuffer.isView(xhr.response)) {
                return new TextDecoder('utf-8').decode(
                    new Uint8Array(xhr.response.buffer, xhr.response.byteOffset, xhr.response.byteLength)
                );
            }
        } catch (error) {
            // Ignore decode failures.
        }

        return '';
    };

    if (typeof window.fetch === 'function') {
        const originalFetch = window.fetch;
        window.fetch = async function proposalCopycatPatchedFetch(input, init) {
            const requestUrl = typeof input === 'string'
                ? input
                : (input && input.url) || '';
            const requestMethod = (init && init.method) || (input && input.method) || 'GET';
            const requestBodyText = await readFetchRequestBody(input, init);
            const requestStartedAtMs = Date.now();
            const response = await originalFetch.apply(this, arguments);

            const { normalizedUrl, parsedUrl } = getUrlMeta(requestUrl);
            if (!isGraphqlEndpoint(parsedUrl)) {
                return response;
            }

            const responseText = await readFetchResponseText(response);

            const matchReason = detectMatchReason({
                parsedUrl,
                requestBodyText,
                responseText
            });

            const isTargetOperation = !!matchReason;
            monitorStats.totalGraphqlEndpointResponses += 1;
            if (isTargetOperation) {
                monitorStats.matchedTargetResponses += 1;
            } else {
                monitorStats.droppedNoHintResponses += 1;
            }
            monitorSequence += 1;

            const payload = {
                isGraphqlEndpoint: true,
                isTargetOperation,
                matchReason: matchReason || '',
                dropReason: matchReason ? '' : 'no-operation-hint',
                monitorSeq: monitorSequence,
                transport: 'fetch',
                path: shortPathFromUrl(normalizedUrl || requestUrl),
                url: normalizedUrl || requestUrl,
                method: String(requestMethod || 'GET').toUpperCase(),
                status: response.status,
                ok: response.ok,
                requestStartedAtMs: Number(requestStartedAtMs) || Date.now(),
                capturedAtMs: Date.now(),
                responseTextLength: responseText.length,
                requestBodySnippet: String(requestBodyText || '').slice(0, 500),
                responsePreview: String(responseText || '').slice(0, 200),
                responseText
            };
            emit(payload);
            logMonitorEvent(payload);

            return response;
        };
    }

    if (window.XMLHttpRequest && XMLHttpRequest.prototype) {
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function proposalCopycatPatchedOpen(method, url) {
            this.__proposalCopycatRequestMeta = {
                method: String(method || 'GET').toUpperCase(),
                url: normalizeUrl(url)
            };
            return originalOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function proposalCopycatPatchedSend(body) {
            const meta = this.__proposalCopycatRequestMeta || {};
            const requestStartedAtMs = Date.now();
            const requestBodyText = normalizeBodyText(body);
            const { parsedUrl } = getUrlMeta(meta.url);
            if (!isGraphqlEndpoint(parsedUrl)) {
                return originalSend.apply(this, arguments);
            }

            this.addEventListener('loadend', function proposalCopycatOnLoadEnd() {
                try {
                    const responseText = readXhrResponseText(this);
                    const matchReason = detectMatchReason({
                        parsedUrl,
                        requestBodyText,
                        responseText
                    });
                    const isTargetOperation = !!matchReason;
                    monitorStats.totalGraphqlEndpointResponses += 1;
                    if (isTargetOperation) {
                        monitorStats.matchedTargetResponses += 1;
                    } else {
                        monitorStats.droppedNoHintResponses += 1;
                    }
                    monitorSequence += 1;

                    const payload = {
                        isGraphqlEndpoint: true,
                        isTargetOperation,
                        matchReason: matchReason || '',
                        dropReason: matchReason ? '' : 'no-operation-hint',
                        monitorSeq: monitorSequence,
                        transport: 'xhr',
                        path: shortPathFromUrl(meta.url),
                        url: meta.url,
                        method: meta.method || 'GET',
                        status: this.status,
                        ok: this.status >= 200 && this.status < 300,
                        requestStartedAtMs,
                        capturedAtMs: Date.now(),
                        responseTextLength: responseText.length,
                        requestBodySnippet: String(requestBodyText || '').slice(0, 500),
                        responsePreview: String(responseText || '').slice(0, 200),
                        responseText
                    };
                    emit(payload);
                    logMonitorEvent(payload);
                } catch (error) {
                    // Ignore XHR response read errors.
                }
            }, { once: true });

            return originalSend.apply(this, arguments);
        };
    }

    window.__proposalCopycatNetworkMonitorInstalled = true;
    // eslint-disable-next-line no-console
    console.log(`${LOG_PREFIX} installed`);
})();
