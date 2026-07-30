/**
 * Minimal harness/session surface used to verify the SDK root compatibility
 * facade.
 *
 * Production print mode runs directly through the v2 Runtime + Klient host.
 * `runPromptWithCompatibilityFacade` retains this narrow driver so the public
 * SDK facade can be exercised independently without coupling it to CLI routing.
 */

import type {
  ApprovalHandler,
  ConfigDiagnostics,
  CreateGoalInput,
  CreateSessionOptions,
  Event,
  GetCronTasksResult,
  GoalSnapshot,
  GoalToolResult,
  KimiAuthFacade,
  KimiConfig,
  ListSessionsOptions,
  PermissionMode,
  PromptInput,
  QuestionHandler,
  ResumeSessionInput,
  SessionStatus,
  SessionSummary,
  TelemetryProperties,
  Unsubscribe,
} from '@moonshot-ai/kimi-code-sdk';

export interface PromptHarness {
  readonly homeDir: string;
  readonly auth: KimiAuthFacade;

  track(event: string, properties?: TelemetryProperties): void;

  ensureConfigFile(): Promise<void>;
  getConfig(): Promise<Pick<KimiConfig, 'defaultModel' | 'telemetry'>>;
  getConfigDiagnostics(): Promise<ConfigDiagnostics>;
  listSessions(options: ListSessionsOptions): Promise<readonly SessionSummary[]>;
  createSession(options: CreateSessionOptions): Promise<PromptSession>;
  resumeSession(input: ResumeSessionInput): Promise<PromptSession>;
  close(): Promise<void>;
}

export interface PromptSession {
  readonly id: string;
  readonly workDir: string;

  getStatus(): Promise<SessionStatus>;
  setModel(model: string): Promise<void>;
  setPermission(mode: PermissionMode): Promise<void>;
  setApprovalHandler(handler: ApprovalHandler | undefined): void;
  setQuestionHandler(handler: QuestionHandler | undefined): void;
  onEvent(listener: (event: Event) => void): Unsubscribe;
  prompt(input: string | PromptInput): Promise<void>;
  waitForBackgroundTasksOnPrint(): Promise<void>;
  handlePrintMainTurnCompleted?(): Promise<'finish' | 'continue'>;
  createGoal(input: CreateGoalInput): Promise<GoalSnapshot>;
  getGoal(): Promise<GoalToolResult>;
  getCronTasks(): Promise<GetCronTasksResult>;
}
