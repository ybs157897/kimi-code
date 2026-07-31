/**
 * ExitPlanMode result parsing: recover the approval outcome, optional plan
 * path, and approved plan body from the tool result string protocol.
 */

const APPROVED_PLAN_MARKER = '## Approved Plan:';
const AUTO_APPROVED_PLAN_MARKER = '## Plan (auto-approved, not user-reviewed):';

export function extractApprovedPlan(output: string): string {
  const marker = output.includes(AUTO_APPROVED_PLAN_MARKER)
    ? AUTO_APPROVED_PLAN_MARKER
    : APPROVED_PLAN_MARKER;
  const markerIndex = output.indexOf(marker);
  if (markerIndex < 0) return '';
  return output.slice(markerIndex + marker.length).trim();
}

interface ExitPlanModeOutcome {
  readonly kind: 'approved' | 'auto_approved' | 'rejected';
  readonly chosen?: string;
  readonly feedback?: string;
  readonly path?: string;
}

const REJECT_PREFIX = 'User rejected the plan.';
const REJECT_FEEDBACK_PREFIX = 'User rejected the plan. Feedback:';
const APPROVED_OPTION_RE = /^User approved option "([^"]+)"\./;
const PLAN_REJECT_PREFIX = 'Plan rejected by user.';
const SELECTED_APPROACH_RE = /^Exited plan mode\. Selected approach: ([^\n]+)\n/;
const PLAN_SAVED_TO_RE = /\nPlan saved to: ([^\n]+)\n/;

/**
 * Parses the ExitPlanMode result content string to recover the approval outcome
 * and optional plan path. Core-side templates live in
 * `packages/agent-core/src/tools/builtin/planning/exit-plan-mode.ts` and
 * `.../agent/permission/policies/exit-plan-mode-review-ask.ts`:
 *   - Approved output starts with 'Exited plan mode.' and selected options
 *     are reported as 'Selected approach: <label>'. Older outputs may start
 *     with 'User approved option "<label>".' Plan-file mode may include
 *     'Plan saved to: <path>'.
 *   - Auto-approved output (auto permission mode skips the review ask) also
 *     starts with 'Exited plan mode.' but marks the plan body with
 *     '## Plan (auto-approved, not user-reviewed):' instead of
 *     '## Approved Plan:' — the user never saw or approved the plan.
 *   - Rejected output starts with 'Plan rejected by user.' or older
 *     'User rejected the plan.'; feedback uses 'User rejected the plan.
 *     Feedback:\n\n<text>'.
 * This is a string protocol rather than a structured payload. Prefer a
 * structured event payload if core starts emitting one.
 */
export function interpretExitPlanModeOutcome(output: string): ExitPlanModeOutcome {
  if (output.startsWith(REJECT_PREFIX)) {
    if (output.startsWith(REJECT_FEEDBACK_PREFIX)) {
      const feedback = output.slice(REJECT_FEEDBACK_PREFIX.length).trimStart();
      return { kind: 'rejected', feedback };
    }
    return { kind: 'rejected' };
  }
  if (output.startsWith(PLAN_REJECT_PREFIX)) {
    return { kind: 'rejected' };
  }
  const pathMatch = PLAN_SAVED_TO_RE.exec(output);
  const path = pathMatch?.[1]?.trim();
  if (output.includes(AUTO_APPROVED_PLAN_MARKER)) {
    return path !== undefined && path.length > 0
      ? { kind: 'auto_approved', path }
      : { kind: 'auto_approved' };
  }
  const optionMatch = SELECTED_APPROACH_RE.exec(output) ?? APPROVED_OPTION_RE.exec(output);
  if (optionMatch !== null) {
    return path !== undefined && path.length > 0
      ? { kind: 'approved', chosen: optionMatch[1], path }
      : { kind: 'approved', chosen: optionMatch[1] };
  }
  return path !== undefined && path.length > 0 ? { kind: 'approved', path } : { kind: 'approved' };
}

export function isExitPlanModeOutcomeOutput(output: string): boolean {
  return (
    output.startsWith(REJECT_PREFIX) ||
    output.startsWith(PLAN_REJECT_PREFIX) ||
    output.startsWith('Exited plan mode.') ||
    APPROVED_OPTION_RE.test(output) ||
    output.includes(APPROVED_PLAN_MARKER) ||
    output.includes(AUTO_APPROVED_PLAN_MARKER)
  );
}
