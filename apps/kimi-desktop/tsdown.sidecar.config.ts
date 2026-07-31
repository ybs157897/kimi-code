import { builtinModules, createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

// jiti's default transform lazily requires `../dist/babel.cjs` relative to
// jiti's own file — inside the single-file SEA that path does not exist. The
// file is a self-contained webpack bundle (node builtins only), so it ships as
// its own chunk and is materialized at runtime like the extension host API.
// jiti is a dependency of agent-core-v2 (not of this package), so resolve it
// from agent-core-v2's location; its dist subpath is not covered by jiti's
// exports map, so resolve the package.json and join the path manually.
const jitiBabelPath = join(
  dirname(
    createRequire(resolve(import.meta.dirname, '../../packages/agent-core-v2/package.json')).resolve(
      'jiti/package.json',
    ),
  ),
  'dist',
  'babel.cjs',
);

function shouldAlwaysBundle(id: string): boolean {
  return !builtins.has(id) && !id.startsWith('node:') && id !== 'cpu-features';
}

export default defineConfig({
  entry: {
    engine: resolve(import.meta.dirname, 'sidecar/main.ts'),
    // The extension host API ships as its own chunk so the SEA can embed it as
    // an asset and materialize a REAL loadable file for jiti's alias at runtime
    // (a single-file SEA has no node_modules to resolve).
    'extension-host': resolve(
      import.meta.dirname,
      '../../packages/agent-core-v2/src/extension.ts',
    ),
    'jiti-babel': jitiBabelPath,
  },
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
    // Multiple entries → standalone CJS files (engine.cjs + extension-host.cjs
    // + jiti-babel.cjs); codeSplitting is left at the rolldown default
    // (multiple inputs forbid disabling it).
    entryFileNames: (info: { name?: string }) =>
      info.name === 'extension-host'
        ? 'extension-host.cjs'
        : info.name === 'jiti-babel'
          ? 'jiti-babel.cjs'
          : 'engine.cjs',
  },
  checks: {
    legacyCjs: false,
  },
});
