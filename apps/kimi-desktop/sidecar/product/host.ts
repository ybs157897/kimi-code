/**
 * Product IPC host — replaces the bare `serveKlientIpc` call so the sidecar can
 * serve BOTH surfaces over the one unix socket (frozen contract E, §11.2):
 *
 *  - every existing klient service dispatches exactly as before, through
 *    `createMemoryDispatcher(scope)` (the same reflector `serveKlientIpc`
 *    builds) — so the Phase 0 raw-klient surface keeps working; and
 *  - the reserved service name `desktopProduct` is intercepted and handled by
 *    the product facade, and a `listen` with `event:"product"` subscribes to
 *    the projected product `WireEvent` stream.
 *
 * The host loop mirrors `packages/klient/src/transports/ipc/host.ts`
 * (ready/hello handshake, call/result/error, listen/listen_result/event,
 * stream frames, token check); only the two interception points are added.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { unlink } from 'node:fs/promises';

import type { EventSourceRef, IDisposable, ScopeRef } from '@moonshot-ai/klient';
import { RPCError } from '@moonshot-ai/klient';
import { createKlient } from '@moonshot-ai/klient/memory';
import {
  createMemoryDispatcher,
  type ScopeLike,
} from '@moonshot-ai/klient/transports/memory/dispatcher';
import { encodeFrame, NdjsonDecoder, type IpcFrame } from '@moonshot-ai/klient/transports/ipc/codec';

import { ProductFacade, PRODUCT_SERVICE } from './facade.js';
import { ProductProjector } from './projector.js';

const REQUEST_INVALID = 40001;
const UNAUTHORIZED = 40100;

/** Reserved `listen` event name that subscribes to the product WireEvent stream. */
const PRODUCT_EVENT = 'product';

export interface ServeProductIpcOptions {
  /** A bootstrapped engine app scope (same value `createKlient({ scope })` takes). */
  readonly scope: ScopeLike;
  /** Unix socket path to listen on. A stale file at the path is removed first. */
  readonly socketPath: string;
  /** Optional token; when set, the client's `hello` must carry the same token. */
  readonly token?: string;
}

export interface ProductIpcHost {
  readonly socketPath: string;
  close(): Promise<void>;
}

function scopeRefFromFrame(frame: IpcFrame): ScopeRef {
  const scope: { sessionId?: string; agentId?: string } = {};
  if (typeof frame.sessionId === 'string') scope.sessionId = frame.sessionId;
  if (typeof frame.agentId === 'string') scope.agentId = frame.agentId;
  return scope;
}

function eventSourceFromFrame(frame: IpcFrame): EventSourceRef {
  if (typeof frame.service === 'string' && typeof frame.event === 'string') {
    return { kind: 'emitter', service: frame.service, event: frame.event };
  }
  if (typeof frame.event === 'string' && frame.event.length > 0) {
    return { kind: 'stream', name: frame.event };
  }
  throw new RPCError(REQUEST_INVALID, `unknown event stream: ${String(frame.event)}`);
}

