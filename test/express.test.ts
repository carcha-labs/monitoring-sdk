import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createMonitor, type Monitor } from '../src/index';
import { collectingLogger, type Ingest, listen, sleep, startIngest } from './helpers';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    while (cleanups.length > 0) {
        await cleanups.pop()?.();
    }
});

async function setup(options: Partial<Parameters<typeof createMonitor>[0]> = {}): Promise<{ ingest: Ingest; monitor: Monitor; app: express.Express; call: (path: string, init?: RequestInit) => Promise<Response> }> {
    const ingest = await startIngest();
    const monitor = createMonitor({ token: 'tok_test', endpoint: ingest.url, logger: false, ...options });
    const app = express();
    app.use(express.json());
    app.use(monitor.express());
    cleanups.push(() => ingest.close());

    let server: { url: string; close: () => Promise<void> } | undefined;

    const call = async (path: string, init?: RequestInit) => {
        if (!server) {
            server = await listen(app);
            const started = server;
            cleanups.push(() => started.close());
        }

        const response = await fetch(`${server.url}${path}`, init);
        await response.arrayBuffer();
        await sleep(20);

        return response;
    };

    return { ingest, monitor, app, call };
}

describe('express middleware', () => {
    it('sends the route template, path without query, status and an integer duration', async () => {
        const { ingest, monitor, app, call } = await setup();
        app.get('/users/:id', (_req, res) => {
            res.json({ ok: true });
        });

        await call('/users/42?expand=orders');
        await monitor.flush();

        expect(ingest.received).toHaveLength(1);
        expect(ingest.received[0]?.headers['x-logbadger-token']).toBe('tok_test');
        expect(ingest.received[0]?.headers['user-agent']).toMatch(/^@carchalabs\/monitoring\/\d+\.\d+\.\d+$/);
        const event = ingest.events()[0];
        expect(event).toMatchObject({ method: 'GET', path: '/users/42', route: '/users/:id', status: 200 });
        expect(event?.event_id).toMatch(/^[0-9a-f-]{36}$/);
        expect(Number.isInteger(event?.response_time)).toBe(true);
        expect(new Date(event?.timestamp ?? '').toISOString()).toBe(event?.timestamp);
    });

    it('joins mounted routers and replaces IDs in the mount path', async () => {
        const { ingest, monitor, app, call } = await setup();
        const orders = express.Router();
        orders.get('/orders/:orderId', (_req, res) => {
            res.status(201).end();
        });
        const members = express.Router({ mergeParams: true });
        members.get('/members', (_req, res) => {
            res.end();
        });
        app.use('/api/v1', orders);
        app.use('/teams/:teamId', members);

        await call('/api/v1/orders/9');
        await call('/teams/77/members');
        await monitor.flush();

        expect(ingest.events().map((event) => event.route)).toEqual(['/api/v1/orders/:orderId', '/teams/{id}/members']);
    });

    it('leaves the route empty for unmatched paths so the server groups them', async () => {
        const { ingest, monitor, call } = await setup();

        await call('/missing/123');
        await monitor.flush();

        const event = ingest.events()[0];
        expect(event?.status).toBe(404);
        expect(event?.route).toBeUndefined();
        expect(event?.path).toBe('/missing/123');
    });

    it('masks sensitive headers and does not send bodies by default', async () => {
        const { ingest, monitor, app, call } = await setup();
        app.post('/login', (_req, res) => {
            res.setHeader('set-cookie', 'sid=secret');
            res.json({ ok: true });
        });

        await call('/login', {
            method: 'POST',
            headers: { authorization: 'Bearer abc', cookie: 'a=b', 'x-request-id': 'r1', 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'a@b.c', password: 'hunter2' }),
        });
        await monitor.flush();

        const event = ingest.events()[0];
        expect(event?.request_headers).toMatchObject({ authorization: '[redacted]', cookie: '[redacted]', 'x-request-id': 'r1' });
        expect(event?.response_headers).toMatchObject({ 'set-cookie': '[redacted]' });
        expect(event?.request_body).toBeUndefined();
    });

    it('sends masked bodies only when captureBodies is on', async () => {
        const { ingest, monitor, app, call } = await setup({ captureBodies: true });
        app.post('/pay', (_req, res) => {
            res.end();
        });
        app.post('/upload', (_req, res) => {
            res.end();
        });

        await call('/pay', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ amount: 5, card: { number: '4111' }, nested: { apiKey: 'k', items: [{ token: 't', sku: 'x' }] } }),
        });
        await call('/upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(9000) }) });
        await monitor.flush();

        const [pay, upload] = ingest.events();
        expect(pay?.request_body).toEqual({ amount: 5, card: '[redacted]', nested: { apiKey: '[redacted]', items: [{ token: '[redacted]', sku: 'x' }] } });
        expect(upload?.request_body).toEqual({ _truncated: true, _limit_bytes: 8192 });
    });

    it('skips ignored paths and unsupported methods', async () => {
        const { ingest, monitor, app, call } = await setup({ ignorePaths: ['/health', /^\/internal\//] });
        app.all('/{*any}', (_req, res) => {
            res.end();
        });

        await call('/health');
        await call('/internal/metrics');
        await call('/kept');
        await monitor.flush();

        monitor.record({ method: 'PROPFIND', path: '/dav', status: 207, durationMs: 1, startedAt: new Date() });
        monitor.record({ method: 'GET', path: '/bad-status', status: 42, durationMs: 1, startedAt: new Date() });
        monitor.record({ method: 'GET', path: '/bad-ip', status: 200, durationMs: 1, startedAt: new Date(), ip: 'not-an-ip' });
        await monitor.flush();

        expect(ingest.events().map((event) => event.path)).toEqual(['/kept', '/bad-ip']);
        expect(ingest.events()[1]?.ip).toBeUndefined();
    });

    it('records nothing when the client disconnects before the response finishes', async () => {
        const { ingest, monitor, app } = await setup();
        app.get('/slow', (_req, res) => {
            setTimeout(() => {
                if (!res.destroyed) {
                    res.end();
                }
            }, 300);
        });
        const server = await listen(app);
        cleanups.push(() => server.close());

        await fetch(`${server.url}/slow`, { signal: AbortSignal.timeout(50) }).catch(() => undefined);
        await sleep(400);
        await monitor.flush();

        expect(ingest.events()).toHaveLength(0);
    });
});

describe('without a token', () => {
    it('warns once, keeps the app working and never exits the process', async () => {
        const logger = collectingLogger();
        const monitor = createMonitor({ token: undefined, logger });
        const app = express();
        app.use(monitor.express());
        app.get('/', (_req, res) => {
            res.send('ok');
        });
        const server = await listen(app);
        cleanups.push(() => server.close());

        const response = await fetch(`${server.url}/`);

        expect(await response.text()).toBe('ok');
        expect(logger.messages).toEqual(['no token was given; requests are not monitored']);
        expect(monitor.stats().disabled).toBe(true);
    });

    it('disables itself for an invalid endpoint instead of throwing', () => {
        const logger = collectingLogger();
        const monitor = createMonitor({ token: 't', endpoint: 'not a url', logger });

        expect(monitor.stats().disabled).toBe(true);
        expect(logger.messages[0]).toContain('invalid endpoint');
    });
});
