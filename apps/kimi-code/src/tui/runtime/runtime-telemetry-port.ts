export type RuntimeTelemetryPrimitive =
  | string
  | number
  | boolean
  | null
  | undefined;

export type RuntimeTelemetryProperties = Readonly<
  Record<string, RuntimeTelemetryPrimitive>
>;

export interface RuntimeTelemetryContext {
  readonly sessionId?: string | null;
  readonly model?: string | null;
}

/** Process-level telemetry capabilities used by the interactive TUI. */
export interface RuntimeTelemetryPort {
  track(event: string, properties?: RuntimeTelemetryProperties): void;
  setContext(context: RuntimeTelemetryContext): void;
}
