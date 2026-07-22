import { describe, expect, it } from 'vitest';
import { classifySyncError, type SyncErrorResponse } from './sync';
import {
  expireRemoteCredentials,
  restoreRemoteCredentials,
  buildRemoteReLoginRequest,
  isRemoteConfig,
  type RemoteConfig
} from './sync-config';
import { loadRemoteConfig, saveRemoteConfig, isStoredRemoteConfig, type StoredRemoteConfig } from './remote-config-storage';
import { localStore } from './storage';

import { getOrCreateWrappingKey } from './crypto';
import * as cryptoUtils from './crypto';
import { vi, beforeAll } from 'vitest';

describe('wrapping key test', () => {
  let mockKey: CryptoKey | null = null;

  beforeAll(() => {
    vi.spyOn(cryptoUtils, 'getOrCreateWrappingKey').mockImplementation(async () => {
      if (!mockKey) {
        mockKey = await globalThis.crypto.subtle.generateKey(
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt']
        );
      }
      return mockKey;
    });
  });

  it('loads wrapping key', async () => {
    const key = await getOrCreateWrappingKey();
    expect(key).toBeDefined();
  });
});

describe('classifySyncError', () => {
  it('classifies auth.session_expired as auth_expired', () => {
    const errorResponse: SyncErrorResponse = {
      status: 401,
      error: { code: 'auth.session_expired', message: 'Session expired' }
    };
    expect(classifySyncError(errorResponse)).toBe('auth_expired');
  });

  it('classifies auth.session_invalid as auth_expired', () => {
    const errorResponse: SyncErrorResponse = {
      status: 401,
      error: { code: 'auth.session_invalid', message: 'Session invalid' }
    };
    expect(classifySyncError(errorResponse)).toBe('auth_expired');
  });

  it('classifies auth.session_revoked as device_revoked', () => {
    const errorResponse: SyncErrorResponse = {
      status: 401,
      error: { code: 'auth.session_revoked', message: 'Session revoked' }
    };
    expect(classifySyncError(errorResponse)).toBe('device_revoked');
  });

  it('classifies legacy HTTP 401 auth.unauthorized as auth_expired', () => {
    const errorResponse: SyncErrorResponse = {
      status: 401,
      error: { code: 'auth.unauthorized', message: 'Unauthorized' }
    };
    expect(classifySyncError(errorResponse)).toBe('auth_expired');
  });

  it('classifies auth.user_disabled as disabled', () => {
    const errorResponse: SyncErrorResponse = {
      status: 401,
      error: { code: 'auth.user_disabled', message: 'User disabled' }
    };
    expect(classifySyncError(errorResponse)).toBe('disabled');
  });

  it('classifies other error codes as generic error', () => {
    const errorResponse: SyncErrorResponse = {
      status: 500,
      error: { code: 'internal_error', message: 'Server error' }
    };
    expect(classifySyncError(errorResponse)).toBe('error');
  });
});

describe('RemoteConfig helpers', () => {
  const originalConfig: RemoteConfig = {
    baseUrl: 'https://sync.example.com',
    username: 'testuser',
    token: 'secret-token-123',
    deviceId: 'device-id-xyz',
    deviceLabel: 'My Device'
  };

  it('isRemoteConfig validates legacy and extended config correctly', () => {
    expect(isRemoteConfig(originalConfig)).toBe(true);

    const configWithReason: RemoteConfig = {
      ...originalConfig,
      reauthReason: 'expired'
    };
    expect(isRemoteConfig(configWithReason)).toBe(true);

    const configWithSynced: RemoteConfig = {
      ...originalConfig,
      syncStatus: 'synced'
    };
    expect(isRemoteConfig(configWithSynced)).toBe(true);

    const configWithPending: RemoteConfig = {
      ...originalConfig,
      syncStatus: 'pending'
    };
    expect(isRemoteConfig(configWithPending)).toBe(true);

    const configWithFailed: RemoteConfig = {
      ...originalConfig,
      syncStatus: 'failed'
    };
    expect(isRemoteConfig(configWithFailed)).toBe(true);

    const configWithInvalidStatus = {
      ...originalConfig,
      syncStatus: 'invalid-status'
    };
    expect(isRemoteConfig(configWithInvalidStatus)).toBe(false);

    const invalidConfig = {
      baseUrl: 'https://sync.example.com',
      username: 'testuser'
    };
    expect(isRemoteConfig(invalidConfig)).toBe(false);
  });

  it('expireRemoteCredentials clears token and sets reauthReason', () => {
    const configWithStatus: RemoteConfig = {
      ...originalConfig,
      syncStatus: 'synced'
    };
    const expiredConfig = expireRemoteCredentials(configWithStatus, 'expired');
    expect(expiredConfig.token).toBe('');
    expect(expiredConfig.reauthReason).toBe('expired');
    expect(expiredConfig.syncStatus).toBe('failed');
    expect(expiredConfig.baseUrl).toBe(originalConfig.baseUrl);
    expect(expiredConfig.username).toBe(originalConfig.username);
    expect(expiredConfig.deviceId).toBe(originalConfig.deviceId);
    expect(expiredConfig.deviceLabel).toBe(originalConfig.deviceLabel);

    const revokedConfig = expireRemoteCredentials(originalConfig, 'device_revoked');
    expect(revokedConfig.token).toBe('');
    expect(revokedConfig.reauthReason).toBe('device_revoked');
    expect(revokedConfig.syncStatus).toBe('failed');
  });

  it('restoreRemoteCredentials sets new token and removes reauthReason', () => {
    const expiredConfig = expireRemoteCredentials(originalConfig, 'expired');
    const restoredConfig = restoreRemoteCredentials({ ...expiredConfig, syncStatus: 'failed' }, 'new-secret-token');

    expect(restoredConfig.token).toBe('new-secret-token');
    expect(restoredConfig.reauthReason).toBeUndefined();
    expect(restoredConfig.syncStatus).toBe('failed');
    expect(restoredConfig.baseUrl).toBe(originalConfig.baseUrl);
    expect(restoredConfig.username).toBe(originalConfig.username);
    expect(restoredConfig.deviceId).toBe(originalConfig.deviceId);
    expect(restoredConfig.deviceLabel).toBe(originalConfig.deviceLabel);
  });

  it('buildRemoteReLoginRequest correctly constructs LoginRequest with device ID reuse', () => {
    const request = buildRemoteReLoginRequest(originalConfig, 'mypassword123');

    expect(request.username).toBe(originalConfig.username);
    expect(request.password).toBe('mypassword123');
    expect(request.device_id).toBe(originalConfig.deviceId);
  });
});

