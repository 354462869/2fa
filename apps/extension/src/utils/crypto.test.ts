import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  deriveKeyFromPassword,
  generateDEK,
  unwrapDEK,
  wrapDEK,
} from './crypto';

describe('crypto envelope', () => {
  it('wraps and unwraps a data encryption key', async () => {
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const kek = await deriveKeyFromPassword('correct horse battery staple', salt, 1_000);
    const dek = await generateDEK();
    const original = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', dek));
    const { wrappedDek, iv } = await wrapDEK(dek, kek);

    const unwrapped = await unwrapDEK(wrappedDek, kek, iv);
    const restored = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', unwrapped));

    expect(restored).toEqual(original);
  });

  it('rejects an incorrect sync password', async () => {
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const correctKek = await deriveKeyFromPassword('correct password', salt, 1_000);
    const wrongKek = await deriveKeyFromPassword('wrong password', salt, 1_000);
    const dek = await generateDEK();
    const { wrappedDek, iv } = await wrapDEK(dek, correctKek);

    await expect(unwrapDEK(wrappedDek, wrongKek, iv)).rejects.toThrow();
  });

  it('round-trips binary data through base64', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});
