// apps/kimi-web/src/api/daemon/wireExpertTeam.ts
// Daemon wire DTOs — expert team shapes. Part of the shared wire barrel
// (wire.ts); ALL fields stay snake_case as they appear on the wire.

// ---------------------------------------------------------------------------
// Expert teams
// ---------------------------------------------------------------------------

export type WireLocalizedText = string | Record<string, string>;

export interface WireExpertTeamMemberInfo {
  agent: string;
  role: 'lead' | 'member';
  display_name?: string;
  name?: WireLocalizedText;
  profession?: WireLocalizedText;
  description?: string;
  avatar?: string;
}

export interface WireExpertTeamDefinition {
  plugin_id: string;
  plugin_version?: string;
  display_name: string;
  description?: string;
  profession?: string;
  tags: string[];
  lead_agent_name: string;
  member_agent_names: string[];
  members: WireExpertTeamMemberInfo[];
  quick_prompts: string[];
  default_init_prompt?: string;
  category_id?: string;
}

export type WireExpertTeamMemberStatus =
  | 'spawning'
  | 'running'
  | 'completed'
  | 'failed'
  | 'shutdown';

export interface WireExpertTeamSnapshot {
  binding: {
    plugin_id: string;
    plugin_version?: string;
    display_name: string;
    lead_agent_name: string;
    lead_profile_name: string;
    member_agent_names: string[];
    previous_profile_name?: string;
    activated_at: string;
  };
  team?: {
    id: string;
    name: string;
    description?: string;
    created_at: string;
    members: Array<{
      name: string;
      agent_id: string;
      profile_name: string;
      status: WireExpertTeamMemberStatus;
      updated_at: string;
      task_id?: string;
    }>;
  };
}
