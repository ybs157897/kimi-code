import { describe, expect, it, vi } from 'vitest';

import { ExtensionRunner } from '#/extension/runner';
import type { Extension } from '#/extension/types';

function makeExtension(handlers: Extension['handlers']): Extension {
  return {
    path: '/tmp/turn-end-tip.ts',
    resolvedPath: '/tmp/turn-end-tip.ts',
    id: 'turn-end-tip',
    handlers,
    tools: new Map(),
    commands: new Map(),
  };
}

describe('ExtensionRunner.notify', () => {
  it('forwards ctx.notify to the bound runtime without calling sendUserMessage', async () => {
    const notify = vi.fn();
    const sendUserMessage = vi.fn();
    const extension = makeExtension(
      new Map([
        [
          'turn_end',
          [
            (_event, ctx) => {
              ctx.notify('会话结束');
            },
          ],
        ],
      ]),
    );
    const runner = new ExtensionRunner([extension]);
    runner.bind({
      cwd: '/tmp',
      sessionId: 'sess_1',
      sendUserMessage,
      notify,
      setModel: async () => true,
      setActiveTools: () => undefined,
      getActiveTools: () => [],
    });

    await runner.emit({ type: 'turn_end' });

    expect(notify).toHaveBeenCalledExactlyOnceWith('会话结束');
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('reports handler errors to onError listeners without calling sendUserMessage', async () => {
    const onError = vi.fn();
    const sendUserMessage = vi.fn();
    const extension = makeExtension(
      new Map([
        [
          'turn_end',
          [
            () => {
              throw new Error('boom');
            },
          ],
        ],
      ]),
    );
    const runner = new ExtensionRunner([extension]);
    runner.onError(onError);
    runner.bind({
      cwd: '/tmp',
      sessionId: 'sess_1',
      sendUserMessage,
      notify: vi.fn(),
      setModel: async () => true,
      setActiveTools: () => undefined,
      getActiveTools: () => [],
    });

    await runner.emit({ type: 'turn_end' });

    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        event: 'turn_end',
        error: 'boom',
      }),
    );
    expect(sendUserMessage).not.toHaveBeenCalled();
  });
});
