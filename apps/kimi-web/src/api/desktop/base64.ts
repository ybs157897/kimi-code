// apps/kimi-web/src/api/desktop/base64.ts
// Base64 ↔ bytes helpers shared by the Slice 5 binary-file surface: upload
// chunking (client.ts) and download stream assembly (bridge.ts / mock.ts).
// btoa / atob only accept binary strings, and `String.fromCharCode(...bytes)`
// overflows the argument limit on large buffers, so the conversion batches.

const FROM_CHAR_CODE_BATCH = 0x8000;

export function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += FROM_CHAR_CODE_BATCH) {
    binary += String.fromCodePoint(...bytes.subarray(i, i + FROM_CHAR_CODE_BATCH));
  }
  return btoa(binary);
}

export function bytesFromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.codePointAt(i) ?? 0;
  return bytes;
}
