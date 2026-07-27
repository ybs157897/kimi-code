import type {
  RuntimeTelemetryContext,
  RuntimeTelemetryPort,
  RuntimeTelemetryProperties,
} from './runtime-telemetry-port';

interface KlientRuntimeTelemetry {
  readonly telemetry: {
    track(event: string, properties?: RuntimeTelemetryProperties): void;
    setContext(context: RuntimeTelemetryContext): void;
  };
}

/** Bridge the v2 runtime telemetry into the process-level TUI port. */
export function createKlientRuntimeTelemetryPort(
  runtime: KlientRuntimeTelemetry,
): RuntimeTelemetryPort {
  return {
    track: (event, properties) => {
      runtime.telemetry.track(event, properties);
    },
    setContext: (context) => {
      runtime.telemetry.setContext(context);
    },
  };
}
