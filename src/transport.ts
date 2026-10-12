import type { Logger, MonitorStats, RequestEvent } from './types';

declare const __VERSION__: string;

export const MAX_ATTEMPTS = 5;
export const MAX_PAYLOAD_BYTES = 1_000_000;
const MAX_BACKOFF_MS = 60_000;

interface Item {
    event: RequestEvent;
    attempts: number;
}

type Outcome = { kind: 'done' } | { kind: 'retry'; delayMs: number; items: Item[] } | { kind: 'disable'; unsent: number };

export interface TransportOptions {
    url: string;
    token: string;
    batchSize: number;
    maxQueueSize: number;
    timeoutMs: number;
    flushIntervalMs: number;
    logger: Logger;
    fetch: typeof fetch;
}

export function retryAfterMs(header: string | null, now: number): number | undefined {
    if (header === null || header.trim() === '') {
        return undefined;
    }

    const seconds = Number(header);

    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
    }

    const date = Date.parse(header);

    return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export class Transport {
    private queue: Item[] = [];
    private draining: Promise<void> | null = null;
    private pausedUntil = 0;
    private consecutiveFailures = 0;
    private timer: ReturnType<typeof setInterval> | null = null;
    private warned = new Set<string>();
    private counters = { sent: 0, dropped: 0, rejected: 0 };
    private disabled = false;

    constructor(private readonly options: TransportOptions) {
        this.timer = setInterval(() => {
            void this.drain();
        }, options.flushIntervalMs);
        this.timer.unref();
    }

    enqueue(event: RequestEvent): void {
        if (this.disabled) {
            return;
        }

        this.push([{ event, attempts: 0 }], false);

        if (this.queue.length >= this.options.batchSize) {
            void this.drain();
        }
    }

    stats(): MonitorStats {
        return { queued: this.queue.length, ...this.counters, disabled: this.disabled };
    }

    async flush(): Promise<void> {
        await this.drain();
    }

    async shutdown(): Promise<void> {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }

        await this.drain();
    }

    drain(): Promise<void> {
        if (!this.draining) {
            this.draining = this.run().finally(() => {
                this.draining = null;
            });
        }

        return this.draining;
    }

    private async run(): Promise<void> {
        while (this.queue.length > 0 && !this.disabled && Date.now() >= this.pausedUntil) {
            const batch = this.queue.splice(0, this.options.batchSize);
            const outcome = await this.send(batch);

            if (outcome.kind === 'disable') {
                this.disabled = true;
                this.counters.dropped += this.queue.length + outcome.unsent;
                this.queue = [];

                return;
            }

            if (outcome.kind === 'retry') {
                this.push(outcome.items, true);
                this.pausedUntil = Date.now() + outcome.delayMs;

                return;
            }

            this.consecutiveFailures = 0;
        }
    }

    private countAttempt(batch: Item[]): Item[] {
        const kept: Item[] = [];

        for (const item of batch) {
            item.attempts += 1;

            if (item.attempts >= MAX_ATTEMPTS) {
                this.counters.dropped += 1;
            } else {
                kept.push(item);
            }
        }

        return kept;
    }

    private push(items: Item[], front: boolean): void {
        this.queue = front ? [...items, ...this.queue] : [...this.queue, ...items];
        const overflow = this.queue.length - this.options.maxQueueSize;

        if (overflow > 0) {
            this.queue.splice(0, overflow);
            this.counters.dropped += overflow;
            this.warnOnce('overflow', `queue is full (${this.options.maxQueueSize} events); the oldest events are dropped`);
        }
    }

    private backoff(): number {
        this.consecutiveFailures += 1;

        return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.consecutiveFailures - 1));
    }

    private async send(batch: Item[]): Promise<Outcome> {
        const body = JSON.stringify({ events: batch.map((item) => item.event) });

        if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES && batch.length > 1) {
            return this.sendHalves(batch);
        }

        let response: Response;

        try {
            response = await this.options.fetch(this.options.url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json',
                    'user-agent': `@carchalabs/monitoring/${__VERSION__}`,
                    'x-logbadger-token': this.options.token,
                },
                body,
                signal: AbortSignal.timeout(this.options.timeoutMs),
            });
        } catch (error) {
            this.warnOnce('network', `could not reach ${this.options.url}: ${error instanceof Error ? error.message : String(error)}`);

            return { kind: 'retry', delayMs: this.backoff(), items: this.countAttempt(batch) };
        }

        return this.handle(response, batch);
    }

    private async sendHalves(batch: Item[]): Promise<Outcome> {
        const middle = Math.ceil(batch.length / 2);
        const rest = batch.slice(middle);
        const first = await this.send(batch.slice(0, middle));

        if (first.kind === 'retry') {
            return { kind: 'retry', delayMs: first.delayMs, items: [...first.items, ...rest] };
        }

        if (first.kind === 'disable') {
            return { kind: 'disable', unsent: first.unsent + rest.length };
        }

        return this.send(rest);
    }

    private async handle(response: Response, batch: Item[]): Promise<Outcome> {
        const status = response.status;

        if (status === 201 || status === 202) {
            const result = (await response.json().catch(() => ({}))) as { accepted?: number; duplicates?: number; rejected?: unknown[] };
            const rejected = Array.isArray(result.rejected) ? result.rejected.length : 0;
            this.counters.sent += batch.length - rejected;
            this.counters.rejected += rejected;

            if (rejected > 0) {
                this.warnOnce('rejected', `the server rejected ${rejected} event(s): ${JSON.stringify(result.rejected?.[0])}`);
            }

            return { kind: 'done' };
        }

        if (status === 401 || status === 403) {
            this.warnOnce('auth', `the token was rejected (HTTP ${status}); monitoring is stopped until the process restarts`);

            return { kind: 'disable', unsent: batch.length };
        }

        if (status === 413 && batch.length > 1) {
            return this.sendHalves(batch);
        }

        if (status === 429) {
            const wait = retryAfterMs(response.headers.get('retry-after'), Date.now()) ?? this.backoff();
            this.warnOnce('limit', `the server asked to retry later (HTTP 429); sending resumes in ${Math.ceil(wait / 1000)} s`);

            return { kind: 'retry', delayMs: wait, items: batch };
        }

        if (status >= 500) {
            this.warnOnce('server', `the server answered HTTP ${status}; events are retried`);

            return { kind: 'retry', delayMs: this.backoff(), items: this.countAttempt(batch) };
        }

        this.counters.dropped += batch.length;
        this.warnOnce(`status-${status}`, `the server answered HTTP ${status}; ${batch.length} event(s) dropped`);

        return { kind: 'done' };
    }

    private warnOnce(key: string, message: string): void {
        if (!this.warned.has(key)) {
            this.warned.add(key);
            this.options.logger.warn(message);
        }
    }
}
