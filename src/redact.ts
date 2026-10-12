import type { JsonObject } from './types';

export const MASK = '[redacted]';
export const MAX_BODY_BYTES = 8192;

const sensitiveHeaders = new Set([
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'x-auth-token',
    'x-csrf-token',
    'x-xsrf-token',
    'x-logbadger-token',
]);

const sensitiveKey = /pass(word|wd)?|secret|token|api[-_]?key|authorization|cookie|card|cvv|cvc|iban|tckn|ssn/i;

const isPlainObject = (value: unknown): value is JsonObject =>
    typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

export function redactHeaders(headers: Record<string, unknown> | undefined): JsonObject | undefined {
    if (!headers) {
        return undefined;
    }

    const clean: JsonObject = {};

    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) {
            continue;
        }

        const key = name.toLowerCase();
        clean[key] = sensitiveHeaders.has(key) ? MASK : value;
    }

    return clean;
}

function maskValue(value: unknown, depth: number): unknown {
    if (depth > 20) {
        return MASK;
    }

    if (Array.isArray(value)) {
        return value.map((item) => maskValue(item, depth + 1));
    }

    if (isPlainObject(value)) {
        const masked: JsonObject = {};

        for (const [key, item] of Object.entries(value)) {
            masked[key] = sensitiveKey.test(key) ? MASK : maskValue(item, depth + 1);
        }

        return masked;
    }

    return value;
}

export function redactBody(body: unknown): JsonObject | undefined {
    if (!isPlainObject(body)) {
        return undefined;
    }

    const masked = maskValue(body, 0) as JsonObject;
    let size: number;

    try {
        size = Buffer.byteLength(JSON.stringify(masked));
    } catch {
        return { _unserializable: true };
    }

    return size > MAX_BODY_BYTES ? { _truncated: true, _limit_bytes: MAX_BODY_BYTES } : masked;
}
