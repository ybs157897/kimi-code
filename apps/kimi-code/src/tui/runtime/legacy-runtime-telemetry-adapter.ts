import type {
  RuntimeTelemetryContext,
  RuntimeTelemetryPort,
  RuntimeTelemetryProperties,
} from './runtime-telemetry-port';

interface LegacyRuntimeTelemetry {
  track(event: string, properties?: RuntimeTelemetryProperties): void;
  setTelemetryContext(context: RuntimeTelemetryContext): void;
}

/** Bridge the current SDK harness telemetry into the process-level TUI port. */
export function createLegacyRuntimeTelemetryPort(
  harness: LegacyRuntimeTelemetry,
): RuntimeTelemetryPort {
  return {
    track: (event, properties) => {
      harness.track(event, properties);
    },
    setContext: (context) => {
      harness.setTelemetryContext(context);
    },
  };
}
