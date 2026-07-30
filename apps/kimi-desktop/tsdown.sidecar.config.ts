import { builtinModules } from 'node:module';
import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

function shouldAlwaysBundle(id: string): boolean {
  return !builtins.has(id) && !id.startsWith('node:') && id !== 'cpu-features';
}

export default defineConfig({
  entry: [resolve(import.meta.dirname, 'sidecar/main.ts')],
  format: ['cjs'],
  outDir: resolve(import.meta.dirname, 'sidecar/dist'),
  clean: true,
  dts: false,
  fixedExtension: true,
  hash: false,
  platform: 'node',
  target: 'node24',
  plugins: [rawTextPlugin()],
  define: {
    __KIMI_CODE_BUILT_IN_CATALOG__: 'undefined',
  },
  deps: {
    alwaysBundle: shouldAlwaysBundle,
    neverBundle: ['cpu-features'],
    onlyBundle: false,
  },
  outputOptions: {
    codeSplitting: false,
    entryFileNames: 'engine.cjs',
  },
  checks: {
    legacyCjs: false,
  },
});
