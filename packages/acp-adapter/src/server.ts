/**
 * ACP server barrel. The implementation lives in {@link ./acp-server}
 * (the {@link AcpServer} class) and {@link ./run} (the stdio/stream
 * runners); this module keeps the historical `./server` import path
 * stable for consumers.
 */

export { AcpServer } from './acp-server';
export { runAcpServer, runAcpServerWithStream } from './run';
export type { SlashCommandsSnapshot } from './slash-commands';
