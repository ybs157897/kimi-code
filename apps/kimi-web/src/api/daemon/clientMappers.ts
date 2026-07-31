// apps/kimi-web/src/api/daemon/clientMappers.ts
// Mapping functions between the daemon client's local wire shapes and app types.

import type { AppProviderInput, AppTerminal, ProviderRefreshResult } from '../types';
import type { WireTerminal } from './clientWire';
import type { WireProviderRefreshResult } from './wire';

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

/** camelCase form → the snake_case POST/PUT /providers body. */
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
