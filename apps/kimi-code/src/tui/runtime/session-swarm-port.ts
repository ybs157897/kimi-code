/** Runtime-neutral swarm-mode control for one bound session-agent pair. */

export type SessionSwarmTrigger = 'manual' | 'task' | 'tool';

export interface SessionSwarmPort {
  isActive(): Promise<boolean>;
  enter(trigger: SessionSwarmTrigger): Promise<void>;
  exit(): Promise<void>;
}
