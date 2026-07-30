/**
 * Wire builders for the product layer — mirror kap-server's edge projections
 * (`packages/kap-server/src/routes/{sessions,approvals,questions}.ts`) so the
 * desktop sidecar returns/emits byte-compatible kimi-web wire JSON. Pure
 * functions only; no engine access here (callers pass the in-process shapes).
 */

import type { ContentPart } from '@moonshot-ai/agent-core-v2/kosong/contract/message';
import type { ApprovalRequest } from '@moonshot-ai/agent-core-v2/session/approval/approval';
import type { QuestionRequest } from '@moonshot-ai/agent-core-v2/session/question/question';
import type { Interaction } from '@moonshot-ai/agent-core-v2/session/interaction/interaction';
import { SECONDARY_DERIVED_MODEL_ID } from '@moonshot-ai/agent-core-v2/app/kosongConfig/secondaryModelOverlay';

import type {
  ExpertTeamDefinition,
  ExpertTeamSnapshot,
} from '@moonshot-ai/agent-core-v2/session/expertTeam/expertTeam';

import type {
  WireApprovalRequest,
  WireConfig,
  WireConfigProvider,
  WireExpertTeamDefinition,
  WireExpertTeamSnapshot,
  WireImageSource,
  WireMessageContent,
  WireMeta,
  WireQuestionRequest,
  WireSession,
  WireSessionUsage,
  WireTaskListItem,
  WireWorkspace,
} from './wire.js';

// ---------------------------------------------------------------------------
// ids / usage
// ---------------------------------------------------------------------------

/** Short unique id with a prefix — mirrors the daemon projector's `ulid`. */
export function ulid(prefix = 'msg_'): string {
  const t = Date.now().toString(36).padStart(10, '0');
  const r = Math.random().toString(36).slice(2, 12).padEnd(10, '0');
  return `${prefix}${t}${r}`;
}

export function emptySessionUsage(): WireSessionUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_cost_usd: 0,
    context_tokens: 0,
    context_limit: 0,
    turn_count: 0,
  };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** The fields `toWireSession` reads — the common shape of `SessionSummary`
 *  and `SessionMeta` (both carry id/workspaceId/title/timestamps/archived). */
export interface SessionWireFields {
  readonly id: string;
  readonly workspaceId?: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly custom?: Record<string, unknown>;
}

export interface SessionFacts {
  readonly busy: boolean;
  readonly mainTurnActive: boolean;
  readonly pendingInteraction: 'none' | 'approval' | 'question';
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

export const COLD_SESSION_FACTS: SessionFacts = {
  busy: false,
  mainTurnActive: false,
  pendingInteraction: 'none',
};

/** Mirrors kap-server `buildWireMetadata`: drop the reserved `goal` key, overlay cwd. */
function buildWireMetadata(custom: Record<string, unknown> | undefined, cwd: string): { cwd: string; [k: string]: unknown } {
  if (custom === undefined) return { cwd };
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(custom)) {
    if (key === 'goal') continue;
    rest[key] = value;
  }
  return { ...rest, cwd };
}

/** Mirrors kap-server `toWireDefinition` (routes/expertTeams.ts). */
export function toWireExpertTeamDefinition(definition: ExpertTeamDefinition): WireExpertTeamDefinition {
  return {
    plugin_id: definition.pluginId,
    plugin_version: definition.pluginVersion,
    display_name: definition.displayName,
    description: definition.description,
    profession: definition.profession,
    tags: [...definition.tags],
    lead_agent_name: definition.leadAgentName,
    member_agent_names: [...definition.memberAgentNames],
    members: definition.members.map((member) => ({
      agent: member.agent,
      role: member.role,
      display_name: member.displayName,
      name: member.name,
      profession: member.profession,
      description: member.description,
      avatar: member.avatar,
    })),
    quick_prompts: [...definition.quickPrompts],
    default_init_prompt: definition.defaultInitPrompt,
    category_id: definition.categoryId,
  };
}

/** Mirrors kap-server `toWireSnapshot` (routes/expertTeams.ts). */
export function toWireExpertTeamSnapshot(snapshot: ExpertTeamSnapshot): WireExpertTeamSnapshot {
  return {
    binding: {
      plugin_id: snapshot.binding.pluginId,
      plugin_version: snapshot.binding.pluginVersion,
      display_name: snapshot.binding.displayName,
      lead_agent_name: snapshot.binding.leadAgentName,
      lead_profile_name: snapshot.binding.leadProfileName,
      member_agent_names: [...snapshot.binding.memberAgentNames],
      previous_profile_name: snapshot.binding.previousProfile.profileName,
      activated_at: snapshot.binding.activatedAt,
    },
    team:
      snapshot.team === undefined
        ? undefined
        : {
            id: snapshot.team.id,
            name: snapshot.team.name,
            description: snapshot.team.description,
            created_at: snapshot.team.createdAt,
            members: snapshot.team.members.map((member) => ({
              name: member.name,
              agent_id: member.agentId,
              profile_name: member.profileName,
              status: member.status,
              updated_at: member.updatedAt,
              task_id: member.taskId,
            })),
          },
  };
}

