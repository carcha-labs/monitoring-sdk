import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { redactBody, redactHeaders } from './redact';
import { joinRoute, stripQuery } from './route';
import { Transport } from './transport';
import type { HttpMethod, Logger, MonitorOptions, MonitorStats, RecordInput, RequestEvent } from './types';

export type { HttpMethod, Logger, MonitorOptions, MonitorStats, RecordInput, RequestEvent } from './types';

export const DEFAULT_ENDPOINT = 'https://monitoring.carchalabs.com';

const methods = new Set<string>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export interface MonitoredRequest extends IncomingMessage {
    originalUrl?: string;
    baseUrl?: string;
    route?: { path?: unknown };
    ip?: string;
    body?: unknown;
}

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;

export interface Monitor {
    express: () => Middleware;
    record: (input: RecordInput) => void;
    flush: () => Promise<void>;
    shutdown: () => Promise<void>;
    stats: () => MonitorStats;
}

const silent: Logger = { warn: () => undefined };

const consoleLogger: Logger = {
    warn: (message) => {
        console.warn(`[@carchalabs/monitoring] ${message}`);
    },
};

const positive = (value: number | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), max) : fallback;

function resolveUrl(endpoint: string): string | undefined {
    try {
        const url = new URL('/api/v1/requests', endpoint);

        return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
    } catch {
        return undefined;
    }
}

function isIgnored(path: string, patterns: (string | RegExp)[]): boolean {
    return patterns.some((pattern) => (typeof pattern === 'string' ? pattern === path : pattern.test(path)));
}

function disabledMonitor(): Monitor {
    const stats: MonitorStats = { queued: 0, sent: 0, dropped: 0, rejected: 0, disabled: true };

    return {
        express: () => (_req, _res, next) => {
            next();
        },
        record: () => undefined,
        flush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
        stats: () => ({ ...stats }),
    };
}

export function toEvent(input: RecordInput, options: Pick<MonitorOptions, 'captureHeaders' | 'captureBodies'>): RequestEvent | undefined {
    const method = input.method.toUpperCase();

    if (!methods.has(method) || !Number.isInteger(input.status) || input.status < 100 || input.status > 599) {
        return undefined;
    }

    const event: RequestEvent = {
        event_id: randomUUID(),
        timestamp: input.startedAt.toISOString(),
        method: method as HttpMethod,
        path: (stripQuery(input.path) || '/').slice(0, 2048),
        status: input.status,
        response_time: Math.min(3_600_000, Math.max(0, Math.round(input.durationMs))),
    };

    if (input.route) {
        event.route = input.route.slice(0, 255);
    }

    const ip = input.ip?.trim();

    if (ip && isIP(ip) !== 0) {
        event.ip = ip;
    }

    if (input.userAgent) {
        event.user_agent = input.userAgent.slice(0, 512);
    }

    if (options.captureHeaders !== false) {
        event.request_headers = redactHeaders(input.requestHeaders);
        event.response_headers = redactHeaders(input.responseHeaders);
    }

    if (options.captureBodies === true) {
        const body = redactBody(input.requestBody);

        if (body) {
            event.request_body = body;
        }
    }

    return event;
}

function routeOf(req: MonitoredRequest): string | undefined {
    const path = req.route?.path;

    return typeof path === 'string' ? joinRoute(req.baseUrl ?? '', path) : undefined;
}

export function createMonitor(options: MonitorOptions): Monitor {
    const logger = options.logger === false ? silent : (options.logger ?? consoleLogger);
    const token = typeof options.token === 'string' ? options.token.trim() : '';

    if (token === '') {
        logger.warn('no token was given; requests are not monitored');

        return disabledMonitor();
    }

    const url = resolveUrl(options.endpoint ?? DEFAULT_ENDPOINT);
    const fetchImpl = options.fetch ?? globalThis.fetch;

    if (!url || typeof fetchImpl !== 'function') {
        logger.warn(url ? 'fetch is not available in this Node.js version; requests are not monitored' : `invalid endpoint: ${String(options.endpoint)}`);

        return disabledMonitor();
    }

    const transport = new Transport({
        url,
        token,
        batchSize: positive(options.batchSize, 100, 100),
        maxQueueSize: positive(options.maxQueueSize, 10_000),
        timeoutMs: positive(options.timeoutMs, 10_000),
        flushIntervalMs: positive(options.flushIntervalMs, 5_000),
        logger,
        fetch: fetchImpl,
    });
    const ignorePaths = options.ignorePaths ?? [];

    const record = (input: RecordInput): void => {
        try {
            const path = stripQuery(input.path);

            if (isIgnored(path, ignorePaths)) {
                return;
            }

            const event = toEvent(input, options);

            if (event) {
                transport.enqueue(event);
            }
        } catch (error) {
            logger.warn(`could not record a request: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const express = (): Middleware => (req, res, next) => {
        const startedAt = new Date();
        const start = process.hrtime.bigint();

        res.once('finish', () => {
            const request = req as MonitoredRequest;
            const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

            record({
                method: request.method ?? '',
                path: request.originalUrl ?? request.url ?? '/',
                route: routeOf(request),
                status: res.statusCode,
                durationMs,
                startedAt,
                ip: request.ip ?? request.socket.remoteAddress,
                userAgent: request.headers['user-agent'],
                requestHeaders: request.headers,
                responseHeaders: res.getHeaders(),
                requestBody: request.body,
            });
        });

        next();
    };

    return {
        express,
        record,
        flush: () => transport.flush(),
        shutdown: () => transport.shutdown(),
        stats: () => transport.stats(),
    };
}
