/**
 * Scenario: process-level experimental feature flags cross the TUI runtime
 * boundary. Responsibilities: both adapters map neutral state, persist only
 * explicit changes, refresh after apply, copy referenced data, and preserve
 * boundary errors. The legacy harness and Klient facade are the only stubs.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/runtime-feature-flags-port.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { createKlientRuntimeFeatureFlagsPort } from '#/tui/runtime/klient-runtime-feature-flags-adapter';
import { createLegacyRuntimeFeatureFlagsPort } from '#/tui/runtime/legacy-runtime-feature-flags-adapter';

const RAW_FEATURE = {
  id: 'example-feature',
  title: 'Example feature',
  description: 'Exercises the feature flag adapter.',
  surface: 'both' as const,
  env: 'KIMI_CODE_EXPERIMENTAL_EXAMPLE_FEATURE',
  defaultEnabled: false,
  enabled: true,
  source: 'config' as const,
  configValue: true,
};

const FEATURE = {
  id: 'example-feature',
  title: 'Example feature',
  description: 'Exercises the feature flag adapter.',
  surface: 'both',
  env: 'KIMI_CODE_EXPERIMENTAL_EXAMPLE_FEATURE',
  defaultEnabled: false,
  enabled: true,
  source: 'config',
  configValue: true,
};

describe('legacy runtime feature flags adapter', () => {
  it('maps and copies feature state when list reads the harness snapshot', async () => {
    const rawFeature = { ...RAW_FEATURE };
    const port = createLegacyRuntimeFeatureFlagsPort(
      legacyHarness({
        getExperimentalFeatures: vi.fn(async () => [rawFeature]),
      }),
    );

    const features = await port.list();

    expect(features).toEqual([FEATURE]);
    expect(features[0]).not.toBe(rawFeature);
  });

  it('copies explicit changes into the legacy experimental config patch', async () => {
    const setConfig = vi.fn(
      async (_input: {
        readonly experimental: Readonly<Record<string, boolean>>;
      }): Promise<void> => undefined,
    );
    const port = createLegacyRuntimeFeatureFlagsPort(
      legacyHarness({ setConfig }),
    );
    const changes = { 'example-feature': true };

    await port.apply(changes);

    expect(setConfig).toHaveBeenCalledExactlyOnceWith({
      experimental: { 'example-feature': true },
    });
    expect(setConfig.mock.calls[0]?.[0].experimental).not.toBe(changes);
  });

  it('returns the refreshed harness snapshot after apply succeeds', async () => {
    let persisted = false;
    const getExperimentalFeatures = vi.fn(async () => [
      {
        ...RAW_FEATURE,
        enabled: !persisted,
        configValue: !persisted,
      },
    ]);
    const port = createLegacyRuntimeFeatureFlagsPort(
      legacyHarness({
        getExperimentalFeatures,
        setConfig: vi.fn(async () => {
          persisted = true;
        }),
      }),
    );

    const features = await port.apply({ 'example-feature': false });

    expect(getExperimentalFeatures).toHaveBeenCalledOnce();
    expect(features).toEqual([
      { ...FEATURE, enabled: false, configValue: false },
    ]);
  });

  it('passes through a harness list failure', async () => {
    const failure = new Error('legacy feature list failed');
    const port = createLegacyRuntimeFeatureFlagsPort(
      legacyHarness({
        getExperimentalFeatures: vi.fn(async () => {
          throw failure;
        }),
      }),
    );

    await expect(port.list()).rejects.toBe(failure);
  });

  it('passes through a harness apply failure without refreshing', async () => {
    const failure = new Error('legacy feature apply failed');
    const getExperimentalFeatures = vi.fn(async () => []);
    const port = createLegacyRuntimeFeatureFlagsPort(
      legacyHarness({
        getExperimentalFeatures,
        setConfig: vi.fn(async () => {
          throw failure;
        }),
      }),
    );

    await expect(port.apply({ 'example-feature': true })).rejects.toBe(failure);
    expect(getExperimentalFeatures).not.toHaveBeenCalled();
  });
});

describe('Klient runtime feature flags adapter', () => {
  it('maps and copies feature state when list reads the Klient snapshot', async () => {
    const rawFeature = { ...RAW_FEATURE };
    const port = createKlientRuntimeFeatureFlagsPort(
      klientFacade({
        list: vi.fn(async () => [rawFeature]),
      }),
    );

    const features = await port.list();

    expect(features).toEqual([FEATURE]);
    expect(features[0]).not.toBe(rawFeature);
  });

  it('copies explicit changes into the persistent experimental config domain', async () => {
    const set = vi.fn(
      async (_input: {
        domain: string;
        patch: unknown;
        target?: 'user' | 'memory';
      }): Promise<void> => undefined,
    );
    const port = createKlientRuntimeFeatureFlagsPort(klientFacade({ set }));
    const changes = { 'example-feature': true };

    await port.apply(changes);

    expect(set).toHaveBeenCalledExactlyOnceWith({
      domain: 'experimental',
      patch: { 'example-feature': true },
      target: 'user',
    });
    expect(set.mock.calls[0]?.[0].patch).not.toBe(changes);
  });

  it('returns the refreshed Klient snapshot after apply succeeds', async () => {
    let persisted = false;
    const list = vi.fn(async () => [
      {
        ...RAW_FEATURE,
        enabled: !persisted,
        configValue: !persisted,
      },
    ]);
    const port = createKlientRuntimeFeatureFlagsPort(
      klientFacade({
        list,
        set: vi.fn(async () => {
          persisted = true;
        }),
      }),
    );

    const features = await port.apply({ 'example-feature': false });

    expect(list).toHaveBeenCalledOnce();
    expect(features).toEqual([
      { ...FEATURE, enabled: false, configValue: false },
    ]);
  });

  it('passes through a Klient list failure', async () => {
    const failure = new Error('Klient feature list failed');
    const port = createKlientRuntimeFeatureFlagsPort(
      klientFacade({
        list: vi.fn(async () => {
          throw failure;
        }),
      }),
    );

    await expect(port.list()).rejects.toBe(failure);
  });

  it('passes through a Klient apply failure without refreshing', async () => {
    const failure = new Error('Klient feature apply failed');
    const list = vi.fn(async () => []);
    const port = createKlientRuntimeFeatureFlagsPort(
      klientFacade({
        list,
        set: vi.fn(async () => {
          throw failure;
        }),
      }),
    );

    await expect(port.apply({ 'example-feature': true })).rejects.toBe(failure);
    expect(list).not.toHaveBeenCalled();
  });
});

interface LegacyHarnessOverrides {
  readonly getExperimentalFeatures?: () => Promise<
    readonly (typeof RAW_FEATURE)[]
  >;
  readonly setConfig?: (input: {
    readonly experimental: Readonly<Record<string, boolean>>;
  }) => Promise<unknown>;
}

function legacyHarness(overrides: LegacyHarnessOverrides = {}) {
  return {
    getExperimentalFeatures:
      overrides.getExperimentalFeatures ?? vi.fn(async () => []),
    setConfig: overrides.setConfig ?? vi.fn(async () => undefined),
  };
}

interface KlientFacadeOverrides {
  readonly list?: () => Promise<readonly (typeof RAW_FEATURE)[]>;
  readonly set?: (input: {
    domain: string;
    patch: unknown;
    target?: 'user' | 'memory';
  }) => Promise<void>;
}

function klientFacade(overrides: KlientFacadeOverrides = {}) {
  return {
    global: {
      flags: {
        list: overrides.list ?? vi.fn(async () => []),
      },
      config: {
        set: overrides.set ?? vi.fn(async () => undefined),
      },
    },
  };
}
