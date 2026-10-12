# @carchalabs/monitoring

Express middleware for [Carcha Labs Monitoring](https://monitoring.carchalabs.com). It sends one record per HTTP request (method, path, route, status, response time) so the dashboard can chart traffic, error rate and p50/p95/p99 latency per route.

No runtime dependencies. Node.js 22 or later.

## Install

```sh
npm install @carchalabs/monitoring
```

## Use

Create an application and an ingest token in the dashboard, then:

```js
import express from 'express';
import { createMonitor } from '@carchalabs/monitoring';

const monitor = createMonitor({ token: process.env.CARCHALABS_MONITORING_TOKEN });

const app = express();
app.use(express.json());
app.use(monitor.express());

app.get('/orders/:id', (req, res) => res.json({ id: req.params.id }));

const server = app.listen(3000);

process.on('SIGTERM', async () => {
    server.close();
    await monitor.shutdown();
});
```

CommonJS works the same way: `const { createMonitor } = require('@carchalabs/monitoring');`.

Register the middleware before your routes. The route is taken from Express (`/orders/:id`), so `/orders/1` and `/orders/2` are one endpoint. Requests that match no route are sent without a route, and the server groups numeric and ID segments as `{id}`.

## What is sent

| Field | Source |
| --- | --- |
| `method`, `path`, `status` | the request and response; the query string is removed |
| `route` | `req.baseUrl` + `req.route.path`; numeric and ID segments of the mount path become `{id}` |
| `response_time` | milliseconds from the middleware until the response is finished |
| `ip` | `req.ip` (follows Express `trust proxy`) |
| `user_agent` | the `User-Agent` header |
| `request_headers`, `response_headers` | all headers, with `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, CSRF and token headers replaced by `[redacted]` before they leave your server; turn off with `captureHeaders: false` |
| `request_body` | only with `captureBodies: true` and a parsed JSON object body; keys that look like passwords, tokens, secrets, card numbers, IBAN or national ID numbers are replaced by `[redacted]`; bodies over 8 KB are replaced by a truncation marker |

Response bodies are never sent. A request whose client disconnects before the response is finished is not recorded. The server applies the application's own privacy settings (body storage, IP truncation) on top of this.

## Options

| Option | Default | |
| --- | --- | --- |
| `token` | required | ingest token; without it the middleware does nothing and logs one warning |
| `endpoint` | `https://monitoring.carchalabs.com` | |
| `flushIntervalMs` | `5000` | how often queued records are sent |
| `batchSize` | `100` | records per request, at most 100 |
| `maxQueueSize` | `10000` | when the queue is full the oldest records are dropped |
| `timeoutMs` | `10000` | per request to the endpoint |
| `captureHeaders` | `true` | |
| `captureBodies` | `false` | |
| `ignorePaths` | `[]` | exact paths or regular expressions, e.g. `['/health', /^\/internal\//]` |
| `logger` | `console.warn` | an object with `warn(message)`, or `false` for no output |

## Delivery

- A record is queued after the response has finished and sent in batches in the background; the middleware never waits for the network.
- Every record has an `event_id`; a retried batch is not counted twice.
- Network errors and HTTP 5xx: retried with backoff from 1 s to 60 s, at most 5 attempts per record.
- HTTP 429 (monthly limit): sending pauses for the time in `Retry-After`.
- HTTP 401 or 403 (wrong or revoked token): sending stops until the process restarts.
- Records still queued when the process exits are lost unless you call `await monitor.shutdown()`.
- The package never exits your process and installs no global error handlers.

`monitor.stats()` returns `{ queued, sent, dropped, rejected, disabled }`.

## Other frameworks

Call `monitor.record()` yourself:

```js
monitor.record({ method: 'GET', path: '/orders/1', route: '/orders/:id', status: 200, durationMs: 12.4, startedAt: new Date() });
```

## Migrating from logbadger-monitor

`logbadger-monitor` sent data to an endpoint that no longer exists. Replace it:

```diff
- import { LogbadgerMonitor } from 'logbadger-monitor';
- LogbadgerMonitor(app, ['/orders', '/users']);
+ import { createMonitor } from '@carchalabs/monitoring';
+ app.use(createMonitor({ token: process.env.CARCHALABS_MONITORING_TOKEN }).express());
```

Every route is monitored; exclude paths with `ignorePaths`. `setRouteConfig` is replaced by `captureBodies` (off by default) and the built-in masking. System metrics (CPU, memory) are no longer collected.
