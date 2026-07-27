export interface SessionContextCompactInput {
  readonly instruction?: string;
}

/** Context mutations owned by one active session-agent pair. */
export interface SessionContextControlPort {
  compact(input?: SessionContextCompactInput): Promise<boolean>;
  cancelCompaction(): Promise<void>;
  undoHistory(count?: number): Promise<void>;
}
