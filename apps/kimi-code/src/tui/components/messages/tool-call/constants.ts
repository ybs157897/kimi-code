/**
 * Rendering constants for the tool-call component (caps, timers, markers).
 */

export const MAX_SUB_TOOL_CALLS_SHOWN = 4;
// Cap the Agent `description` in the single-subagent header so a long prompt
// cannot wrap the header onto a second row and break the card's stable height.
export const MAX_SUBAGENT_DESCRIPTION_LENGTH = 60;

export const STREAMING_PROGRESS_INTERVAL_MS = 1000;
export const PROGRESS_URL_RE = /https?:\/\/\S+/g;
export const ABORTED_MARK = '⊘';
export const MAX_LIVE_OUTPUT_CHARS = 50_000;

/** Delay before a long-running foreground Bash/Agent card advertises Ctrl+B. */
export const DETACH_HINT_DELAY_MS = 10_000;
export const DETACH_HINT_TEXT = 'Press Ctrl+B to run in background';
