// apps/kimi-web/src/api/desktop/mappers.ts
// The desktop client's local wire↔app mappers — conversions for the wire
// shapes NOT covered by the shared daemon mappers (../daemon/mappers.ts),
// mirrored field-for-field from the daemon client's local helpers
// (daemon/client.ts).

import type { AppProviderInput, AppTerminal, ProviderRefreshResult } from '../types';
import type { WireProviderRefreshResult } from '../daemon/wire';
import type { WireTerminal } from './wire';

export function toAppTerminal(data: WireTerminal): AppTerminal {
  return {
    id: data.id,
    sessionId: data.session_id,
    cwd: data.cwd,
    shell: data.shell,
    cols: data.cols,
    rows: data.rows,
    status: data.status,
    createdAt: data.created_at,
    exitedAt: data.exited_at,
    exitCode: data.exit_code,
  };
}

/** Mirrors the daemon client's `providerRequestBody` (client.ts). */
export function providerRequestBody(input: AppProviderInput): Record<string, unknown> {
  const models = input.models.map((row) => {
    const model: Record<string, unknown> = {
      model: row.model,
      max_context_size: row.maxContextSize,
    };
    if (row.displayName !== undefined && row.displayName !== '') {
      model['display_name'] = row.displayName;
    }
    return model;
  });
  const body: Record<string, unknown> = { id: input.id, type: input.type, models };
  if (input.apiKey !== undefined) body['api_key'] = input.apiKey;
  if (input.baseUrl !== undefined && input.baseUrl !== '') body['base_url'] = input.baseUrl;
  if (input.defaultModel !== undefined && input.defaultModel !== '') {
    body['default_model'] = input.defaultModel;
  }
  return body;
}

export function toProviderRefreshResult(data: WireProviderRefreshResult): ProviderRefreshResult {
  return {
    changed: data.changed.map((item) => ({
      providerId: item.provider_id,
      providerName: item.provider_name,
      added: item.added,
      removed: item.removed,
    })),
    unchanged: data.unchanged,
    failed: data.failed,
  };
}
