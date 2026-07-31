// apps/kimi-web/src/api/daemon/wireModel.ts
// Daemon wire DTOs — model, provider and config shapes. Part of the shared
// wire barrel (wire.ts); ALL fields stay snake_case as they appear on the wire.

// ---------------------------------------------------------------------------
// Model + Provider wire DTOs
// PRESUMED — not in current daemon docs; isolated here, swap when backend defines them.
// ---------------------------------------------------------------------------

export interface WireModel {
  provider: string;
  model: string;
  display_name?: string;
  max_context_size: number;
  capabilities?: string[];
  support_efforts?: string[];
  default_effort?: string;
}

export interface WireProvider {
  id: string;
  type: string;
  base_url?: string;
  default_model?: string;
  has_api_key: boolean;
  status: 'connected' | 'error' | 'unconfigured';
  models?: string[];
}

/** GET /providers/{id} — the single-provider read reveals the stored api_key
 *  so a local client can prefill its edit form. */
export interface WireProviderDetail extends WireProvider {
  api_key?: string;
}

/** Model row in POST /providers and PUT /providers/{id} bodies. */
export interface WireProviderModelInput {
  model: string;
  max_context_size: number;
  display_name?: string;
  capabilities?: string[];
  max_output_size?: number;
  support_efforts?: string[];
  adaptive_thinking?: boolean;
}

export interface WireProviderRefreshResult {
  changed: Array<{
    provider_id: string;
    provider_name: string;
    added: number;
    removed: number;
  }>;
  unchanged: string[];
  failed: Array<{ provider: string; reason: string }>;
}

export interface WireConfigProvider {
  type: string;
  base_url?: string;
  default_model?: string;
  has_api_key: boolean;
}

export interface WireConfig {
  providers: Record<string, WireConfigProvider>;
  default_provider?: string;
  default_model?: string;
  models?: Record<string, unknown>;
  thinking?: unknown;
  plan_mode?: boolean;
  yolo?: boolean;
  default_permission_mode?: string;
  default_plan_mode?: boolean;
  permission?: unknown;
  hooks?: unknown[];
  services?: unknown;
  merge_all_available_skills?: boolean;
  extra_skill_dirs?: string[];
  loop_control?: unknown;
  background?: unknown;
  experimental?: Record<string, boolean>;
  telemetry?: boolean;
  raw?: Record<string, unknown>;
}
