/**
 * Scenario: process-level telemetry crosses the TUI runtime boundary.
 * Responsibilities: legacy and Klient adapters preserve event properties,
 * context updates, and explicit context clearing. Each runtime facade is the
 * single stubbed boundary.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/runtime-telemetry-port.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { createKlientRuntimeTelemetryPort } from '#/tui/runtime/klient-runtime-telemetry-adapter';

describe('Klient runtime telemetry adapter', () => {
  it('forwards event properties when track records an event', () => {
    const track = vi.fn();
    const port = createKlientRuntimeTelemetryPort({
      telemetry: { track, setContext: vi.fn() },
    });

    port.track('theme_switch', {
      theme: 'light',
      elapsed_ms: 84,
      automatic: false,
      previous: null,
      detail: undefined,
    });

    expect(track).toHaveBeenCalledWith('theme_switch', {
      theme: 'light',
      elapsed_ms: 84,
      automatic: false,
      previous: null,
      detail: undefined,
    });
  });

  it('forwards context values when setContext updates telemetry', () => {
    const setContext = vi.fn();
    const port = createKlientRuntimeTelemetryPort({
      telemetry: { track: vi.fn(), setContext },
    });

    port.setContext({ sessionId: 'session-example', model: 'model-example' });

    expect(setContext).toHaveBeenCalledWith({
      sessionId: 'session-example',
      model: 'model-example',
    });
  });

  it('forwards null values when setContext clears telemetry', () => {
    const setContext = vi.fn();
    const port = createKlientRuntimeTelemetryPort({
      telemetry: { track: vi.fn(), setContext },
    });

    port.setContext({ sessionId: null, model: null });

    expect(setContext).toHaveBeenCalledWith({
      sessionId: null,
      model: null,
    });
  });
});
