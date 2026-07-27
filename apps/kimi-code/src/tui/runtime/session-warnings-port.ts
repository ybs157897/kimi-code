/**
 * Runtime-neutral startup warnings for one active session.
 *
 * Runtime adapters copy their warning records into this local DTO so the TUI
 * does not expose either SDK's session-warning contract.
 */

export type SessionWarningSeverity = 'info' | 'warning' | 'error';

export interface SessionWarningView {
  readonly code: string;
  readonly message: string;
  readonly severity: SessionWarningSeverity;
}

export interface SessionWarningsPort {
  list(): Promise<readonly SessionWarningView[]>;
}
