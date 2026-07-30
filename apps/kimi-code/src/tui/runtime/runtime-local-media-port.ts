/** Runtime-neutral media capabilities consumed by the interactive TUI. */
export interface RuntimeLocalMediaPort {
  /**
   * Read the current env-resolved image edge limit.
   *
   * `undefined` delegates to the compressor's built-in default.
   */
  getImageMaxEdgePx(): Promise<number | undefined>;
  persistOriginalImage(input: {
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly sessionId?: string;
  }): Promise<string | null>;
}
