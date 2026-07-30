import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const SessionStoreErrors = {
  codes: {
    /** The requested user-visible turn index is out of range (negative, or
     * exceeds the number of user-visible turns in the session). */
    SESSION_STORE_INVALID_TURN_INDEX: 'session_store.invalid_turn_index',
    SESSION_STORE_DELETE_INTENT_FAILED: 'session_store.delete_intent_failed',
    SESSION_STORE_DELETE_RECONCILIATION_FAILED:
      'session_store.delete_reconciliation_failed',
  },
  retryable: [
    'session_store.delete_intent_failed',
    'session_store.delete_reconciliation_failed',
  ],
} as const satisfies ErrorDomain;

registerErrorDomain(SessionStoreErrors);
