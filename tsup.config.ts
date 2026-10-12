import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    target: 'node22',
    platform: 'node',
    dts: true,
    clean: true,
    sourcemap: false,
    define: { __VERSION__: JSON.stringify(version) },
});
