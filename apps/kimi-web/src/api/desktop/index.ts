// apps/kimi-web/src/api/desktop/index.ts
// Desktop bridge factory. Picks the transport once, on first use: the Wails
// wrapper when the shell's globals are present, otherwise the browser dev
// mock that streams through the same event contract. Phase 0 only — the
// existing `src/api/daemon/**` data layer is untouched (see
// docs/plan/desktop-product.md §3 M4).

import { WailsDesktopBridge } from './bridge';
import { isDesktopDevBackendSelected } from '../devBackend';
import { DevDesktopBridge } from './devBridge';
import { MockDesktopBridge } from './mock';
import type { DesktopBridge } from './types';

export * from './types';
export { WailsDesktopBridge } from './bridge';
export { DevDesktopBridge } from './devBridge';
export { MockDesktopBridge } from './mock';
export { WailsKimiWebApi, createWailsKimiWebApi } from './client';

/** True when running inside the Wails shell (bindings + runtime injected). */
export function isDesktopShellAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  return window.go?.main?.App !== undefined && window.runtime !== undefined;
}

let singleton: DesktopBridge | undefined;

/**
 * The shared bridge. Resolved lazily on first call (the demo calls it after
 * mount, by which point Wails has injected its globals); the choice sticks
 * for the page's lifetime.
 */
export function getDesktopBridge(): DesktopBridge {
  singleton ??= isDesktopShellAvailable()
    ? new WailsDesktopBridge()
    : isDesktopDevBackendSelected()
      ? new DevDesktopBridge()
      : new MockDesktopBridge();
  return singleton;
}

/**
 * Demo opt-in (`?desktop_demo=1`), mirroring the `?debug=1` convention of the
 * KAP debug panel. The demo surface is dev tooling for the Phase 0 seam proof.
 */
export function isDesktopDemoEnabled(): boolean {
  try {
    if (typeof location === 'undefined') return false;
    const v = new URLSearchParams(location.search).get('desktop_demo');
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}

/**
 * The native shell always selects the product transport. Query parameters are
 * retained as explicit development overrides: `1` enables the browser mock,
 * while `0` lets a Wails build diagnose the legacy daemon transport.
 */
export function isDesktopTransportEnabled(): boolean {
  try {
    if (typeof location !== 'undefined') {
      const value = new URLSearchParams(location.search).get('desktop_transport');
      if (value === '1' || value === 'true') return true;
      if (value === '0' || value === 'false') return false;
    }
    return isDesktopShellAvailable() || isDesktopDevBackendSelected();
  } catch {
    return isDesktopShellAvailable() || isDesktopDevBackendSelected();
  }
}
