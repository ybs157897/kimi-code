/**
 * `task` domain (L5) — task id generation: `<kind>-<suffix>` identifiers drawn
 * from a crypto-random alphabet.
 */

import { randomBytes } from 'node:crypto';

const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function generateTaskId(kind: string): string {
  const bytes = randomBytes(8);
  let suffix = '';
  for (let index = 0; index < 8; index++) {
    suffix += TASK_ID_ALPHABET[bytes[index]! % TASK_ID_ALPHABET.length];
  }
  return `${kind}-${suffix}`;
}
