import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const SessionStoreErrors = {
  codes: {
    /** The requested user-visible turn index is out of range (negative, or
     * exceeds the number of user-visible turns in the session). */
    SESSION_STORE_INVALID_TURN_INDEX: 'session_store.invalid_turn_index',

  },
} as const satisfies ErrorDomain;

registerErrorDomain(SessionStoreErrors);