describe('remote-config-storage encrypted operations', () => {
  const originalConfig: RemoteConfig = {
    baseUrl: 'https://sync.example.com',
    username: 'testuser',
    token: 'secret-token-123',
    deviceId: 'device-id-xyz',
    deviceLabel: 'My Device',
    syncStatus: 'synced',
  };

  beforeAll(() => {
    const store: Record<string, string> = {};
    globalThis.localStorage = {
      getItem: (key: string) => store[key] || null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { for (const k in store) delete store[k]; },
      length: 0,
      key: () => null,
    };
  });

  it('saveRemoteConfig stores encrypted token and never stores plaintext', async () => {
    await saveRemoteConfig(originalConfig);
    const raw = await localStore.get(['remoteConfig']);
    const config = raw.remoteConfig;
    expect(config).toBeDefined();
    if (isStoredRemoteConfig(config)) {
      expect(config.tokenCiphertext).toBeDefined();
      expect(config.tokenIv).toBeDefined();
      expect('token' in config).toBe(false);
    } else {
      throw new Error('Stored config is not a StoredRemoteConfig');
    }
  });

  it('loadRemoteConfig loads and decrypts config successfully', async () => {
    await saveRemoteConfig(originalConfig);
    const loaded = await loadRemoteConfig();
    expect(loaded).not.toBeNull();
    if (loaded) {
      expect(loaded.token).toBe('secret-token-123');
      expect(loaded.baseUrl).toBe(originalConfig.baseUrl);
      expect(loaded.username).toBe(originalConfig.username);
      expect(loaded.deviceId).toBe(originalConfig.deviceId);
    }
  });

  it('loadRemoteConfig migrates legacy plaintext config automatically', async () => {
    const legacy = {
      baseUrl: 'https://legacy.example.com',
      username: 'legacyuser',
      token: 'legacy-token-abc',
      deviceId: 'legacy-id-123',
      deviceLabel: 'Legacy Device',
      syncStatus: 'synced' as const,
    };
    await localStore.set({ remoteConfig: legacy });

    const loaded = await loadRemoteConfig();
    expect(loaded).not.toBeNull();
    if (loaded) {
      expect(loaded.token).toBe('legacy-token-abc');
    }

    const raw = await localStore.get(['remoteConfig']);
    const config = raw.remoteConfig;
    if (isStoredRemoteConfig(config)) {
      expect(config.tokenCiphertext).toBeDefined();
      expect('token' in config).toBe(false);
    } else {
      throw new Error('Migrated config is not a StoredRemoteConfig');
    }
  });

  it('loadRemoteConfig fails closed when decryption fails', async () => {
    await saveRemoteConfig(originalConfig);
    const raw = await localStore.get(['remoteConfig']);
    const config = raw.remoteConfig;
    if (isStoredRemoteConfig(config)) {
      const corrupted: StoredRemoteConfig = {
        ...config,
        tokenCiphertext: 'corrupted_ciphertext_base64',
      };
      await localStore.set({ remoteConfig: corrupted });
    } else {
      throw new Error('Config is not a StoredRemoteConfig');
    }

    const loaded = await loadRemoteConfig();
    expect(loaded).not.toBeNull();
    if (loaded) {
      expect(loaded.token).toBe('');
      expect(loaded.syncStatus).toBe('failed');
    }
  });
});
