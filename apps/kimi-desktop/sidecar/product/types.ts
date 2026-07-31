/**
 * Product facade shared types — the positional call context, the binary
 * stream frame shapes, the upload-limit test seam, and the facade's internal
 * per-upload / per-prompt bookkeeping records.
 */

/** Positional-arg context the host forwards from the call frame. */
export interface ProductCallContext {
  readonly sessionId?: string;
  readonly agentId?: string;
  /** The IPC connection that issued the call — uploads are scoped to it so a
   *  disconnect can cancel in-flight sessions. */
  readonly connId?: string;
}

/** One data frame of a product binary stream (`stream_data` payload). */
export interface ProductStreamChunk {
  readonly chunk: string;
  readonly seq: number;
}

/**
 * Final sentinel yielded by a product stream. The IPC host converts it into
 * the `stream_end` payload (`{ mime, size, filename }`) instead of a
 * `stream_data` frame.
 */
export interface ProductStreamEnd {
  readonly end: true;
  readonly mime: string;
  readonly size: number;
  readonly filename: string;
}

export type ProductStreamItem = ProductStreamChunk | ProductStreamEnd;

/**
 * In-flight chunked upload state (Slice 5). Chunks stream into a per-session
 * temp directory under the engine cache (never accumulated in memory), and
 * every exit path — finish, cancel, TTL, chunk failure, IPC teardown via
 * `cancelUploadsForConnection` — removes the temp directory.
 */
export interface UploadSession {
  readonly name: string;
  readonly mimeType: string | undefined;
  readonly tempDir: string;
  readonly tempPath: string;
  received: number;
  readonly connId: string | undefined;
  readonly timer: NodeJS.Timeout;
}

export interface PromptRoute {
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnId: number | undefined;
}

/** Test seam for upload limits — the host uses the module defaults. */
export interface ProductFacadeLimits {
  readonly maxUploadBytes?: number;
  readonly maxUploadChunkBase64?: number;
}
