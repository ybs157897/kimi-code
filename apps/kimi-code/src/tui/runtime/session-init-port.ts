/** Runtime-neutral control plane for one session's AGENTS.md generation. */
export interface SessionInitPort {
  generateAgentsMd(): Promise<void>;
  cancel(): Promise<void>;
}
