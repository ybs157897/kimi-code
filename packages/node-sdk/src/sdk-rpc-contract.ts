/**
 * RPC input/result contract types for the SDK RPC surface
 * (`SDKRpcClientBase` and its implementations).
 */

import type { SwarmModeTrigger } from '@moonshot-ai/agent-core-v2/agent/swarm/swarm';

import type { JsonObject, PermissionMode, PromptInput } from '#/types';

export interface SessionPromptRpcInput {
  readonly sessionId: string;
  readonly input: PromptInput;
  /**
   * Client-managed session tool denylist (full-replace semantics), forwarded
   * to engines with profile tool gating. Omit to keep the persisted value;
   * `[]` clears the client portion.
   */
  readonly disabledTools?: readonly string[];
}

export interface SessionIdRpcInput {
  readonly sessionId: string;
}

export interface ImportContextRpcInput extends SessionIdRpcInput {
  readonly content: string;
  readonly source: string;
}

export interface ReloadSessionRpcInput extends SessionIdRpcInput {
  readonly forcePluginSessionStartReminder?: boolean;
}

export interface SetSessionModelRpcInput extends SessionIdRpcInput {
  readonly model: string;
}

export interface SetSessionModelRpcResult {
  readonly model: string;
  readonly providerName?: string | undefined;
}

export interface SetSessionThinkingRpcInput extends SessionIdRpcInput {
  readonly effort: string;
}

export interface SetSessionPermissionRpcInput extends SessionIdRpcInput {
  readonly mode: PermissionMode;
}

export interface UpdateSessionMetadataRpcInput extends SessionIdRpcInput {
  readonly metadata: JsonObject;
}

export interface SetSessionPlanModeRpcInput extends SessionIdRpcInput {
  readonly enabled: boolean;
}

export type SetSessionSwarmModeRpcInput =
  | (SessionIdRpcInput & { readonly enabled: true; readonly trigger: SwarmModeTrigger })
  | (SessionIdRpcInput & { readonly enabled: false });

export interface ActivateSkillRpcInput extends SessionIdRpcInput {
  readonly name: string;
  readonly args?: string | undefined;
}

export interface ActivatePluginCommandRpcInput extends SessionIdRpcInput {
  readonly pluginId: string;
  readonly commandName: string;
  readonly args?: string | undefined;
}

export interface ActivateExpertTeamRpcInput extends SessionIdRpcInput {
  readonly pluginId: string;
}

export interface ActivateExtensionCommandRpcInput extends SessionIdRpcInput {
  readonly name: string;
  readonly args?: string | undefined;
}

export interface ReconnectMcpServerRpcInput extends SessionIdRpcInput {
  readonly name: string;
}
