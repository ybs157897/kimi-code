import { createContext } from 'react';

/** Active session id for deeply nested interaction views (approve/answer buttons). */
export const SessionContext = createContext<string>('');
