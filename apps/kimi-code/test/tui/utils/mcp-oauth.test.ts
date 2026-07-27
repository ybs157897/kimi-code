/**
 * Scenario: MCP OAuth tool progress opens safe browser authorization URLs.
 * Responsibilities: the local structural contract validates the custom wire
 * payload and de-duplicates each URL per tool call across legacy/v2 shapes.
 * Wiring: parsing and de-duplication are real; browser opening is the stub.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/utils/mcp-oauth.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import {
  MCP_OAUTH_AUTHORIZATION_URL_CUSTOM_KIND,
  McpOAuthAuthorizationUrlOpener,
  type OpenUrl,
  type ToolUpdateLike,
  parseMcpOAuthAuthorizationUrlUpdate,
} from '#/tui/utils/mcp-oauth';

describe('parseMcpOAuthAuthorizationUrlUpdate', () => {
  it.each([
    'http://127.0.0.1:8765/oauth?state=abc',
    'https://mcp.example.test/oauth?state=abc',
  ])('extracts the authorization URL when the custom payload uses %s', (url) => {
    const update: ToolUpdateLike = {
      kind: 'custom',
      customKind: MCP_OAUTH_AUTHORIZATION_URL_CUSTOM_KIND,
      customData: {
        serverName: 'example-server',
        authorizationUrl: url,
      },
    };

    expect(parseMcpOAuthAuthorizationUrlUpdate(update)).toEqual({
      serverName: 'example-server',
      authorizationUrl: url,
    });
  });

  it('ignores a non-custom tool update even when its text contains a URL', () => {
    const update: ToolUpdateLike = {
      kind: 'status',
      customKind: MCP_OAUTH_AUTHORIZATION_URL_CUSTOM_KIND,
      customData: {
        serverName: 'example-server',
        authorizationUrl: 'https://mcp.example.test/oauth?state=abc',
      },
    };

    expect(parseMcpOAuthAuthorizationUrlUpdate(update)).toBeUndefined();
  });

  it('ignores a custom update with an unrelated custom kind', () => {
    const update: ToolUpdateLike = {
      kind: 'custom',
      customKind: 'example.unrelated',
      customData: {
        serverName: 'example-server',
        authorizationUrl: 'https://mcp.example.test/oauth?state=abc',
      },
    };

    expect(parseMcpOAuthAuthorizationUrlUpdate(update)).toBeUndefined();
  });

  it.each([
    undefined,
    null,
    [],
    {
      serverName: '',
      authorizationUrl: 'https://mcp.example.test/oauth?state=abc',
    },
    {
      serverName: 42,
      authorizationUrl: 'https://mcp.example.test/oauth?state=abc',
    },
    {
      serverName: 'example-server',
      authorizationUrl: '',
    },
    {
      serverName: 'example-server',
      authorizationUrl: 42,
    },
    {
      serverName: 'example-server',
      authorizationUrl: 'file:///tmp/callback',
    },
    {
      serverName: 'example-server',
      authorizationUrl: 'not a URL',
    },
  ])('ignores malformed custom payload %#', (customData) => {
    expect(
      parseMcpOAuthAuthorizationUrlUpdate({
        kind: 'custom',
        customKind: MCP_OAUTH_AUTHORIZATION_URL_CUSTOM_KIND,
        customData,
      }),
    ).toBeUndefined();
  });
});

describe('McpOAuthAuthorizationUrlOpener', () => {
  it('accepts engine tool progress structures without adapters', () => {
    const openUrl = vi.fn<OpenUrl>();
    const opener = new McpOAuthAuthorizationUrlOpener(openUrl);
    const legacyEvent = {
      type: 'tool.progress',
      turnId: 1,
      toolCallId: 'legacy-tool',
      update: authorizationUrlUpdate(
        'https://mcp.example.test/oauth?state=legacy',
      ),
    };
    const v2Event = {
      type: 'tool.progress',
      turnId: 2,
      toolCallId: 'v2-tool',
      sessionId: 'session-example',
      agentId: 'main',
      update: authorizationUrlUpdate(
        'https://mcp.example.test/oauth?state=v2',
      ),
    };

    opener.handleToolProgress(legacyEvent);
    opener.handleToolProgress(v2Event);

    expect(openUrl).toHaveBeenCalledTimes(2);
    expect(openUrl).toHaveBeenNthCalledWith(
      1,
      'https://mcp.example.test/oauth?state=legacy',
    );
    expect(openUrl).toHaveBeenNthCalledWith(
      2,
      'https://mcp.example.test/oauth?state=v2',
    );
  });

  it('opens each authorization URL once per tool call', () => {
    const openUrl = vi.fn<OpenUrl>();
    const opener = new McpOAuthAuthorizationUrlOpener(openUrl);
    const update = authorizationUrlUpdate(
      'https://mcp.example.test/oauth?state=abc',
    );

    opener.handleToolProgress({ toolCallId: 'tool-1', update });
    opener.handleToolProgress({ toolCallId: 'tool-1', update });
    opener.handleToolProgress({ toolCallId: 'tool-2', update });
    opener.handleToolProgress({
      toolCallId: 'tool-1',
      update: authorizationUrlUpdate(
        'https://mcp.example.test/oauth?state=def',
      ),
    });

    expect(openUrl).toHaveBeenCalledTimes(3);
    expect(openUrl).toHaveBeenNthCalledWith(
      1,
      'https://mcp.example.test/oauth?state=abc',
    );
    expect(openUrl).toHaveBeenNthCalledWith(
      2,
      'https://mcp.example.test/oauth?state=abc',
    );
    expect(openUrl).toHaveBeenNthCalledWith(
      3,
      'https://mcp.example.test/oauth?state=def',
    );
  });

  it('ignores progress updates that do not contain an MCP OAuth authorization URL', () => {
    const openUrl = vi.fn<OpenUrl>();
    const opener = new McpOAuthAuthorizationUrlOpener(openUrl);

    opener.handleToolProgress({
      toolCallId: 'tool-1',
      update: {
        kind: 'status',
        customKind: MCP_OAUTH_AUTHORIZATION_URL_CUSTOM_KIND,
        customData: {
          serverName: 'example-server',
          authorizationUrl: 'https://mcp.example.test/oauth?state=abc',
        },
      },
    });
    opener.handleToolProgress({
      toolCallId: 'tool-1',
      update: authorizationUrlUpdate('file:///tmp/callback'),
    });

    expect(openUrl).not.toHaveBeenCalled();
  });
});

function authorizationUrlUpdate(authorizationUrl: string): ToolUpdateLike {
  return {
    kind: 'custom',
    customKind: MCP_OAUTH_AUTHORIZATION_URL_CUSTOM_KIND,
    customData: {
      serverName: 'example-server',
      authorizationUrl,
    },
  };
}
