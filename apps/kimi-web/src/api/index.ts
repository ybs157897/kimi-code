// apps/kimi-web/src/api/index.ts
// Singleton factory for the KimiWebApi client. The Wails shell uses its direct
// product bridge automatically; a normal browser keeps the daemon HTTP client.

import { readKimiApiConfig } from './config';
import type { KimiWebApi } from './types';
import { DaemonKimiWebApi } from './daemon/client';
import { createWailsKimiWebApi, getDesktopBridge, isDesktopTransportEnabled } from './desktop';

let singleton: KimiWebApi | undefined;

export function getKimiWebApi(): KimiWebApi {
  singleton ??= isDesktopTransportEnabled()
    ? createWailsKimiWebApi(getDesktopBridge())
    : new DaemonKimiWebApi(readKimiApiConfig());
  return singleton;
}
