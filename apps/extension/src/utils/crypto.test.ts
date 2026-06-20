import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  deriveKeyFromPassword,
  generateDEK,
  unwrapDEK,
  wrapDEK,
  encryptRecord,
  decryptRecord,
} from './crypto';
import type { Account, Relation } from '@2fa/api-types';
import { mergeAccount, mergeRelation, safeAccountProjectionFields } from './sync';

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

  it('encrypts and decrypts versioned account secret payload with deterministic AAD', async () => {
    const dek = await generateDEK();
    const itemId = 'item-id-123';
    const payload = {
      schema_version: 1,
      password: 'mypassword',
      totp_secret: 'JBSWY3DPEHPK3PXP',
      full_phone_number: '+123456789',
      proxy: 'http://proxy.example.com',
      proxy_auth: 'http://proxy.example.com',
      private_notes: 'Some notes',
      legacy_item_id: itemId,
    };
    const jsonStr = JSON.stringify(payload);
    const encrypted = await encryptRecord(jsonStr, dek, `${itemId}:account-secret`);

    const decryptedJson = await decryptRecord(
      encrypted.iv_b64,
      encrypted.ct_b64,
      dek,
      `${itemId}:account-secret`,
      encrypted.aad_b64
    );
    expect(JSON.parse(decryptedJson)).toEqual(payload);

    await expect(
      decryptRecord(
        encrypted.iv_b64,
        encrypted.ct_b64,
        dek,
        `${itemId}:wrong-aad`
      )
    ).rejects.toThrow();
  });
});

describe('sync merge helpers', () => {
  it('keeps full login identifiers out of server-visible account fields', () => {
    const projected = safeAccountProjectionFields('OpenAI', 'sensitive.user@example.com', 'gpt');

    expect(projected.platform).toBe('OpenAI');
    expect(projected.display_name).toBe('OpenAI 账号');
    expect(projected.login_identifier).toBe('s***r@example.com');
    expect(projected.login_identifier_hash).toBeNull();
    expect(JSON.stringify(projected)).not.toContain('sensitive.user@example.com');
  });

  it('does not treat a sensitive issuer as a visible platform name', () => {
    const projected = safeAccountProjectionFields('+8613800000000', '+8613800000000', 'email');

    expect(projected.platform).toBe('邮箱');
    expect(projected.display_name).toBe('邮箱 账号');
    expect(projected.login_identifier_hash).toBeNull();
    expect(JSON.stringify(projected)).not.toContain('+8613800000000');
  });

  it('merges accounts based on updated_at', () => {
    const local: Account = {
      id: 'acc1',
      rev: 1,
      seq: 1,
      deleted: false,
      kind: 'google',
      platform: 'Google',
      display_name: 'test@gmail.com',
      status: 'active',
      updated_at: '2026-06-20T10:00:00Z',
    };
    const remote: Account = {
      id: 'acc1',
      rev: 2,
      seq: 2,
      deleted: false,
      kind: 'google',
      platform: 'Google',
      display_name: 'test@gmail.com',
      status: 'active',
      updated_at: '2026-06-20T11:00:00Z',
    };

    const merged = mergeAccount(local, remote);
    expect(merged.rev).toBe(2);
    expect(merged.seq).toBe(2);
  });

  it('merges relations correctly', () => {
    const local: Relation = {
      id: 'rel1',
      rev: 1,
      seq: 1,
      deleted: false,
      kind: 'phone',
      from_kind: 'account',
      from_id: 'acc1',
      to_kind: 'phone',
      to_id: 'phone1',
      updated_at: '2026-06-20T10:00:00Z',
    };
    const remote: Relation = {
      id: 'rel1',
      rev: 2,
      seq: 2,
      deleted: true,
      kind: 'phone',
      from_kind: 'account',
      from_id: 'acc1',
      to_kind: 'phone',
      to_id: 'phone1',
      updated_at: '2026-06-20T11:00:00Z',
    };

    const merged = mergeRelation(local, remote);
    expect(merged.deleted).toBe(true);
    expect(merged.rev).toBe(2);
  });
});
