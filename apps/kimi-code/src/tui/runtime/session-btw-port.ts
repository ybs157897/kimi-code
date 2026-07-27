/**
 * Runtime-neutral control plane for starting one session side agent.
 *
 * Follow-up child prompts, cancellation, and events stay on the existing
 * agent control and event ports.
 */
export interface SessionBtwPort {
  start(): Promise<string>;
}
