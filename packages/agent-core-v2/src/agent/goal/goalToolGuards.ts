/**
 * `goal` domain (L4) — goal tool-call predicates.
 *
 * Pure guards over goal mutation tool calls: which tools mutate the goal,
 * which approval labels map to a permission mode, and whether an `UpdateGoal`
 * result terminally decided the goal.
 */

import { isPlainRecord } from '#/_base/utils/canonical-args';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import type { ExecutableToolResult } from '#/tool/toolContract';

export function isGoalMutationTool(toolName: string): boolean {
  return toolName === 'CreateGoal' || toolName === 'UpdateGoal' || toolName === 'SetGoalBudget';
}

export function toGoalStartReviewPermissionMode(label: string | undefined): PermissionMode | undefined {
  if (label === 'auto' || label === 'yolo' || label === 'manual') return label;
  return undefined;
}

export function isTerminalUpdateGoalResult(
  toolName: string,
  args: unknown,
  result: ExecutableToolResult,
): boolean {
  if (toolName !== 'UpdateGoal' || result.isError === true || result.stopTurn !== true) {
    return false;
  }
  if (!isPlainRecord(args)) return false;
  const status = args['status'];
  return status === 'complete' || status === 'blocked';
}
