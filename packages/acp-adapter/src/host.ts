import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { LegacyAcpHost } from './legacy-acp-host';
import type { AcpHost } from './types';

export function toAcpHost(host: AcpHost | KimiHarness): AcpHost {
  return isAcpHost(host) ? host : new LegacyAcpHost(host);
}

function isAcpHost(host: AcpHost | KimiHarness): host is AcpHost {
  return (
    'checkAuthenticated' in host &&
    typeof host.checkAuthenticated === 'function' &&
    'listAvailableModels' in host &&
    typeof host.listAvailableModels === 'function'
  );
}
