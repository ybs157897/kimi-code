import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import { createKlientRuntimeAuthPort } from './klient-runtime-auth-adapter';
import { createKlientRuntimeEnvironmentPort } from './klient-runtime-environment-adapter';
import { createKlientRuntimeFeatureFlagsPort } from './klient-runtime-feature-flags-adapter';
import { createKlientRuntimeModelConfigPort } from './klient-runtime-model-config-adapter';
import { createKlientRuntimeModelCatalogPort } from './klient-runtime-model-catalog-adapter';
import { createKlientRuntimeProviderRefreshPort } from './klient-runtime-provider-refresh-adapter';
import { createKlientRuntimeSessionExportPort } from './klient-runtime-session-export-adapter';
import { createKlientRuntimeTelemetryPort } from './klient-runtime-telemetry-adapter';
import { createKlientSessionControlPort } from './klient-session-control-adapter';
import type { RuntimeAuthPort } from './runtime-auth-port';
import type { RuntimeEnvironmentPort } from './runtime-environment-port';
import type { RuntimeFeatureFlagsPort } from './runtime-feature-flags-port';
import type { RuntimeModelCatalogPort } from './runtime-model-catalog-port';
import type { RuntimeModelConfigPort } from './runtime-model-config-port';
import type { RuntimeProviderRefreshPort } from './runtime-provider-refresh-port';
import type { RuntimeSessionExportPort } from './runtime-session-export-port';
import type { RuntimeTelemetryPort } from './runtime-telemetry-port';
import type { SessionControlPort } from './session-control-port';
import { createKlientTUISessionRuntime, type TUISessionRuntime } from './tui-session-runtime';

/** Process-level composition boundary consumed by the interactive TUI. */
export interface TUIRuntime {
  readonly auth: RuntimeAuthPort;
  readonly environment: RuntimeEnvironmentPort;
  readonly featureFlags: RuntimeFeatureFlagsPort;
  readonly models: RuntimeModelCatalogPort;
  readonly modelConfig: RuntimeModelConfigPort;
  readonly providerRefresh: RuntimeProviderRefreshPort;
  readonly sessionExport: RuntimeSessionExportPort;
  readonly telemetry: RuntimeTelemetryPort;
  readonly sessionControl: SessionControlPort;
  bindSession(sessionId: string, agentId?: string): TUISessionRuntime;
}

/** Compose the v2 runtime behind the same runtime-neutral TUI boundary. */
export async function createKlientTUIRuntime(
  runtime: KimiV2Runtime,
): Promise<TUIRuntime> {
  const [environment, models] = await Promise.all([
    createKlientRuntimeEnvironmentPort(runtime),
    Promise.resolve(createKlientRuntimeModelCatalogPort(runtime)),
  ]);

  return {
    auth: createKlientRuntimeAuthPort(runtime),
    environment,
    featureFlags: createKlientRuntimeFeatureFlagsPort(runtime),
    models,
    modelConfig: createKlientRuntimeModelConfigPort(runtime),
    providerRefresh: createKlientRuntimeProviderRefreshPort(runtime),
    sessionExport: createKlientRuntimeSessionExportPort(runtime),
    telemetry: createKlientRuntimeTelemetryPort(runtime),
    sessionControl: createKlientSessionControlPort(runtime),
    bindSession: (sessionId, agentId) =>
      createKlientTUISessionRuntime(runtime, sessionId, agentId),
  };
}
