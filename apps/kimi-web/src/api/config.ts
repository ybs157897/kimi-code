// apps/kimi-web/src/api/config.ts
// Reads Vite env, builds REST/WS URLs, manages stable clientId.

import { safeGetString, safeSetString, STORAGE_KEYS } from '../lib/storage';

const CLIENT_ID_KEY = STORAGE_KEYS.clientId;
const WEB_CLIENT_NAME = 'kimi-code-web';
const WEB_CLIENT_UI_MODE = 'web';

export interface KimiApiConfig {
  serverHttpUrl: string;
  clientId: string;
  clientName: string;
  clientVersion: string;
  clientUiMode: string;
}

// Desktop shells (apps/kimi-desktop) run this bundle from a webview asset
// scheme, so same-origin API calls cannot work there. The shell injects the
// loopback API origin at runtime before the bundle boots.
declare global {
  interface Window {
    __KIMI_DESKTOP_SERVER_ORIGIN__?: string;
  }
}

function desktopServerOrigin(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = window.__KIMI_DESKTOP_SERVER_ORIGIN__;
  return value && value.trim() ? value : undefined;
}

export function readKimiApiConfig(): KimiApiConfig {
  return {
    serverHttpUrl: normalizeServerOrigin(
      desktopServerOrigin() ?? import.meta.env.VITE_KIMI_SERVER_HTTP_URL,
    ),
    clientId: getClientId(),
    clientName: WEB_CLIENT_NAME,
    clientVersion: webClientVersion(),
    clientUiMode: WEB_CLIENT_UI_MODE,
  };
}

// Default to SAME-ORIGIN so we never depend on CORS:
//  - dev: the SPA is served by Vite; the Vite dev proxy forwards /v1, /healthz
//    and /v1/ws to the server (see vite.config.ts), so the browser only ever
//    talks to its own origin.
//  - prod: `kimi web` serves this built SPA from the server itself, so the
//    server's origin already is the API origin.
// Set VITE_KIMI_SERVER_HTTP_URL to connect directly to an absolute server
// origin instead (that path does require the server to send CORS headers).
function defaultServerOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return 'http://127.0.0.1:58627';
}

export function normalizeServerOrigin(value: string | undefined): string {
  const raw = value && value.trim() ? value : defaultServerOrigin();
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

/** Strip the scheme for a compact display origin: `http://127.0.0.1:58627` → `127.0.0.1:58627`. */
function shortOrigin(origin: string): string {
  return origin.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * Address of the REAL server the client is connected to, shown in the status bar.
 * Always the actual server — never the dev-proxy URL — since that's the thing
 * worth knowing at a glance. Cases:
 *  - VITE_KIMI_SERVER_HTTP_URL set → that absolute server origin (direct mode).
 *  - dev (same-origin proxy) → the proxy's upstream target (the real server).
 *  - prod (server serves the SPA) → the page origin (it IS the server).
 */
export function serverEndpointLabel(): string {
  const desktop = desktopServerOrigin();
  if (desktop) return shortOrigin(normalizeServerOrigin(desktop));

  const direct = import.meta.env.VITE_KIMI_SERVER_HTTP_URL;
  if (direct && direct.trim()) return shortOrigin(normalizeServerOrigin(direct));

  const proxy =
    typeof __KIMI_DEV_PROXY_TARGET__ !== 'undefined' ? __KIMI_DEV_PROXY_TARGET__ : '';
  if (import.meta.env.DEV && proxy) return shortOrigin(proxy);

  const origin =
    typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
  return shortOrigin(origin);
}

// The real server serves every product REST route under /api/v1; the
// WebSocket endpoint lives at /api/v1/ws.
export function buildRestUrl(origin: string, path: string, apiPrefix = '/api/v1'): string {
  return `${origin}${apiPrefix}${path.startsWith('/') ? path : `/${path}`}`;
}

export function buildWsUrl(origin: string, clientId: string): string {
  const url = new URL(`${origin}/api/v1/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('client_id', clientId);
  return url.toString();
}

function getClientId(): string {
  const stored = safeGetString(CLIENT_ID_KEY);
  if (stored) return stored;
  const generated = `web_${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
  safeSetString(CLIENT_ID_KEY, generated);
  return generated;
}

function webClientVersion(): string {
  return typeof __KIMI_WEB_VERSION__ === 'string' && __KIMI_WEB_VERSION__.trim()
    ? __KIMI_WEB_VERSION__
    : '0.0.0-dev';
}
