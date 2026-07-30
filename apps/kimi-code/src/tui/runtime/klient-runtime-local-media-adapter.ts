import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import type { RuntimeLocalMediaPort } from './runtime-local-media-port';

/** Project runtime media persistence and image config through a TUI-owned port. */
export function createKlientRuntimeLocalMediaPort(
  runtime: Pick<KimiV2Runtime, 'klient' | 'localMedia'>,
): RuntimeLocalMediaPort {
  return {
    async getImageMaxEdgePx(): Promise<number | undefined> {
      const image = await runtime.klient.global.config.get<unknown>('image');
      if (typeof image !== 'object' || image === null || Array.isArray(image)) {
        return undefined;
      }
      const maxEdgePx = (image as Readonly<Record<string, unknown>>)['maxEdgePx'];
      return typeof maxEdgePx === 'number' &&
        Number.isInteger(maxEdgePx) &&
        maxEdgePx > 0
        ? maxEdgePx
        : undefined;
    },
    persistOriginalImage: (input) =>
      runtime.localMedia.persistOriginalImage(input),
  };
}
