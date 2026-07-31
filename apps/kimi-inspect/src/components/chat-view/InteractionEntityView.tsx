import { useContext, useState } from 'react';

import { ISessionApprovalService } from '@moonshot-ai/agent-core-v2/session/approval/approval';
import {
  ISessionQuestionService,
  type QuestionItem,
  type QuestionRequest,
} from '@moonshot-ai/agent-core-v2/session/question/question';
import { type TranscriptInteraction } from '@moonshot-ai/transcript';

import { useConnection } from '../../connection';
import { ActionButton, Badge, ErrorLine, JsonView } from '../../ui';
import { SessionContext } from './SessionContext';

export function InteractionEntityView({
  interaction,
  nested,
}: {
  interaction: TranscriptInteraction;
  nested?: boolean;
}) {
  const { klient } = useConnection();
  const sessionId = useContext(SessionContext);
  const [busy, setBusy] = useState(false);
  const [respondError, setRespondError] = useState<unknown>(null);
  /** Question answers in progress: question text → selected option labels. */
  const [selections, setSelections] = useState<Readonly<Record<string, readonly string[]>>>({});
  /** Question free-text ("Other") input: question text → draft. */
  const [others, setOthers] = useState<Readonly<Record<string, string>>>({});

  const pending = interaction.state === 'pending';
  const questionRequest =
    interaction.interactionKind === 'question'
      ? (interaction.request as QuestionRequest | undefined)
      : undefined;

  const run = (fn: () => Promise<unknown>): void => {
    setBusy(true);
    setRespondError(null);
    void fn()
      .catch((error: unknown) => {
        setRespondError(error);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const decide = (decision: 'approved' | 'rejected'): void => {
    run(() =>
      klient
        .session(sessionId)
        .service(ISessionApprovalService)
        .decide(interaction.interactionId, { decision }),
    );
  };

  const toggleOption = (question: QuestionItem, label: string): void => {
    setSelections((prev) => {
      const current = prev[question.question] ?? [];
      const next =
        question.multiSelect === true
          ? current.includes(label)
            ? current.filter((item) => item !== label)
            : [...current, label]
          : current.includes(label)
            ? []
            : [label];
      return { ...prev, [question.question]: next };
    });
  };

  const submitAnswers = (): void => {
    const answers: Record<string, string> = {};
    for (const question of questionRequest?.questions ?? []) {
      const parts = [...(selections[question.question] ?? [])];
      const other = (others[question.question] ?? '').trim();
      if (other !== '') parts.push(other);
      if (parts.length > 0) answers[question.question] = parts.join(', ');
    }
    // Mirror the TUI adapter: no answers at all resolves with null.
    const result =
      Object.keys(answers).length > 0 ? { answers, method: 'enter' as const } : null;
    run(() =>
      klient.session(sessionId).service(ISessionQuestionService).answer(interaction.interactionId, result),
    );
  };

  const dismiss = (): void => {
    run(() =>
      klient.session(sessionId).service(ISessionQuestionService).dismiss(interaction.interactionId),
    );
  };

  return (
    <div
      className={`mb-2 max-w-[85%] rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-[11px] ${
        nested === true ? 'mt-2 max-w-full' : ''
      }`}
    >
      <div className="mb-1 flex items-center gap-2">
        <Badge tone={pending ? 'amber' : 'neutral'}>{interaction.interactionKind}</Badge>
        <span className="text-neutral-400">{interaction.state}</span>
        <span className="text-neutral-600">tool: {interaction.toolCallId}</span>
      </div>
      {interaction.request !== undefined ? <JsonView data={interaction.request} /> : null}
      {interaction.response !== undefined ? <JsonView data={interaction.response} /> : null}
      {pending && interaction.interactionKind === 'approval' ? (
        <div className="mt-2 flex gap-2">
          <ActionButton onClick={() => decide('approved')} disabled={busy}>
            Approve
          </ActionButton>
          <ActionButton onClick={() => decide('rejected')} danger disabled={busy}>
            Reject
          </ActionButton>
        </div>
      ) : null}
      {pending && questionRequest !== undefined ? (
        <div className="mt-2">
          {questionRequest.questions.map((question) => (
            <div key={question.question} className="mb-2">
              <div className="text-neutral-300">{question.header ?? question.question}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {question.options.map((option) => {
                  const selected = (selections[question.question] ?? []).includes(option.label);
                  return (
                    <button
                      key={option.label}
                      className={`rounded border px-2 py-0.5 text-[10px] transition-colors disabled:opacity-40 ${
                        selected
                          ? 'border-sky-600 bg-sky-900/50 text-sky-200'
                          : 'border-neutral-700 text-neutral-400 hover:bg-neutral-800'
                      }`}
                      title={option.description}
                      disabled={busy}
                      onClick={() => toggleOption(question, option.label)}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
              <input
                className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[11px] text-neutral-100 outline-none focus:border-sky-600"
                placeholder={question.otherLabel ?? 'Other…'}
                value={others[question.question] ?? ''}
                disabled={busy}
                onChange={(e) => {
                  setOthers((prev) => ({ ...prev, [question.question]: e.target.value }));
                }}
              />
            </div>
          ))}
          <div className="flex gap-2">
            <ActionButton onClick={submitAnswers} disabled={busy}>
              Answer
            </ActionButton>
            <ActionButton onClick={dismiss} danger disabled={busy}>
              Dismiss
            </ActionButton>
          </div>
        </div>
      ) : null}
      {respondError !== null ? (
        <div className="mt-2">
          <ErrorLine error={respondError} />
        </div>
      ) : null}
    </div>
  );
}
