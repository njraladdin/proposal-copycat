(function () {
    'use strict';

    const BRIDGE_SOURCE = 'proposal-copycat-nuxt-sandbox';
    const REQUEST_TYPE = 'parse-nuxt';
    const RESPONSE_TYPE = 'parse-nuxt-result';

    const isPrimitive = (value) => (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
    );

    const addUniqueScalarValue = (store, key, value) => {
        if (!key || value === undefined) {
            return;
        }

        let bucket = store.get(key);
        if (!bucket) {
            bucket = new Map();
            store.set(key, bucket);
        }

        const marker = `${typeof value}:${JSON.stringify(value)}`;
        bucket.set(marker, value);
    };

    const finalizeScalarStore = (store) => {
        const result = {};
        for (const [key, bucket] of store.entries()) {
            const values = Array.from(bucket.values());
            if (!values.length) continue;
            result[key] = values.length === 1 ? values[0] : values;
        }
        return result;
    };

    const extractNuxtExpression = (scriptText) => {
        const marker = 'window.__NUXT__=';
        const assignmentIndex = String(scriptText || '').indexOf(marker);
        if (assignmentIndex < 0) {
            return null;
        }

        const text = String(scriptText);
        const startIndex = assignmentIndex + marker.length;
        let quoteChar = '';
        let isEscaped = false;
        let roundDepth = 0;
        let squareDepth = 0;
        let curlyDepth = 0;

        for (let index = startIndex; index < text.length; index += 1) {
            const char = text[index];

            if (quoteChar) {
                if (isEscaped) {
                    isEscaped = false;
                } else if (char === '\\') {
                    isEscaped = true;
                } else if (char === quoteChar) {
                    quoteChar = '';
                }
                continue;
            }

            if (char === '"' || char === "'" || char === '`') {
                quoteChar = char;
                continue;
            }

            if (char === '(') roundDepth += 1;
            else if (char === ')') roundDepth = Math.max(0, roundDepth - 1);
            else if (char === '[') squareDepth += 1;
            else if (char === ']') squareDepth = Math.max(0, squareDepth - 1);
            else if (char === '{') curlyDepth += 1;
            else if (char === '}') curlyDepth = Math.max(0, curlyDepth - 1);

            if (
                char === ';' &&
                roundDepth === 0 &&
                squareDepth === 0 &&
                curlyDepth === 0
            ) {
                return text.slice(startIndex, index).trim();
            }
        }

        return text.slice(startIndex).trim().replace(/;+\s*$/, '');
    };

    const collectScalarFields = (rootValue) => {
        const fieldStore = new Map();
        const seen = new WeakSet();

        const walk = (value) => {
            if (!value || typeof value !== 'object') {
                return;
            }

            if (seen.has(value)) {
                return;
            }
            seen.add(value);

            if (Array.isArray(value)) {
                for (const item of value) {
                    if (item && typeof item === 'object') {
                        walk(item);
                    }
                }
                return;
            }

            for (const [key, node] of Object.entries(value)) {
                if (node === undefined) {
                    continue;
                }

                if (isPrimitive(node)) {
                    addUniqueScalarValue(fieldStore, key, node);
                    continue;
                }

                if (Array.isArray(node)) {
                    for (const arrayItem of node) {
                        if (isPrimitive(arrayItem)) {
                            addUniqueScalarValue(fieldStore, key, arrayItem);
                        } else if (arrayItem && typeof arrayItem === 'object') {
                            walk(arrayItem);
                        }
                    }
                    continue;
                }

                if (typeof node === 'object') {
                    walk(node);
                }
            }
        };

        walk(rootValue);
        return finalizeScalarStore(fieldStore);
    };

    const parseNuxtScript = (scriptText) => {
        const expression = extractNuxtExpression(scriptText);
        if (!expression) {
            throw new Error('Could not find a window.__NUXT__ assignment expression.');
        }

        const evaluateNuxtObject = new Function(
            `"use strict"; return (${expression});`
        );
        const nuxtValue = evaluateNuxtObject();

        return {
            fields: collectScalarFields(nuxtValue),
            rawParsedData: nuxtValue
        };
    };

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (!message || message.source !== BRIDGE_SOURCE || message.type !== REQUEST_TYPE) {
            return;
        }

        const response = {
            source: BRIDGE_SOURCE,
            type: RESPONSE_TYPE,
            requestId: message.requestId,
            ok: false
        };

        try {
            response.payload = parseNuxtScript(message.scriptText);
            response.ok = true;
        } catch (error) {
            response.error = error?.message || String(error);
        }

        if (event.source && typeof event.source.postMessage === 'function') {
            event.source.postMessage(response, event.origin || '*');
        }
    });
})();