export async function serveProductIpc(options: ServeProductIpcOptions): Promise<ProductIpcHost> {
  // Fallthrough reflector for every existing klient service (Phase 0 surface).
  const dispatcher = createMemoryDispatcher(options.scope);
  // In-process klient the product facade + projector fulfill through (validated).
  const klient = createKlient({ scope: options.scope });
  const facade = new ProductFacade(klient, options.scope);
  const projector = new ProductProjector(klient);

  // Best-effort cleanup of a stale socket file (ENOENT = nothing to remove).
  try {
    await unlink(options.socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const connections = new Set<Socket>();

  const server: Server = createServer((socket) => {
    connections.add(socket);
    const decoder = new NdjsonDecoder();
    const listens = new Map<string, IDisposable>();
    const activeStreams = new Map<string, AbortController>();
    let helloDone = false;

    const send = (frame: IpcFrame): void => {
      if (!socket.destroyed) socket.write(encodeFrame(frame));
    };
    const sendError = (id: string, error: unknown): void => {
      if (error instanceof RPCError) {
        send({ type: 'error', id, code: error.code, msg: error.message });
      } else {
        send({
          type: 'error',
          id,
          code: 50001,
          msg: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const sendStreamError = (id: string, error: unknown): void => {
      if (error instanceof RPCError) {
        send({ type: 'stream_error', id, code: error.code, msg: error.message });
      } else {
        send({
          type: 'stream_error',
          id,
          code: 50001,
          msg: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const handleFrame = (frame: IpcFrame): void => {
      const id = typeof frame.id === 'string' ? frame.id : '';
      switch (frame.type) {
        case 'hello': {
          if (options.token !== undefined && frame.token !== options.token) {
            send({ type: 'error', id: 'hello', code: UNAUTHORIZED, msg: 'unauthorized' });
            socket.end();
            return;
          }
          helloDone = true;
          return;
        }
        case 'call': {
          if (!helloDone) {
            sendError(id, new RPCError(REQUEST_INVALID, 'expected hello first'));
            return;
          }
          const args = Array.isArray(frame.arg) ? frame.arg : frame.arg === undefined ? [] : [frame.arg];
          // Interception point 1: the reserved product service.
          if (frame.service === PRODUCT_SERVICE) {
            facade
              .dispatch(String(frame.method), args, scopeRefFromFrame(frame))
              .then((data) => {
                send({ type: 'result', id, data });
              })
              .catch((error: unknown) => {
                sendError(id, error);
              });
            return;
          }
          dispatcher
            .call(scopeRefFromFrame(frame), String(frame.service), String(frame.method), args)
            .then((data) => {
              send({ type: 'result', id, data });
            })
            .catch((error: unknown) => {
              sendError(id, error);
            });
          return;
        }
        case 'listen': {
          if (!helloDone) {
            sendError(id, new RPCError(REQUEST_INVALID, 'expected hello first'));
            return;
          }
          // Interception point 2: the projected product event stream.
          if (frame.event === PRODUCT_EVENT) {
            const scope = scopeRefFromFrame(frame);
            if (scope.sessionId === undefined) {
              sendError(id, new RPCError(REQUEST_INVALID, 'product listen requires sessionId'));
              return;
            }
            try {
              const sub = projector.subscribe(scope.sessionId, scope.agentId ?? 'main', (data) => {
                send({ type: 'event', id, data });
              });
              listens.set(id, sub);
              send({ type: 'listen_result', id });
            } catch (error) {
              sendError(id, error);
            }
            return;
          }
          try {
            const source = eventSourceFromFrame(frame);
            const sub = dispatcher.listen(
              scopeRefFromFrame(frame),
              source,
              (data) => {
                send({ type: 'event', id, data });
              },
              (error) => {
                sendError(id, error);
              },
            );
            listens.set(id, sub);
            send({ type: 'listen_result', id });
          } catch (error) {
            sendError(id, error);
          }
          return;
        }
        case 'unlisten': {
          listens.get(id)?.dispose();
          listens.delete(id);
          return;
        }
        case 'stream': {
          if (!helloDone) {
            sendStreamError(id, new RPCError(REQUEST_INVALID, 'expected hello first'));
            return;
          }
          const args = Array.isArray(frame.arg) ? frame.arg : frame.arg === undefined ? [] : [frame.arg];
          const ac = new AbortController();
          activeStreams.set(id, ac);
          const iterable = dispatcher.stream(
            scopeRefFromFrame(frame),
            String(frame.service),
            String(frame.method),
            args,
          );
          void (async () => {
            try {
              for await (const chunk of iterable) {
                if (ac.signal.aborted || socket.destroyed) break;
                send({ type: 'stream_data', id, data: chunk });
              }
              if (!ac.signal.aborted && !socket.destroyed) {
                send({ type: 'stream_end', id });
              }
            } catch (error) {
              if (!ac.signal.aborted && !socket.destroyed) {
                sendStreamError(id, error);
              }
            } finally {
              activeStreams.delete(id);
            }
          })();
          return;
        }
        case 'stream_cancel': {
          const ac = activeStreams.get(id);
          if (ac !== undefined) {
            ac.abort();
            activeStreams.delete(id);
          }
          return;
        }
        default:
          return;
      }
    };

    socket.on('data', (chunk) => {
      for (const frame of decoder.push(chunk.toString('utf8'))) {
        handleFrame(frame);
      }
    });
    const teardown = (): void => {
      for (const sub of listens.values()) sub.dispose();
      listens.clear();
      for (const ac of activeStreams.values()) ac.abort();
      activeStreams.clear();
      connections.delete(socket);
    };
    socket.on('close', teardown);
    socket.on('error', teardown);

    send({ type: 'ready' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, resolve);
  });

  return {
    socketPath: options.socketPath,
    close: () => {
      for (const socket of connections) {
        socket.destroy();
      }
      connections.clear();
      void klient.close();
      return new Promise<void>((resolve) => {
        server.close(() => {
          void unlink(options.socketPath).then(
            () => {
              resolve();
            },
            () => {
              resolve();
            },
          );
        });
      });
    },
  };
}
