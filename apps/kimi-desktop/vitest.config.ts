// Sidecar unit/integration tests (vitest). The packages resolve through their
// own exports/imports maps to TypeScript source (the same layout tsx dev
// mode uses), so no aliases are needed here.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['sidecar/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