/**
 * Mirrors kap-server `toWireTask` (routes/tasks.ts): project engine
 * `AgentTaskInfo` to the wire `Task` shape (snake_case + ISO timestamps).
 */
export function toWireTask(
  sessionId: string,
  info: {
    readonly taskId: string;
    readonly kind: string;
    readonly description: string;
    readonly status: string;
    readonly startedAt: number;
    readonly endedAt: number | null;
    readonly command?: string;
  },
  output?: { preview: string; bytes: number },
): WireTaskListItem {
  const mapKind = (k: string): WireTaskListItem['kind'] => {
    switch (k) {
      case 'process':
        return 'bash';
      case 'agent':
        return 'subagent';
      default:
        return 'tool';
    }
  };
  const mapStatus = (s: string): WireTaskListItem['status'] => {
    switch (s) {
      case 'running':
        return 'running';
      case 'completed':
        return 'completed';
      case 'failed':
      case 'timed_out':
      case 'lost':
        return 'failed';
      case 'killed':
        return 'cancelled';
      default:
        return 'failed';
    }
  };
  const createdIso = new Date(info.startedAt).toISOString();
  const item: WireTaskListItem = {
    id: info.taskId,
    session_id: sessionId,
    kind: mapKind(info.kind),
    description: info.description,
    status: mapStatus(info.status),
    created_at: createdIso,
    started_at: createdIso,
  };
  if (info.endedAt !== null && info.endedAt !== undefined) {
    item.completed_at = new Date(info.endedAt).toISOString();
  }
  if (info.kind === 'process' && info.command !== undefined) {
    item.command = info.command;
  }
  if (output !== undefined) {
    item.output_preview = output.preview;
    item.output_bytes = output.bytes;
  }
  return item;
}

/** Mirrors kap-server `toWireSession` (routes/sessions.ts). */
export function toWireSession(fields: SessionWireFields, cwd: string, facts: SessionFacts): WireSession {
  return {
    id: fields.id,
    workspace_id: fields.workspaceId,
    title: fields.title ?? '',
    created_at: new Date(fields.createdAt).toISOString(),
    updated_at: new Date(fields.updatedAt).toISOString(),
    busy: facts.busy,
    main_turn_active: facts.mainTurnActive,
    pending_interaction: facts.pendingInteraction,
    last_turn_reason: facts.lastTurnReason,
    archived: fields.archived,
    last_prompt: fields.lastPrompt,
    metadata: buildWireMetadata(fields.custom, cwd),
    // v2 engine does not backfill these heavy fields on the read path (live
    // values ride GET /status + the agent.status.updated stream) — same as
    // kap-server, which returns placeholders here.
    agent_config: { model: '' },
    usage: emptySessionUsage(),
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
  };
}

// ---------------------------------------------------------------------------
// Approval / Question (from pending Interaction records)
// ---------------------------------------------------------------------------

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Mirrors kap-server `toWireApproval` (routes/approvals.ts). */
export function toWireApproval(interaction: Interaction, sessionId: string): WireApprovalRequest {
  const p = interaction.payload as ApprovalRequest;
  return {
    approval_id: interaction.id,
    session_id: sessionId,
    turn_id: interaction.origin.turnId,
    tool_call_id: p.toolCallId ?? interaction.id,
    tool_name: p.toolName,
    action: p.action,
    tool_input_display: p.display,
    created_at: new Date(interaction.createdAt).toISOString(),
    // v2 approvals never expire; the wire still carries a derived expiry.
    expires_at: new Date(interaction.createdAt + APPROVAL_TTL_MS).toISOString(),
  };
}

/** Mirrors kap-server `toWireQuestion` (routes/questions.ts) — synthesizes the
 *  item/option ids the in-process model lacks (`q_<i>`, `opt_<i>_<j>`). */
