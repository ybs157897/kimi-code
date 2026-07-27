/**
 * Runtime-neutral skills control plane for one active session and agent.
 *
 * Adapters project runtime-owned skill summaries into this TUI-neutral view,
 * reload the runtime catalog, and route explicit user activation through the
 * selected agent.
 */

export type SkillSource = 'project' | 'user' | 'extra' | 'builtin';

export interface SkillSummaryView {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly source: SkillSource;
  readonly type?: string;
  readonly disableModelInvocation?: boolean;
  readonly isSubSkill?: boolean;
}

export interface SessionSkillsPort {
  list(): Promise<readonly SkillSummaryView[]>;
  reload(): Promise<void>;
  activate(name: string, args: string): Promise<void>;
}
