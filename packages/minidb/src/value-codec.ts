// src/value-codec.ts
//
// Value codecs: the pluggable encode/decode between a stored Buffer and the
// caller's value type, selected by OpenOptions.valueCodec.

export type ValueCodecName = 'buffer' | 'string' | 'json';

export interface ValueCodec<V> {
  encode(v: V): Buffer;
  decode(b: Buffer): V;
}

const BUFFER: ValueCodec<Buffer> = {
  encode: (v) => {
    if (!Buffer.isBuffer(v)) throw new TypeError('value must be a Buffer (use valueCodec: "string" or "json")');
    return v;
  },
  // Return a copy so a caller mutating the result cannot corrupt the stored
  // value (the store keeps the same Buffer reference internally).
  decode: (b) => Buffer.from(b),
};
const STRING: ValueCodec<string> = {
  encode: (v) => Buffer.from(String(v), 'utf8'),
  decode: (b) => b.toString('utf8'),
};
const JSON_CODEC: ValueCodec<unknown> = {
  encode: (v) => Buffer.from(JSON.stringify(v), 'utf8'),
  decode: (b) => JSON.parse(b.toString('utf8')),
};
export const CODECS: Record<ValueCodecName, ValueCodec<unknown>> = { buffer: BUFFER, string: STRING, json: JSON_CODEC };
