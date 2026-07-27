/**
 * Rebuild the engine state behind one active session while preserving its
 * persisted identity. Dynamic catalogs are reloaded through their own ports.
 */
export interface SessionRefreshPort {
  reload(): Promise<void>;
}
