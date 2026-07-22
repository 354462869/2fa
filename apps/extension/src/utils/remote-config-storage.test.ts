import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as cryptoUtils from './crypto';
import { isStoredRemoteConfig, saveRemoteConfig } from './remote-config-storage';
import type { RemoteConfig } from './sync-config';

describe('remote config Chrome storage adapter', () => {
  const originalChromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  let wrappingKey: CryptoKey | null = null;

  beforeAll(() => {
    vi.spyOn(cryptoUtils, 'getOrCreateWrappingKey').mockImplementation(async () => {
      if (wrappingKey) return wrappingKey;
      wrappingKey = await globalThis.crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt'],
      );
      return wrappingKey;
    });
  });

  afterEach(() => {
    if (originalChromeDescriptor) {
      Object.defineProperty(globalThis, 'chrome', originalChromeDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'chrome');
    }
  });

  it('stores an encrypted token through chrome.storage.local', async () => {
    const values = new Map<string, unknown>();
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        storage: {
          local: {
            get: async (keys: string[]) => Object.fromEntries(
              keys.map((key) => [key, values.get(key)]),
            ),
            set: async (items: Record<string, unknown>) => {
              for (const [key, value] of Object.entries(items)) values.set(key, value);
            },
            remove: async (keys: string[]) => {
              for (const key of keys) values.delete(key);
            },
            clear: async () => values.clear(),
          },
        },
      },
    });

    const config: RemoteConfig = {
      baseUrl: 'https://sync.example.com',
      username: 'release-user',
      token: 'release-secret-token',
      deviceId: 'release-device',
      deviceLabel: 'Release Chrome',
      syncStatus: 'synced',
    };
    await saveRemoteConfig(config);

    const stored = values.get('remoteConfig');
    expect(isStoredRemoteConfig(stored)).toBe(true);
    if (!isStoredRemoteConfig(stored)) throw new Error('Stored config is invalid');
    expect(stored.tokenCiphertext).toBeDefined();
    expect(stored.tokenIv).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(config.token);
  });
});
