// apps/kimi-web/src/api/daemon/wireAuth.ts
// Daemon wire DTOs — auth & OAuth flow shapes. Part of the shared wire barrel
// (wire.ts); ALL fields stay snake_case as they appear on the wire.

// ---------------------------------------------------------------------------
// Auth wire DTOs — REAL endpoints (GET /api/v1/auth, POST/GET/DELETE /api/v1/oauth/login, POST /api/v1/oauth/logout)
// ---------------------------------------------------------------------------

export interface WireManagedProvider {
  status: string;
  [key: string]: unknown;
}

export interface WireAuthResult {
  ready: boolean;
  providers_count: number;
  default_model: string | null;
  managed_provider: WireManagedProvider | null;
}

// `POST /oauth/login` returns one of two shapes, discriminated by `status`:
//   - `pending`: a real device-code flow was started; all device fields are
//     populated so the client can render the device-code step and poll.
//   - `authenticated`: the toolkit already had a usable token and short-
//     circuited via its `ensureFresh` fast path, so no device code was
//     issued; the client can skip the device-code step and treat the login
//     as already complete.
interface WireOAuthLoginStartPending {
  flow_id: string;
  provider: string;
  status: 'pending';
  verification_uri: string;
  verification_uri_complete: string;
  user_code: string;
  expires_in: number;
  interval: number;
  expires_at: string;
}

interface WireOAuthLoginStartAuthenticated {
  flow_id: string;
  provider: string;
  status: 'authenticated';
}

export type WireOAuthLoginStartResult =
  | WireOAuthLoginStartPending
  | WireOAuthLoginStartAuthenticated;

export interface WireOAuthLoginPollResult {
  flow_id: string;
  status: 'pending' | 'authenticated' | 'expired' | 'cancelled';
  resolved_at?: string;
}

export interface WireOAuthCancelResult {
  cancelled: boolean;
  status: string;
}

export interface WireLogoutResult {
  logged_out: boolean;
}
