import { isRecord } from '#/utils/type-guards';

export const MCP_OAUTH_AUTHORIZATION_URL_CUSTOM_KIND =
  'mcp.oauth.authorization_url';

export interface ToolUpdateLike {
  readonly kind: string;
  readonly customKind?: string;
  readonly customData?: unknown;
}

export interface ToolProgressLike {
  readonly toolCallId: string;
  readonly update: ToolUpdateLike;
}

export interface McpOAuthAuthorizationUrlUpdateData {
  readonly serverName: string;
  readonly authorizationUrl: string;
}

export type OpenUrl = (url: string) => void;

export class McpOAuthAuthorizationUrlOpener {
  private readonly openedAuthorizationUrls = new Set<string>();

  constructor(private readonly openUrl: OpenUrl) {}

  handleToolProgress(event: ToolProgressLike): void {
    const update = parseMcpOAuthAuthorizationUrlUpdate(event.update);
    if (update === undefined) return;
    const key = `${event.toolCallId}\0${update.authorizationUrl}`;
    if (this.openedAuthorizationUrls.has(key)) return;
    this.openedAuthorizationUrls.add(key);
    this.openUrl(update.authorizationUrl);
  }
}

export function parseMcpOAuthAuthorizationUrlUpdate(
  update: ToolUpdateLike,
): McpOAuthAuthorizationUrlUpdateData | undefined {
  if (update.kind !== 'custom') return undefined;
  if (update.customKind !== MCP_OAUTH_AUTHORIZATION_URL_CUSTOM_KIND) {
    return undefined;
  }
  const data = update.customData;
  if (!isRecord(data)) return undefined;
  const serverName = data['serverName'];
  const authorizationUrl = data['authorizationUrl'];
  if (typeof serverName !== 'string' || serverName.length === 0) return undefined;
  if (typeof authorizationUrl !== 'string' || authorizationUrl.length === 0) return undefined;
  if (!isHttpUrl(authorizationUrl)) return undefined;
  return { serverName, authorizationUrl };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
