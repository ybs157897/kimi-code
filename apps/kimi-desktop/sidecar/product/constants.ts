/**
 * Product facade wire constants — the v1 wire error codes the daemon HTTP
 * transport returns, plus the upload / stream / export / metadata caps that
 * mirror kap-server. Shared by the facade class and the error-mapping /
 * helper submodules.
 */

export const REQUEST_INVALID = 40001;
export const REQUEST_MALFORMED = 40002;
export const SESSION_NOT_FOUND = 40401;
export const PROMPT_NOT_FOUND = 40402;
export const QUESTION_NOT_FOUND = 40405;
export const TASK_NOT_FOUND = 40406;
export const FILE_NOT_FOUND = 40407;
export const FS_PATH_NOT_FOUND = 40409;
export const WORKSPACE_NOT_FOUND = 40410;
export const FS_PERMISSION_DENIED = 40411;
export const PROVIDER_NOT_FOUND = 40412;
export const TERMINAL_NOT_FOUND = 40414;
export const SKILL_NOT_FOUND = 40415;
export const SESSION_BUSY = 40901;
export const APPROVAL_ALREADY_RESOLVED = 40902;
export const TASK_ALREADY_FINISHED = 40904;
export const FS_IS_DIRECTORY = 40906;
export const FS_IS_BINARY = 40907;
export const FS_GIT_UNAVAILABLE = 40908;
export const QUESTION_DISMISSED = 40909;
export const COMPACTION_UNABLE = 40910;
export const SESSION_UNDO_UNAVAILABLE = 40911;
export const SKILL_NOT_ACTIVATABLE = 40912;
export const FS_ALREADY_EXISTS = 40919;
export const FILE_TOO_LARGE = 41301;
export const FS_TOO_LARGE = 41302;
export const FS_TOO_MANY_RESULTS = 41303;
export const FS_PATH_ESCAPES_SESSION = 41304;
export const FS_GREP_TIMEOUT = 41305;
export const INTERNAL_ERROR = 50001;

/** Default cap (bytes) for getTask output preview — mirrors kap-server. */
export const DEFAULT_TASK_OUTPUT_PREVIEW_BYTES = 32 * 1024;

/** v1 `:undo` message page-size clamp. */
export const DEFAULT_UNDO_MESSAGE_PAGE_SIZE = 50;
export const MAX_UNDO_MESSAGE_PAGE_SIZE = 100;

/** Most-recent messages included in a snapshot page (mirrors kap-server). */
export const SNAPSHOT_MESSAGE_PAGE_SIZE = 100;

/** Static server version surfaced on `getMeta` (the sidecar carries no build version). */
export const SERVER_VERSION = '0.1.0';

/** Reserved service name the sidecar intercepts (frozen contract E). */
export const PRODUCT_SERVICE = 'desktopProduct';

/** Slice 5 — chunked upload session TTL and concurrency cap. */
export const UPLOAD_SESSION_TTL_MS = 5 * 60 * 1000;
export const MAX_UPLOAD_SESSIONS = 10;
/** Slice 5 — single-file byte cap per upload session (41301 FILE_TOO_LARGE). */
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
/** Slice 5 — per-chunk base64 frame cap (the client sends ~684 KiB per 512 KiB). */
export const MAX_UPLOAD_CHUNK_BASE64 = 1024 * 1024;
/** Strict padded base64 — rejects silently-corrupted `Buffer.from` passthroughs. */
export const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Raw bytes per product binary stream frame (512 KiB → ~684 KiB in base64). */
export const PRODUCT_STREAM_CHUNK_BYTES = 512 * 1024;

/** Cap for session-export archives — mirrors kap-server's 64 MiB web limit. */
export const MAX_SESSION_EXPORT_BYTES = 64 * 1024 * 1024;

/** Skill prompt-metadata limits — mirror agent-core-v2 promptMetadataText.ts. */
export const MAX_SKILL_PROMPT_METADATA_LENGTH = 4000;
export const MAX_SKILL_PROMPT_TITLE_LENGTH = 200;
