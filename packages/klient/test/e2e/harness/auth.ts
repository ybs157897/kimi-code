const WS_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';

export function resolveServerToken(url: string, explicitToken?: string): string | undefined {
  if (explicitToken !== undefined) return explicitToken;

  const token = process.env['KIMI_SERVER_TOKEN'];
  const serverUrl = process.env['KIMI_SERVER_URL'];
  if (token === undefined || serverUrl === undefined) return undefined;

  try {
    return normalizedOrigin(url) === normalizedOrigin(serverUrl) ? token : undefined;
  } catch {
    return undefined;
  }
}

export function withServerAuth(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Parameters<typeof fetch>[1] {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  const token = resolveServerToken(url);
  if (token === undefined) return init;

  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  if (!headers.has('authorization')) {
    headers.set('authorization', `Bearer ${token}`);
  }
  return { ...init, headers };
}

export function serverWsProtocols(url: string, explicitToken?: string): string[] | undefined {
  const token = resolveServerToken(url, explicitToken);
  return token === undefined ? undefined : [`${WS_BEARER_PROTOCOL_PREFIX}${token}`];
}

function normalizedOrigin(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  return parsed.origin;
}