export function toWireQuestion(interaction: Interaction, sessionId: string): WireQuestionRequest {
  const req = interaction.payload as QuestionRequest;
  return {
    question_id: interaction.id,
    session_id: sessionId,
    turn_id: req.turnId,
    tool_call_id: req.toolCallId,
    created_at: new Date(interaction.createdAt).toISOString(),
    questions: req.questions.map((q, qi) => ({
      id: `q_${qi}`,
      question: q.question,
      header: q.header,
      body: q.body,
      multi_select: q.multiSelect,
      // The in-process model always allows an "other" free-text answer.
      allow_other: true,
      other_label: q.otherLabel,
      other_description: q.otherDescription,
      options: q.options.map((o, oi) => ({
        id: `opt_${qi}_${oi}`,
        label: o.label,
        description: o.description,
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Prompt content: kimi-web WireMessageContent[] → engine ContentPart[]
// (the `PromptPart` subset: text / image_url / video_url)
// ---------------------------------------------------------------------------

function imageSourceToUrl(source: WireImageSource): string | undefined {
  if (source.kind === 'url') return source.url;
  if (source.kind === 'base64') return `data:${source.media_type};base64,${source.data}`;
  // 'file' sources need a blob upload round-trip the first slice does not do.
  return undefined;
}

/** Convert a prompt's wire content into engine prompt parts. Unsupported parts
 *  (tool_use/tool_result/file/thinking) are dropped — a user prompt only ever
 *  carries text/image/video. */
export function wireContentToPromptParts(content: readonly WireMessageContent[]): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'image') {
      const url = imageSourceToUrl(part.source);
      if (url !== undefined) {
        parts.push({
          type: 'image_url',
          imageUrl: { url, id: part.source.kind === 'url' ? part.source.id : undefined },
        });
      }
    } else if (part.type === 'video') {
      const url = imageSourceToUrl(part.source);
      if (url !== undefined) {
        parts.push({
          type: 'video_url',
          videoUrl: { url, id: part.source.kind === 'url' ? part.source.id : undefined },
        });
      }
    }
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Workspace (routes/workspaces.ts `toWireWorkspace`)
// ---------------------------------------------------------------------------

/** The fields `toWireWorkspace` reads — the engine `Workspace` record. */
export interface WorkspaceWireFields {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastOpenedAt: number;
}

/** Mirrors kap-server `toWireWorkspace` (routes/workspaces.ts). */
export function toWireWorkspace(ws: WorkspaceWireFields, sessionCount: number): WireWorkspace {
  return {
    id: ws.id,
    root: ws.root,
    name: ws.name,
    created_at: new Date(ws.createdAt).toISOString(),
    last_opened_at: new Date(ws.lastOpenedAt).toISOString(),
    session_count: sessionCount,
  };
}

// ---------------------------------------------------------------------------
// Server metadata (routes/meta.ts — static payload)
// ---------------------------------------------------------------------------

/** Mirrors kap-server `registerMetaRoute`'s frozen `MetaResponse` payload. */
export function buildWireMeta(serverId: string, startedAt: string, serverVersion: string): WireMeta {
  return {
    server_version: serverVersion,
    capabilities: {
      websocket: true,
      file_upload: true,
      fs_query: true,
      mcp: true,
      tasks: true,
      terminal: true,
    },
    server_id: serverId,
    started_at: startedAt,
    open_in_apps: [],
    dangerous_bypass_auth: false,
    backend: 'v2',
  };
}

// ---------------------------------------------------------------------------
// Config (routes/config.ts `toConfigResponse`) — project the camelCase resolved
// config into the snake_case wire shape, redacting provider credentials and
// hiding the synthesized `__secondary__` derived model entry.
// ---------------------------------------------------------------------------

/** Mirrors kap-server `toConfigResponse` (routes/config.ts). */
export function toWireConfig(resolved: Record<string, unknown>): WireConfig {
  const wire: Record<string, unknown> = {};
  for (const [domain, value] of Object.entries(resolved)) {
    wire[camelToSnake(domain)] =
      domain === 'providers'
        ? toConfigProviderResponses(value)
        : domain === 'models'
          ? withoutDerivedSecondaryEntry(value)
          : value;
  }
  // v1 wire echo: surface `yolo` as a derived boolean of the effective default
  // permission mode (`yolo` is never a persisted config domain).
  const defaultPermissionMode = resolved['defaultPermissionMode'];
  if (typeof defaultPermissionMode === 'string') {
    wire['yolo'] = defaultPermissionMode === 'yolo';
  }
  // `providers` is required by the wire shape even when none is configured.
  if (wire['providers'] === undefined) {
    wire['providers'] = {};
  }
  return wire as unknown as WireConfig;
}

interface ProviderLike {
  readonly type?: unknown;
  readonly baseUrl?: unknown;
  readonly defaultModel?: unknown;
  readonly apiKey?: unknown;
  readonly oauth?: unknown;
}

function toConfigProviderResponses(value: unknown): Record<string, WireConfigProvider> {
  const result: Record<string, WireConfigProvider> = {};
  if (!isPlainObject(value)) return result;
  for (const [id, raw] of Object.entries(value)) {
    const provider = raw as ProviderLike;
    result[id] = {
      type: typeof provider.type === 'string' ? provider.type : '',
      base_url: nonEmpty(provider.baseUrl),
      default_model: nonEmpty(provider.defaultModel),
      has_api_key: hasProviderCredential(provider),
    };
  }
  return result;
}

function hasProviderCredential(provider: ProviderLike): boolean {
  if (nonEmpty(provider.apiKey) !== undefined) return true;
  if (provider.oauth !== undefined) return true;
  return false;
}

function withoutDerivedSecondaryEntry(value: unknown): unknown {
  if (!isPlainObject(value) || !(SECONDARY_DERIVED_MODEL_ID in value)) return value;
  const out: Record<string, unknown> = { ...value };
  delete out[SECONDARY_DERIVED_MODEL_ID];
  return out;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function camelToSnake(str: string): string {
  return str.replaceAll(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}
