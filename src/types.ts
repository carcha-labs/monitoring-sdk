export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type JsonObject = Record<string, unknown>;

export interface RequestEvent {
    event_id: string;
    timestamp: string;
    method: HttpMethod;
    path: string;
    route?: string;
    status: number;
    response_time: number;
    ip?: string;
    user_agent?: string;
    request_headers?: JsonObject;
    response_headers?: JsonObject;
    request_body?: JsonObject;
}

export interface Logger {
    warn: (message: string) => void;
}

export interface MonitorOptions {
    token: string | undefined;
    endpoint?: string;
    flushIntervalMs?: number;
    batchSize?: number;
    maxQueueSize?: number;
    timeoutMs?: number;
    captureHeaders?: boolean;
    captureBodies?: boolean;
    ignorePaths?: (string | RegExp)[];
    logger?: Logger | false;
    fetch?: typeof fetch;
}

export interface MonitorStats {
    queued: number;
    sent: number;
    dropped: number;
    rejected: number;
    disabled: boolean;
}

export interface RecordInput {
    method: string;
    path: string;
    route?: string;
    status: number;
    durationMs: number;
    startedAt: Date;
    ip?: string;
    userAgent?: string;
    requestHeaders?: Record<string, unknown>;
    responseHeaders?: Record<string, unknown>;
    requestBody?: unknown;
}
