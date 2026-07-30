/**
 * SDK-local telemetry helpers — `withTelemetryContext` and `noopTelemetryClient`.
 *
 * These were originally re-exported from `@moonshot-ai/agent-core`.  They are
 * thin wrappers that the harness and SDK client use to instrument calls without
 * depending on the legacy package.
 */

export interface TelemetryClient {
  track(event: string, properties?: Record<string, string | number | boolean | null | undefined>): void;
  setContext?(patch: Record<string, string | number | boolean | null | undefined>): void;
  withContext?(patch: TelemetryContextPatch): TelemetryClient;
  flush?(): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface TelemetryContextPatch {
  readonly sessionId?: string | null;
  readonly [key: string]: string | number | boolean | null | undefined;
}

export type TelemetryProperties = Record<string, string | number | boolean | null | undefined>;

/** No-op client used when telemetry is disabled. */
export const noopTelemetryClient: TelemetryClient = {
  track(): void {},
};

export function createNoopTelemetryClient(): TelemetryClient {
  return { track(): void {} };
}

/**
 * Create a scoped telemetry wrapper that merges `patch` into every track call's
 * properties, matching the legacy `withTelemetryContext` semantics.
 */
export function withTelemetryContext(
  client: TelemetryClient,
  patch: TelemetryContextPatch,
): TelemetryClient {
  if (client.withContext !== undefined) {
    return client.withContext(patch);
  }
  return {
    ...client,
    track(event: string, properties?: Record<string, string | number | boolean | null | undefined>): void {
      client.track(event, { ...patch, ...properties });
    },
  };
}
