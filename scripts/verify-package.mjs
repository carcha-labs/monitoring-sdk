import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const fail = (message) => {
    console.warn(`FAIL ${message}`);
    process.exit(1);
};

const [packed] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', tmpdir()], root));
const files = packed.files.map((file) => file.path).sort();
const expected = ['LICENSE', 'README.md', 'dist/index.cjs', 'dist/index.d.cts', 'dist/index.d.ts', 'dist/index.js', 'package.json'];

if (JSON.stringify(files) !== JSON.stringify(expected)) {
    fail(`tarball contents ${JSON.stringify(files)}`);
}

const work = mkdtempSync(join(tmpdir(), 'cm-verify-'));
const tarball = join(tmpdir(), packed.filename);

try {
    writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'consumer', private: true }));
    run('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund', tarball, 'typescript@5.9', '@types/node@22'], work);

    const ingest = `
import { createServer } from 'node:http';
export function ingest() {
    const received = [];
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            received.push({ token: req.headers['x-logbadger-token'], events: JSON.parse(body).events });
            res.writeHead(202, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ accepted: 1, duplicates: 0, rejected: [] }));
        });
    });
    return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, received, url: 'http://127.0.0.1:' + server.address().port })));
}`;
    writeFileSync(join(work, 'ingest.mjs'), ingest);

    const scenario = (load) => `
${load}
const { ingest } = await import('./ingest.mjs');
const target = await ingest();
const monitor = createMonitor({ token: 'tok', endpoint: target.url, logger: false });
monitor.record({ method: 'get', path: '/a/1?x=1', route: '/a/:id', status: 200, durationMs: 4.6, startedAt: new Date() });
await monitor.shutdown();
target.server.close();
const event = target.received[0]?.events[0];
if (target.received[0]?.token !== 'tok' || event?.path !== '/a/1' || event?.method !== 'GET' || event?.response_time !== 5) {
    console.warn(JSON.stringify(target.received));
    process.exit(1);
}
console.log('ok');
`;

    writeFileSync(join(work, 'esm.mjs'), scenario("import { createMonitor } from '@carchalabs/monitoring';"));
    writeFileSync(join(work, 'cjs.cjs'), `(async () => {${scenario("const { createMonitor } = require('@carchalabs/monitoring');")}})();`);

    for (const file of ['esm.mjs', 'cjs.cjs']) {
        if (run('node', [file], work).trim() !== 'ok') {
            fail(file);
        }
    }

    writeFileSync(
        join(work, 'exits.mjs'),
        "import { createMonitor } from '@carchalabs/monitoring';\nconst m = createMonitor({ token: 't', endpoint: 'http://127.0.0.1:9', logger: false });\nm.record({ method: 'GET', path: '/', status: 200, durationMs: 1, startedAt: new Date() });\n",
    );
    const started = Date.now();
    const exited = spawnSync('node', ['exits.mjs'], { cwd: work, timeout: 5000 });

    if (exited.status !== 0 || Date.now() - started > 3000) {
        fail('a monitor with queued records keeps the process alive');
    }

    writeFileSync(join(work, 'noexit.cjs'), "require('@carchalabs/monitoring').createMonitor({ token: undefined, logger: false });\nprocess.stdout.write('alive');\n");

    if (run('node', ['noexit.cjs'], work) !== 'alive') {
        fail('loading without a token must not exit the process');
    }

    const types = "import { createMonitor, type MonitorOptions, type Middleware } from '@carchalabs/monitoring';\nconst options: MonitorOptions = { token: 'x', captureBodies: true };\nconst handler: Middleware = createMonitor(options).express();\nvoid handler;\n";
    writeFileSync(join(work, 'consumer.mts'), types);
    writeFileSync(join(work, 'consumer.cts'), types);
    run('npx', ['tsc', '--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--types', 'node', 'consumer.mts', 'consumer.cts'], work);

    const manifest = JSON.parse(readFileSync(join(work, 'node_modules/@carchalabs/monitoring/package.json'), 'utf8'));

    if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
        fail('the package must have no runtime dependencies');
    }

    console.log(`verified ${packed.filename} (${packed.size} bytes packed, ${packed.unpackedSize} unpacked)`);
} finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(tarball, { force: true });
}
