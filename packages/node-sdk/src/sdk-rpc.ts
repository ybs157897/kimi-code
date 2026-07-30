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
    ? (payload: Payload, options?: RPCCallOptions) => Promise<Awaited<Return>>
    : never;
};

export type PromisableMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => infer Return
    ? (...args: Args) => Awaited<Return> | PromiseLike<Awaited<Return>>
    : never;
};

export type RPCClient<Self extends object, Other extends object> = (
  self: PromisableMethods<Self>,
) => Promise<RPCMethods<Other>>;

// ── Helpers ──────────────────────────────────────────────────────────────

class ControlledPromise<T> {
  readonly promise: Promise<T>;
  private _resolve!: (value: T | PromiseLike<T>) => void;
  private settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this._resolve = resolve;
    });
  }

  resolve(value: T | PromiseLike<T>): void {
    if (this.settled) return;
    this.settled = true;
    this._resolve(value);
  }
}

type RpcCallable = (payload: unknown) => unknown;
type WrappedRpcCallable = (
  payload: unknown,
  options?: RPCCallOptions,
) => Promise<unknown>;

function isRpcCallable(value: unknown): value is RpcCallable {
  return typeof value === 'function';
}

/**
 * Map callable own and prototype properties, wrapping each with a JSON
 * round-trip simulation. Class-backed RPC implementations put their methods
 * on the prototype, so stopping at own properties silently produced an empty
 * RPC surface.
 */
function mapRpcFunctions<T extends object>(obj: PromisableMethods<T>): RPCMethods<T> {
  const result: Record<PropertyKey, WrappedRpcCallable> = {};
  const visited = new Set<PropertyKey>();
  let current: object | null = obj;

  while (current !== null && current !== Object.prototype) {
    for (const key of Reflect.ownKeys(current)) {
      if (key === 'constructor' || visited.has(key)) continue;
      visited.add(key);

      const value: unknown = Reflect.get(obj, key);
      if (!isRpcCallable(value)) continue;
      result[key] = wrapRpcFunction(value, obj);
    }
    current = Reflect.getPrototypeOf(current);
  }

  return result as RPCMethods<T>;
}

function wrapRpcFunction(fn: RpcCallable, receiver: object): WrappedRpcCallable {
  return async (payload: unknown, options?: RPCCallOptions) => {
    options?.signal?.throwIfAborted();
    const rpcPayload = await simulateNetwork(payload);
    options?.signal?.throwIfAborted();
    const result = await Reflect.apply(fn, receiver, [rpcPayload]);
    return simulateNetwork(result);
  };
}

function simulateNetwork<T>(data: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => {
      let cloned = data;
      try {
        const serialized = JSON.stringify(data);
        cloned = serialized === undefined ? (undefined as T) : JSON.parse(serialized) as T;
      } catch {}
      resolve(cloned);
    }, 0);
  });
}

/**
 * Create a paired RPC bridge for in-process communication.
 *
 * Returns two callbacks: the first wires up the left side implementation and
 * returns a proxy for the right side; the second does the reverse.
 */
export function createRPC<Left extends object, Right extends object>(): [
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

  return [leftClient, rightClient];
}
