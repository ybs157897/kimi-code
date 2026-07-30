import { realpathSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const expectedCwd = process.env['EXPECTED_CWD'];
if (
  expectedCwd !== undefined &&
  realpathSync(process.cwd()) !== realpathSync(expectedCwd)
) {
  throw new Error(`Expected cwd ${expectedCwd}, received ${process.cwd()}`);
}

const server = new McpServer({ name: 'cwd-stdio', version: '0.0.1' });

server.registerTool(
  'get_cwd',
  {
    description: 'Returns the server process cwd',
    inputSchema: {},
  },
  () => ({
    content: [{ type: 'text', text: process.cwd() }],
  }),
);

await server.connect(new StdioServerTransport());
