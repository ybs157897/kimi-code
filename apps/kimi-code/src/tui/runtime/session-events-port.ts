import type { TUIAgentEvent, TUIAgentReplay } from './agent-events-port';
import type { SessionExpertTeamSnapshot } from './session-expert-team-port';

export type TUIWireValue =
  | null
  | boolean
  | number
  | string
  | readonly TUIWireValue[]
  | { readonly [key: string]: TUIWireValue };

/**
 * Session ports use the wire-safe default. The generic parameter lets the
 * legacy reverse-RPC callback normalize its SDK-owned opaque detail at the UI
 * adapter edge without importing that SDK type into the controller.
 */
export type TUIApprovalDisplay<GenericDetail = TUIWireValue> =
  | {
      readonly kind: 'command';
      readonly command: string;
      readonly cwd?: string;
      readonly description?: string;
      readonly language?: 'bash';
    }
  | {
      readonly kind: 'file_io';
      readonly operation: 'read' | 'write' | 'edit' | 'glob' | 'grep';
      readonly path: string;
      readonly detail?: string;
      readonly content?: string;
      readonly before?: string;
      readonly after?: string;
    }
  | {
      readonly kind: 'diff';
      readonly path: string;
      readonly before: string;
      readonly after: string;
      readonly hunks?: number;
    }
  | {
      readonly kind: 'search';
      readonly query: string;
      readonly scope?: string;
    }
  | {
      readonly kind: 'url_fetch';
      readonly url: string;
      readonly method?: string;
    }
  | {
      readonly kind: 'agent_call';
      readonly agent_name: string;
      readonly prompt: string;
      readonly background?: boolean;
    }
  | {
      readonly kind: 'skill_call';
      readonly skill_name: string;
      readonly args?: string;
    }
  | {
      readonly kind: 'todo_list';
      readonly items: {
        readonly title: string;
        readonly status: string;
      }[];
    }
  | {
      readonly kind: 'task';
      readonly task_id: string;
      readonly status: string;
      readonly description: string;
      readonly task_kind?: string;
    }
  | {
      readonly kind: 'task_stop';
      readonly task_id: string;
      readonly task_description: string;
    }
  | {
      readonly kind: 'plan_review';
      readonly plan: string;
      readonly path?: string;
      readonly options?: readonly TUIApprovalOption[];
    }
  | {
      readonly kind: 'goal_start';
      readonly objective: string;
      readonly completionCriterion?: string;
      readonly mode: 'manual' | 'yolo';
    }
  | {
      readonly kind: 'generic';
      readonly summary: string;
      readonly detail?: GenericDetail;
    };

export interface TUIApprovalOption {
  readonly label: string;
  readonly description: string;
}

export interface TUIApprovalRequest<GenericDetail = TUIWireValue> {
  readonly turnId?: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: TUIApprovalDisplay<GenericDetail>;
}

export type TUIApprovalDecision = 'approved' | 'rejected' | 'cancelled';

export interface TUIApprovalResponse {
  readonly decision: TUIApprovalDecision;
  readonly scope?: 'session';
  readonly feedback?: string;
  readonly selectedLabel?: string;
}

export interface TUIQuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface TUIQuestionItem {
  readonly question: string;
  readonly header?: string;
  readonly body?: string;
  readonly options: readonly TUIQuestionOption[];
  readonly multiSelect?: boolean;
  readonly otherLabel?: string;
  readonly otherDescription?: string;
}

export type TUIQuestionAnswerMethod = 'enter' | 'space' | 'number_key';
export type TUIQuestionAnswers = Record<string, string | true>;

export interface TUIQuestionResponse {
  readonly answers: TUIQuestionAnswers;
  readonly method?: TUIQuestionAnswerMethod;
}

export type TUIQuestionResult =
  | null
  | TUIQuestionAnswers
  | TUIQuestionResponse;

export interface TUIQuestionRequest {
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly questions: readonly TUIQuestionItem[];
}

export interface TUISessionMetadataChangedEvent {
  readonly type: 'session.metadata.changed';
  readonly sessionId: string;
  readonly changed: readonly string[];
  readonly title?: string;
  readonly patch?: Readonly<Record<string, unknown>>;
}

export interface TUISessionExpertTeamChangedEvent {
  readonly type: 'session.expert-team.changed';
  readonly sessionId: string;
  readonly snapshot: SessionExpertTeamSnapshot | null;
}

interface TUIInteractionBase {
  readonly id: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnId?: number;
  readonly createdAt?: number;
}

export interface TUIApprovalInteraction extends TUIInteractionBase {
  readonly kind: 'approval';
  readonly request: TUIApprovalRequest;
}

export interface TUIQuestionInteraction extends TUIInteractionBase {
  readonly kind: 'question';
  readonly request: TUIQuestionRequest;
}

export type TUIInteraction = TUIApprovalInteraction | TUIQuestionInteraction;

export interface TUIInteractionRequestedEvent {
  readonly type: 'interaction.requested';
  readonly interaction: TUIInteraction;
}

export type TUIInteractionResolvedEvent =
  | {
      readonly type: 'interaction.resolved';
      readonly id: string;
      readonly sessionId: string;
      readonly kind: 'approval';
      readonly response: TUIApprovalResponse;
    }
  | {
      readonly type: 'interaction.resolved';
      readonly id: string;
      readonly sessionId: string;
      readonly kind: 'question';
      readonly response: TUIQuestionResult;
    };

export type TUISessionScopedEvent =
  | TUISessionMetadataChangedEvent
  | TUISessionExpertTeamChangedEvent
  | TUIInteractionRequestedEvent
  | TUIInteractionResolvedEvent;

/**
 * @deprecated Temporary mixed-event compatibility for controllers that have
 * not yet moved their agent branches to AgentEventsPort.
 */
export type TUISessionEvent = TUISessionScopedEvent | TUIAgentEvent;

/** @deprecated Use TUISessionScopedEventListener for SessionScopedEventsPort. */
export type TUISessionEventListener = (event: TUISessionEvent) => void;
export type TUISessionScopedEventListener = (event: TUISessionScopedEvent) => void;
export type UnsubscribeSessionEvents = () => void;

/** Runtime-neutral session event and interaction boundary consumed by the TUI. */
export interface SessionScopedEventsPort {
  subscribe(listener: TUISessionScopedEventListener): UnsubscribeSessionEvents;
  respondToApproval(id: string, response: TUIApprovalResponse): Promise<void>;
  respondToQuestion(id: string, result: TUIQuestionResult): Promise<void>;
}

/**
 * @deprecated Transitional combined surface for controllers that have not yet
 * split session and agent subscriptions. New code uses SessionScopedEventsPort
 * with AgentEventsPort.
 */
export interface SessionEventsPort {
  subscribe(listener: TUISessionEventListener): UnsubscribeSessionEvents;
  readReplay(agentId?: string): Promise<TUIAgentReplay | undefined>;
  respondToApproval(id: string, response: TUIApprovalResponse): Promise<void>;
  respondToQuestion(id: string, result: TUIQuestionResult): Promise<void>;
}
