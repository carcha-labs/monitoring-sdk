import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RequestEvent } from '../src/types';

export interface Received {
    headers: IncomingHttpHeaders;
    events: RequestEvent[];
}

export type Reply = (received: Received, index: number) => { status: number; headers?: Record<string, string>; body?: unknown };

export interface Ingest {
    url: string;
    received: Received[];
    events: () => RequestEvent[];
    close: () => Promise<void>;
}

export const accept: Reply = (received) => ({ status: 202, body: { accepted: received.events.length, duplicates: 0, rejected: [] } });

export async function startIngest(reply: Reply = accept): Promise<Ingest> {
    const received: Received[] = [];
    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { events: RequestEvent[] };
            const entry = { headers: req.headers, events: parsed.events };
            received.push(entry);
            const answer = reply(entry, received.length - 1);
            res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
            res.end(JSON.stringify(answer.body ?? {}));
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}`,
        received,
        events: () => received.flatMap((entry) => entry.events),
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => {
                    resolve();
                });
            }),
    };
}

export async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => {
                    resolve();
                });
            }),
    };
}

export function collectingLogger(): { warn: (message: string) => void; messages: string[] } {
    const messages: string[] = [];

    return { messages, warn: (message) => messages.push(message) };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
