import type { Kaos } from '@moonshot-ai/kaos';
import type {
  AgentEventPayloads,
  SessionEventPayloads,
  SessionHandle,
} from '@moonshot-ai/klient';

import type { OAuthRef } from '#/sdk-config';
import type { KimiV2Runtime } from '#/v2/runtime';

export interface BearerTokenProvider {
  getAccessToken(options?: { readonly force?: boolean }): Promise<string>;
}

export type OAuthTokenProviderResolver = (
  providerName: string,
  oauthRef?: OAuthRef,
) => BearerTokenProvider | undefined;

export type Klient = KimiV2Runtime['klient'];
export type IndexedSession = NonNullable<
  Awaited<ReturnType<Klient['global']['sessions']['get']>>
>;
export type V2McpCatalogEntry = Awaited<
  ReturnType<Klient['global']['mcp']['catalog']['list']>
>[number];
export type V2McpServerConfig = V2McpCatalogEntry['config'];
export type V2ExpertTeamSnapshot = NonNullable<
  SessionEventPayloads['expert-team.changed']
>;
export type V2ExpertTeamMemberStatus = NonNullable<
  V2ExpertTeamSnapshot['team']
>['members'][number]['status'];
export type V2CronTask = Awaited<ReturnType<SessionHandle['cron']['list']>>[number];

export type BeginGlobalMcpServerAuthResult =
  | { readonly status: 'already-authorized' }
  | {
      readonly status: 'authorization-required';
      readonly flowId: string;
      readonly authorizationUrl: string;
    };

export interface CoreOverrides {
  readonly kaos?: Kaos;
  readonly persistenceKaos?: Kaos;
}

export type ForwardedAgentEventName = Exclude<
  keyof AgentEventPayloads,
  'permission.approval.requested' | 'permission.approval.resolved'
>;
