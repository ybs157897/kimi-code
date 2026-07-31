// apps/kimi-web/src/api/desktop/constants.ts
// Shared constants for the desktop product transport (client.ts).

/** Conventional main-agent id used to scope the product subscription. */
export const MAIN_AGENT_ID = 'main';

/**
 * Slice 5 upload chunk size: 512 KiB raw per `uploadChunk`, ~684 KiB base64 —
 * comfortably inside one NDJSON IPC frame (frozen Slice 5 protocol).
 */
export const UPLOAD_CHUNK_BYTES = 512 * 1024;
