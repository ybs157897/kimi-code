/**
 * SDK-local RPC helpers — `createRPC`, `RPCMethods`, and related types.
 *
 * The legacy `@moonshot-ai/agent-core` package defined these for the
 * in-process RPC bridge between KimiConfigRpcClient and its core impl.
 * This module re-implements them with the same semantics.
 */

export interface RPCCallOptions {
  signal?: AbortSignal;
}

export type RPCMethods<T> = {
  [K in keyof T]: T[K] extends (payload: infer Payload) => infer Return
    ? (payload: Payload, options?: RPCCallOptions) => Promise<Return>
    : never;
};

export type PromisableMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => infer Return
    ? (...args: Args) => Promise<Return>
    : never;
};

export type RPCClient<Self extends Record<string, any>, Other extends Record<string, any>> = (
  self: PromisableMethods<Self>,
) => Promise<RPCMethods<Other>>;

// ── Helpers ──────────────────────────────────────────────────────────────

class ControlledPromise<T> {
  readonly promise: Promise<T>;
  private _resolve!: (value: T | PromiseLike<T>) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this._resolve = resolve;
    });
  }

  resolve(value: T | PromiseLike<T>): void {
    this._resolve(value);
  }
}

/**
 * Deep-map the own-function properties of an object, wrapping each with
 * JSON round-trip simulation + error handling, matching the legacy
 * agent-core semantics.
 */
function mapRpcFunctions<T extends Record<string, any>>(obj: T): RPCMethods<T> {
  const result: Record<string, any> = {};
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as Record<string, any>)[key];
    if (typeof val !== 'function') continue;
    if (key === 'constructor') continue;
    result[key] = wrapRpcFunction(val);
  }
  return result as RPCMethods<T>;
}

function wrapRpcFunction(fn: Function): (payload: any, options?: RPCCallOptions) => Promise<any> {
  return async (payload: any, options?: RPCCallOptions) => {
    options?.signal?.throwIfAborted();
    const rpcPayload = await simulateNetwork(payload);
    const result = await fn(rpcPayload);
    return simulateNetwork(result);
  };
}

function simulateNetwork<T>(data: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => {
      try {
        const serialized = JSON.stringify(data);
        resolve(serialized === undefined ? (undefined as T) : JSON.parse(serialized));
      } catch {
        resolve(data);
      }
    }, 0);
  });
}

/**
 * Create a paired RPC bridge for in-process communication.
 *
 * Returns two callbacks: the first wires up the left side implementation and
 * returns a proxy for the right side; the second does the reverse.
 */
export function createRPC<Left extends Record<string, any>, Right extends Record<string, any>>(): [
  RPCClient<Left, Right>,
  RPCClient<Right, Left>,
] {
  const leftReady = new ControlledPromise<PromisableMethods<Left>>();
  const rightReady = new ControlledPromise<PromisableMethods<Right>>();

  async function leftClient(self: PromisableMethods<Left>): Promise<RPCMethods<Right>> {
    leftReady.resolve(self);
    const rightImpl = await rightReady.promise;
    return mapRpcFunctions(rightImpl);
  }

  async function rightClient(self: PromisableMethods<Right>): Promise<RPCMethods<Left>> {
    rightReady.resolve(self);
    const leftImpl = await leftReady.promise;
    return mapRpcFunctions(leftImpl);
  }

  return [
    leftClient as unknown as RPCClient<Left, Right>,
    rightClient as unknown as RPCClient<Right, Left>,
  ];
}
