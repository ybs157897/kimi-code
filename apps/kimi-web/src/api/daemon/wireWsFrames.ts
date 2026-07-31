// apps/kimi-web/src/api/daemon/wireWsFrames.ts
// Daemon wire DTOs — WS control frames: server frames (S→C) and client
// control messages (C→S). Part of the shared wire barrel (wire.ts); ALL fields
// stay snake_case as they appear on the wire.

import type { WireSessionCursor } from './wireWsSync';
import type { WireEvent } from './wireWsEvents';

// ---------------------------------------------------------------------------
// WS Server frames (S→C)
// ---------------------------------------------------------------------------

/** All typed server-to-client WS frames */
export type WireServerFrame =
  | WireServerHello
  | WireAck
  | WirePing
  | WireResyncRequired
  | WireErrorFrame
  | WireEvent;

export interface WireServerHello {
  type: 'server_hello';
  timestamp: string;
  payload: {
    server_id: string;
    /** Advisory only — kap-server omits this since it sends no heartbeat. */
    heartbeat_ms?: number;
    max_event_buffer_size: number;
    capabilities: {
      event_batching: boolean;
      compression: boolean;
    };
  };
}

export interface WireAck {
  type: 'ack';
  id: string;
  code: number;
  msg: string;
  payload: unknown;
}

export interface WirePing {
  type: 'ping';
  timestamp: string;
  payload: { nonce: string };
}

export interface WireResyncRequired {
  type: 'resync_required';
  timestamp: string;
  payload: {
    session_id: string;
    reason: 'buffer_overflow' | 'session_recreated' | 'epoch_changed';
    current_seq: number;
    /** Current journal epoch — adopt it after resyncing (v2 sync protocol). */
    epoch?: string;
  };
}

export interface WireErrorFrame {
  type: 'error';
  timestamp: string;
  payload: {
    code: number;
    msg: string;
    fatal: boolean;
    request_id?: string;
    details?: unknown;
  };
}

// ---------------------------------------------------------------------------
// WS Client control messages (C→S)
// ---------------------------------------------------------------------------

export type WireClientControl =
  | WireClientHello
  | WireSubscribe
  | WireUnsubscribe
  | WireAbort
  | WirePong;

export interface WireClientHello {
  type: 'client_hello';
  id: string;
  payload: {
    client_id: string;
    subscriptions: string[];
    cursors?: Record<string, WireSessionCursor>;
  };
}

export interface WireSubscribe {
  type: 'subscribe';
  id: string;
  payload: {
    session_ids: string[];
    cursors?: Record<string, WireSessionCursor>;
  };
}

export interface WireUnsubscribe {
  type: 'unsubscribe';
  id: string;
  payload: { session_ids: string[] };
}

export interface WireAbort {
  type: 'abort';
  id: string;
  payload: {
    session_id: string;
    prompt_id: string;
  };
}

export interface WirePong {
  type: 'pong';
  payload: { nonce: string };
}
