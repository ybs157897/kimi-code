/**
 * Scenario: process-level authentication crosses the TUI runtime boundary.
 * Responsibilities: both adapters normalize status and copy managed usage;
 * the Klient adapter also owns device-code projection, polling, cancellation,
 * and terminal errors. Each runtime auth facade is the single stubbed boundary.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/runtime-auth-port.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKlientRuntimeAuthPort } from '#/tui/runtime/klient-runtime-auth-adapter';

const PENDING_FLOW = {
  flow_id: 'flow-example',
  provider: 'example-provider',
  status: 'pending' as const,
  verification_uri: 'https://example.test/device',
  verification_uri_complete: 'https://example.test/device?code=ABCD-EFGH',
  user_code: 'ABCD-EFGH',
  expires_in: 600,
  interval: 3,
  expires_at: '2026-07-27T12:10:00.000Z',
};

function managedUsageResult() {
  return {
    kind: 'ok' as const,
    summary: {
      label: 'Monthly',
      used: 20,
      limit: 100,
      resetHint: 'resets next month',
    },
    limits: [
      {
        label: 'Five hour',
        used: 8,
        limit: 50,
        resetHint: 'resets in 2h',
      },
    ],
    extraUsage: {
      balanceCents: 1500,
      totalCents: 5000,
      monthlyChargeLimitEnabled: true,
      monthlyChargeLimitCents: 3000,
      monthlyUsedCents: 700,
      currency: 'USD',
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Klient runtime auth adapter (flow orchestration)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('returns the Klient provider status through the neutral contract', async () => {
    const status = vi.fn(async () => ({
      loggedIn: true,
      provider: 'example-provider',
    }));
    const { port } = klientRig({ status });

    await expect(port.status('example-provider')).resolves.toEqual({
      loggedIn: true,
      provider: 'example-provider',
    });
    expect(status).toHaveBeenCalledWith('example-provider');
  });

  it('returns isolated neutral managed usage when Klient supplies account data', async () => {
    const source = managedUsageResult();
    const getManagedUsage = vi.fn(async () => source);
    const { port } = klientRig({ getManagedUsage });

    const result = await port.getManagedUsage('example-provider');

    expect(result).toEqual({
      kind: 'ok',
      summary: {
        label: 'Monthly',
        used: 20,
        limit: 100,
        resetHint: 'resets next month',
      },
      limits: [
        {
          label: 'Five hour',
          used: 8,
          limit: 50,
          resetHint: 'resets in 2h',
        },
      ],
      extraUsage: {
        balanceCents: 1500,
        totalCents: 5000,
        monthlyChargeLimitEnabled: true,
        monthlyChargeLimitCents: 3000,
        monthlyUsedCents: 700,
        currency: 'USD',
      },
    });
    expect(getManagedUsage).toHaveBeenCalledWith('example-provider');
    if (result.kind !== 'ok') throw new Error('expected managed usage');
    expect(result.summary).not.toBe(source.summary);
    expect(result.limits).not.toBe(source.limits);
    expect(result.limits[0]).not.toBe(source.limits[0]);
    expect(result.extraUsage).not.toBe(source.extraUsage);
  });

  it('copies managed usage errors returned by Klient', async () => {
    const getManagedUsage = vi.fn(async () => ({
      kind: 'error' as const,
      message: 'Managed usage unavailable.',
      status: 429,
    }));
    const { port } = klientRig({ getManagedUsage });

    await expect(
      port.getManagedUsage('example-provider'),
    ).resolves.toEqual({
      kind: 'error',
      message: 'Managed usage unavailable.',
      status: 429,
    });
  });

  it('resolves login immediately when Klient already authenticated the provider', async () => {
    const startLogin = vi.fn(async () => ({
      flow_id: 'flow-example',
      provider: 'example-provider',
      status: 'authenticated' as const,
    }));
    const flow = vi.fn();
    const onDeviceCode = vi.fn();
    const { port } = klientRig({ startLogin, flow });

    await expect(
      port.login('example-provider', { onDeviceCode }),
    ).resolves.toBeUndefined();

    expect(startLogin).toHaveBeenCalledWith('example-provider');
    expect(flow).not.toHaveBeenCalled();
    expect(onDeviceCode).not.toHaveBeenCalled();
  });

  it('emits neutral device-code details when Klient starts a pending flow', async () => {
    const onDeviceCode = vi.fn();
    const { port } = klientRig({
      flow: vi.fn(async () => flowSnapshot('authenticated')),
    });

    const login = port.login('example-provider', { onDeviceCode });
    await flushPromises();

    expect(onDeviceCode).toHaveBeenCalledWith({
      verificationUri: 'https://example.test/device',
      verificationUriComplete:
        'https://example.test/device?code=ABCD-EFGH',
      userCode: 'ABCD-EFGH',
      expiresIn: 600,
      interval: 3,
    });

    await vi.advanceTimersByTimeAsync(3_000);
    await login;
  });

  it('resolves login when polling reaches authenticated after the advertised interval', async () => {
    const flow = vi.fn(async () => flowSnapshot('authenticated'));
    const { port } = klientRig({ flow });

    const login = port.login('example-provider');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(flow).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    await expect(login).resolves.toBeUndefined();
    expect(flow).toHaveBeenCalledWith('example-provider');
  });

  it('cancels the Klient flow when the login signal aborts', async () => {
    const controller = new AbortController();
    const cancelLogin = vi.fn(async () => ({
      cancelled: true,
      status: 'cancelled' as const,
    }));
    const flow = vi.fn();
    const { port } = klientRig({ cancelLogin, flow });

    const login = port.login('example-provider', {
      signal: controller.signal,
    });
    const rejection = expect(login).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Authentication login was aborted.',
    });
    await flushPromises();
    controller.abort();

    await rejection;
    expect(cancelLogin).toHaveBeenCalledWith('example-provider');
    expect(flow).not.toHaveBeenCalled();
  });

  it.each(['denied', 'expired', 'cancelled'] as const)(
    'rejects login with a clear error when the Klient flow becomes %s',
    async (status) => {
      const { port } = klientRig({
        flow: vi.fn(async () => flowSnapshot(status)),
      });

      const login = port.login('example-provider');
      const rejection = expect(login).rejects.toThrow(
        `Authentication login for provider "example-provider" was ${status}.`,
      );
      await flushPromises();
      await vi.advanceTimersByTimeAsync(3_000);

      await rejection;
    },
  );

  it('surfaces the provider error when the Klient flow supplies error_message', async () => {
    const { port } = klientRig({
      flow: vi.fn(async () =>
        flowSnapshot('denied', 'The example provider rejected this request.'),
      ),
    });

    const login = port.login('example-provider');
    const rejection = expect(login).rejects.toThrow(
      'Authentication login failed for provider "example-provider": The example provider rejected this request.',
    );
    await flushPromises();
    await vi.advanceTimersByTimeAsync(3_000);

    await rejection;
  });

  it('forwards the provider when logout clears Klient authentication', async () => {
    const logout = vi.fn(async () => ({
      logged_out: true as const,
      provider: 'example-provider',
    }));
    const { port } = klientRig({ logout });

    await expect(port.logout('example-provider')).resolves.toBeUndefined();

    expect(logout).toHaveBeenCalledWith('example-provider');
  });

  it('forwards the model when Klient checks authentication readiness', async () => {
    const ensureReady = vi.fn(async () => undefined);
    const { port } = klientRig({ ensureReady });

    await port.ensureReady('example-model');

    expect(ensureReady).toHaveBeenCalledWith('example-model');
  });
});

function klientRig(
  overrides: Partial<{
    status: (provider?: string) => Promise<unknown>;
    ensureReady: (model?: string) => Promise<void>;
    startLogin: (provider?: string) => Promise<unknown>;
    flow: (provider?: string) => Promise<unknown>;
    cancelLogin: (provider?: string) => Promise<unknown>;
    logout: (provider?: string) => Promise<unknown>;
    getManagedUsage: (provider?: string) => Promise<unknown>;
  }> = {},
) {
  const auth = {
    status:
      overrides.status ??
      vi.fn(async () => ({
        loggedIn: false,
        provider: 'example-provider',
      })),
    ensureReady: overrides.ensureReady ?? vi.fn(async () => undefined),
    startLogin:
      overrides.startLogin ?? vi.fn(async () => ({ ...PENDING_FLOW })),
    flow:
      overrides.flow ??
      vi.fn(async () => flowSnapshot('authenticated')),
    cancelLogin:
      overrides.cancelLogin ??
      vi.fn(async () => ({
        cancelled: true,
        status: 'cancelled' as const,
      })),
    logout:
      overrides.logout ??
      vi.fn(async () => ({
        logged_out: true as const,
        provider: 'example-provider',
      })),
    getManagedUsage:
      overrides.getManagedUsage ??
      vi.fn(async () => ({
        kind: 'error' as const,
        message: 'Managed usage unavailable.',
      })),
  };
  const port = createKlientRuntimeAuthPort({
    global: { auth },
  } as unknown as Parameters<typeof createKlientRuntimeAuthPort>[0]);
  return { auth, port };
}

function flowSnapshot(
  status: 'pending' | 'authenticated' | 'denied' | 'expired' | 'cancelled',
  error_message?: string,
) {
  return {
    ...PENDING_FLOW,
    status,
    resolved_at:
      status === 'pending' ? undefined : '2026-07-27T12:01:00.000Z',
    error_message,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
