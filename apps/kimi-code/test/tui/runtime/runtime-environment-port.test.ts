/**
 * Scenario: process-level environment capabilities cross the TUI runtime
 * boundary. Responsibilities: the adapter exposes the resolved home,
 * experimental features, warning strings, and runtime shutdown.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/runtime-environment-port.test.ts
 */

import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';
import { describe, expect, it, vi } from 'vitest';

import { createKlientRuntimeEnvironmentPort } from '#/tui/runtime/klient-runtime-environment-adapter';
import type { RuntimeExperimentalFeatureState } from '#/tui/runtime/runtime-environment-port';

const FEATURE = {
  id: 'example-feature',
  title: 'Example feature',
  description: 'Exercises the runtime adapter',
  surface: 'tui' as const,
  env: 'KIMI_CODE_EXPERIMENTAL_EXAMPLE_FEATURE',
  defaultEnabled: false,
  enabled: true,
  source: 'env' as const,
} satisfies RuntimeExperimentalFeatureState;

describe('Klient runtime environment adapter', () => {
  it('resolves the runtime home before exposing the port', async () => {
    const runtime = klientRuntime();

    const port = await createKlientRuntimeEnvironmentPort(runtime);

    expect(port.homeDir).toBe('/tmp/kimi-v2-home');
  });

  it('returns the Klient experimental-feature snapshot', async () => {
    const runtime = klientRuntime({
      listFeatures: vi.fn(async () => [FEATURE]),
    });
    const port = await createKlientRuntimeEnvironmentPort(runtime);

    await expect(port.getExperimentalFeatures()).resolves.toEqual([FEATURE]);
  });

  it('returns only warning messages from Klient config diagnostics', async () => {
    const runtime = klientRuntime({
      diagnostics: vi.fn(async () => [
        {
          domain: 'example',
          severity: 'warning' as const,
          message: 'Invalid example setting',
        },
        {
          domain: 'example',
          severity: 'error' as const,
          message: 'Broken example setting',
        },
      ]),
    });
    const port = await createKlientRuntimeEnvironmentPort(runtime);

    await expect(port.getConfigDiagnostics()).resolves.toEqual([
      'Invalid example setting',
    ]);
  });

  it('closes the owning v2 runtime', async () => {
    const close = vi.fn(async () => undefined);
    const runtime = klientRuntime({ close });
    const port = await createKlientRuntimeEnvironmentPort(runtime);

    await port.close();

    expect(close).toHaveBeenCalledOnce();
  });
});

function klientRuntime(
  overrides: Partial<{
    env: () => Promise<{ readonly homeDir: string }>;
    listFeatures: () => Promise<readonly (typeof FEATURE)[]>;
    diagnostics: () => Promise<
      readonly {
        readonly domain?: string;
        readonly severity: 'warning' | 'error';
        readonly message: string;
      }[]
    >;
    close: () => Promise<void>;
  }> = {},
): KimiV2Runtime {
  return {
    klient: {
      global: {
        env:
          overrides.env ??
          vi.fn(async () => ({
            homeDir: '/tmp/kimi-v2-home',
          })),
        flags: {
          list: overrides.listFeatures ?? vi.fn(async () => []),
        },
        config: {
          diagnostics: overrides.diagnostics ?? vi.fn(async () => []),
        },
      },
    },
    close: overrides.close ?? vi.fn(async () => undefined),
  } as unknown as KimiV2Runtime;
}
