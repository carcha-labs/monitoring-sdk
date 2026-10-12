import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMonitor, type Monitor } from '../src/index';
import { MAX_ATTEMPTS, retryAfterMs } from '../src/transport';
import { accept, collectingLogger, type Ingest, type Reply, startIngest } from './helpers';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    vi.restoreAllMocks();

    while (cleanups.length > 0) {
        await cleanups.pop()?.();
    }
});

async function setup(reply: Reply = accept, options: Partial<Parameters<typeof createMonitor>[0]> = {}) {
    const ingest: Ingest = await startIngest(reply);
    const logger = collectingLogger();
    const monitor: Monitor = createMonitor({ token: 'tok', endpoint: ingest.url, logger, flushIntervalMs: 60_000, ...options });
    cleanups.push(async () => {
        await monitor.shutdown();
        await ingest.close();
    });

    return { ingest, monitor, logger };
}

const record = (monitor: Monitor, count: number) => {
    for (let index = 0; index < count; index++) {
        monitor.record({ method: 'GET', path: `/items/${index}`, status: 200, durationMs: 3, startedAt: new Date() });
    }
};

const advance = (ms: number) => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + ms);
};

describe('batching', () => {
    it('sends at most 100 events per request', async () => {
        const { ingest, monitor } = await setup();

        record(monitor, 250);
        await monitor.flush();

        expect(ingest.received.map((entry) => entry.events.length)).toEqual([100, 100, 50]);
        expect(monitor.stats()).toMatchObject({ queued: 0, sent: 250, dropped: 0 });
    });

    it('drops the oldest events when the queue is full', async () => {
        const { ingest, monitor, logger } = await setup(() => ({ status: 503 }), { maxQueueSize: 150 });

        record(monitor, 50);
        await monitor.flush();
        const firstIds = ingest.events().map((event) => event.event_id);
        record(monitor, 200);

        expect(monitor.stats()).toMatchObject({ queued: 150, dropped: 100 });
        expect(logger.messages.some((message) => message.includes('queue is full'))).toBe(true);

        vi.restoreAllMocks();
        advance(2_000);
        await monitor.flush();
        const retried = ingest.received[1]?.events.map((event) => event.event_id) ?? [];
        expect(retried.some((id) => firstIds.includes(id))).toBe(false);
    });
});

describe('server responses', () => {
    it('retries server errors with the same event ids', async () => {
        const { ingest, monitor } = await setup((received, index) => (index === 0 ? { status: 500 } : accept(received, index)));

        record(monitor, 3);
        await monitor.flush();
        expect(monitor.stats().queued).toBe(3);

        advance(1_000);
        await monitor.flush();

        const [first, second] = ingest.received;
        expect(second?.events.map((event) => event.event_id)).toEqual(first?.events.map((event) => event.event_id));
        expect(monitor.stats()).toMatchObject({ queued: 0, sent: 3 });
    });

    it('waits for Retry-After on 429 without counting it as a failed attempt', async () => {
        const { ingest, monitor, logger } = await setup((received, index) =>
            index === 0 ? { status: 429, headers: { 'retry-after': '30' }, body: { error: 'Monthly request limit exceeded' } } : accept(received, index),
        );

        record(monitor, 2);
        await monitor.flush();
        advance(29_000);
        await monitor.flush();
        expect(ingest.received).toHaveLength(1);

        vi.restoreAllMocks();
        advance(30_001);
        await monitor.flush();

        expect(ingest.received).toHaveLength(2);
        expect(monitor.stats()).toMatchObject({ sent: 2, dropped: 0 });
        expect(logger.messages[0]).toContain('sending resumes in 30 s');
    });

    it('stops for good when the token is rejected', async () => {
        const { ingest, monitor, logger } = await setup(() => ({ status: 401, body: { message: 'Invalid token' } }));

        record(monitor, 5);
        await monitor.flush();
        record(monitor, 5);
        await monitor.flush();

        expect(ingest.received).toHaveLength(1);
        expect(monitor.stats()).toMatchObject({ disabled: true, queued: 0, dropped: 5 });
        expect(logger.messages).toEqual(['the token was rejected (HTTP 401); monitoring is stopped until the process restarts']);
    });

    it('splits a batch the server finds too large', async () => {
        const { ingest, monitor } = await setup((received, index) => (received.events.length > 25 ? { status: 413 } : accept(received, index)));

        record(monitor, 100);
        await monitor.flush();

        expect(ingest.received.map((entry) => entry.events.length)).toEqual([100, 50, 25, 25, 50, 25, 25]);
        expect(monitor.stats()).toMatchObject({ sent: 100, queued: 0 });
    });

    it('counts events the server rejects and warns once', async () => {
        const { monitor, logger } = await setup((received) => ({
            status: 202,
            body: { accepted: received.events.length - 1, duplicates: 0, rejected: [{ index: 0, errors: { status: ['invalid'] } }] },
        }));

        record(monitor, 4);
        await monitor.flush();
        record(monitor, 4);
        await monitor.flush();

        expect(monitor.stats()).toMatchObject({ sent: 6, rejected: 2 });
        expect(logger.messages).toHaveLength(1);
    });

    it('drops events after the maximum number of failed attempts', async () => {
        const failing = vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED')));
        const logger = collectingLogger();
        const monitor = createMonitor({ token: 't', endpoint: 'http://127.0.0.1:9', logger, fetch: failing });
        cleanups.push(() => monitor.shutdown());

        record(monitor, 2);

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            await monitor.flush();
            vi.restoreAllMocks();
            advance(120_000 * (attempt + 1));
        }

        expect(failing).toHaveBeenCalledTimes(MAX_ATTEMPTS);
        expect(monitor.stats()).toMatchObject({ queued: 0, dropped: 2, sent: 0 });
        expect(logger.messages).toHaveLength(1);
        expect(logger.messages[0]).toContain('ECONNREFUSED');
    });
});

describe('retryAfterMs', () => {
    it('reads seconds and HTTP dates', () => {
        const now = Date.parse('2026-10-12T00:00:00Z');

        expect(retryAfterMs('120', now)).toBe(120_000);
        expect(retryAfterMs('Mon, 12 Oct 2026 00:01:00 GMT', now)).toBe(60_000);
        expect(retryAfterMs('soon', now)).toBeUndefined();
        expect(retryAfterMs(null, now)).toBeUndefined();
    });
});
