import type {
  AgentSideConnection,
  ClientCapabilities,
} from '@agentclientprotocol/sdk';
import { LocalKaos, type Kaos } from '@moonshot-ai/kaos';
import {
  log,
  type KimiConfig,
  type KimiHarness,
  type ModelAlias,
  type ProviderConfig,
} from '@moonshot-ai/kimi-code-sdk';

import { AcpKaos } from './kaos-acp';
import { listModelsFromHarness } from './model-catalog';
import type {
  AcpCreateSessionParams,
  AcpHost,
  AcpListSessionsParams,
  AcpResumeSessionParams,
  AcpSessionHost,
} from './types';

/**
 * Compatibility boundary for callers that still pass the public root SDK
 * harness. The ACP protocol server itself only consumes {@link AcpHost}.
 */
export class LegacyAcpHost implements AcpHost {
  private connection: AgentSideConnection | undefined;
  private clientCapabilities: ClientCapabilities | undefined;
  private innerKaos: Kaos | undefined;

  constructor(private readonly harness: KimiHarness) {}

  get imageLimits() {
    return this.harness.imageLimits;
  }

  bindConnection(connection: AgentSideConnection): void {
    this.connection = connection;
  }

  setClientCapabilities(capabilities: ClientCapabilities | undefined): void {
    this.clientCapabilities = capabilities;
  }

  async checkAuthenticated(): Promise<boolean> {
    const status = await this.harness.auth.status();
    if (status.providers.some((entry) => entry.hasToken)) return true;
    return this.hasUsableConfiguredDefaultModel();
  }

  async createSession(params: AcpCreateSessionParams): Promise<AcpSessionHost> {
    const kaos = await this.maybeBuildAcpKaos(params.sessionId);
    const persistenceKaos = kaos === undefined ? undefined : await this.ensureInnerKaos();
    const input: Parameters<KimiHarness['createSession']>[0] & {
      readonly mcpServers?: AcpCreateSessionParams['mcpServers'];
    } = {
      id: params.sessionId,
      workDir: params.workDir ?? process.cwd(),
      additionalDirs: params.additionalDirs,
      kaos,
      persistenceKaos,
      mcpServers: params.mcpServers,
      sessionStartedProperties: { mode: params.mode ?? 'new' },
    };
    return this.harness.createSession(input);
  }

  async resumeSession(params: AcpResumeSessionParams): Promise<AcpSessionHost> {
    const kaos = await this.maybeBuildAcpKaos(params.sessionId);
    const persistenceKaos = kaos === undefined ? undefined : await this.ensureInnerKaos();
    const input: Parameters<KimiHarness['resumeSession']>[0] & {
      readonly mcpServers?: AcpResumeSessionParams['mcpServers'];
    } = {
      id: params.sessionId,
      additionalDirs: params.additionalDirs,
      kaos,
      persistenceKaos,
      mcpServers: params.mcpServers,
      sessionStartedProperties: { mode: params.mode ?? 'resume' },
    };
    return this.harness.resumeSession(input);
  }

  async listSessions(params: AcpListSessionsParams = {}) {
    const summaries = await this.harness.listSessions({
      workDir: params.workDir,
      sessionId: params.sessionId,
    });
    return summaries.map((summary) => ({
      id: summary.id,
      workDir: summary.workDir,
      title:
        typeof summary.title === 'string' && summary.title.length > 0
          ? summary.title
          : null,
      updatedAt: toIsoDate(summary.updatedAt),
    }));
  }

  listAvailableModels() {
    return listModelsFromHarness(this.harness);
  }

  async getDefaultModelId(): Promise<string | undefined> {
    try {
      return (await this.harness.getConfig()).defaultModel;
    } catch {
      return undefined;
    }
  }

  async getDefaultThinkingEffort(): Promise<string | undefined> {
    try {
      const thinking = (await this.harness.getConfig()).thinking;
      if (thinking?.enabled === false) return 'off';
      if (typeof thinking?.effort === 'string' && thinking.effort.length > 0) {
        return thinking.effort;
      }
      return thinking?.enabled === true ? 'on' : 'off';
    } catch {
      return undefined;
    }
  }

  track(event: string, properties?: Record<string, unknown>): void {
    this.harness.track(
      event,
      properties as Parameters<KimiHarness['track']>[1],
    );
  }

  close(): Promise<void> {
    return this.harness.close();
  }

  private async maybeBuildAcpKaos(sessionId: string): Promise<AcpKaos | undefined> {
    const fs = this.clientCapabilities?.fs;
    if ((!fs?.readTextFile && !fs?.writeTextFile) || this.connection === undefined) {
      return undefined;
    }
    return new AcpKaos(this.connection, sessionId, await this.ensureInnerKaos());
  }

  private async ensureInnerKaos(): Promise<Kaos> {
    return (this.innerKaos ??= await LocalKaos.create());
  }

  private async hasUsableConfiguredDefaultModel(): Promise<boolean> {
    let config: KimiConfig;
    try {
      config = await this.harness.getConfig();
    } catch (error) {
      log.warn('acp: harness.getConfig threw during auth gate; requiring terminal auth', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    if (config.defaultModel === undefined) return false;
    const alias = config.models?.[config.defaultModel];
    if (alias === undefined) return false;
    const provider = providerForAlias(config, alias);
    return provider !== undefined && providerHasNonOAuthCredentials(provider);
  }
}

function providerForAlias(config: KimiConfig, alias: ModelAlias): ProviderConfig | undefined {
  const providerName = alias.provider ?? config['defaultProvider'];
  return providerName === undefined ? undefined : config.providers?.[providerName];
}

function providerHasNonOAuthCredentials(provider: ProviderConfig): boolean {
  if (provider.oauth !== undefined) return false;
  switch (provider.type) {
    case 'anthropic':
      return hasProviderValue(provider, 'ANTHROPIC_API_KEY');
    case 'openai':
    case 'openai_responses':
      return hasProviderValue(provider, 'OPENAI_API_KEY');
    case 'kimi':
      return hasProviderValue(provider, 'KIMI_API_KEY');
    case 'google-genai':
      return hasProviderValue(provider, 'GOOGLE_API_KEY');
    case 'vertexai':
      return (
        hasProviderValue(provider, 'VERTEXAI_API_KEY') ||
        hasEnvValue(provider, 'GOOGLE_API_KEY') ||
        (hasEnvValue(provider, 'GOOGLE_CLOUD_PROJECT') &&
          (hasEnvValue(provider, 'GOOGLE_CLOUD_LOCATION') ||
            vertexAILocationFromBaseUrl(provider.baseUrl) !== undefined))
      );
    default:
      return false;
  }
}

function hasProviderValue(provider: ProviderConfig, envKey: string): boolean {
  return nonEmptyString(provider.apiKey) !== undefined || hasEnvValue(provider, envKey);
}

function hasEnvValue(provider: ProviderConfig, envKey: string): boolean {
  return nonEmptyString(provider.env?.[envKey]) !== undefined;
}

function vertexAILocationFromBaseUrl(baseUrl: string | undefined): string | undefined {
  const url = nonEmptyString(baseUrl);
  if (url === undefined) return undefined;
  try {
    const host = new URL(url).hostname;
    const suffix = '-aiplatform.googleapis.com';
    return host.endsWith(suffix) ? nonEmptyString(host.slice(0, -suffix.length)) : undefined;
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function toIsoDate(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
