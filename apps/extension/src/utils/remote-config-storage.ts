import { localStore } from './storage';
import { getOrCreateWrappingKey, wrapSyncPassword, unwrapSyncPassword } from './crypto';
import { type RemoteConfig, isRemoteConfig } from './sync-config';

export interface StoredRemoteConfig {
  readonly baseUrl: string;
  readonly username: string;
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly reauthReason?: 'expired' | 'device_revoked';
  readonly syncStatus?: 'synced' | 'pending' | 'failed';
  readonly tokenCiphertext?: string;
  readonly tokenIv?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isStoredRemoteConfig(value: unknown): value is StoredRemoteConfig {
  return isRecord(value)
    && typeof value.baseUrl === 'string'
    && typeof value.username === 'string'
    && typeof value.deviceId === 'string'
    && typeof value.deviceLabel === 'string'
    && (value.reauthReason === undefined || value.reauthReason === 'expired' || value.reauthReason === 'device_revoked')
    && (value.syncStatus === undefined || value.syncStatus === 'synced' || value.syncStatus === 'pending' || value.syncStatus === 'failed')
    && (
      (value.tokenCiphertext === undefined && value.tokenIv === undefined) ||
      (typeof value.tokenCiphertext === 'string' && typeof value.tokenIv === 'string')
    );
}

export async function saveRemoteConfig(config: RemoteConfig): Promise<void> {
  let tokenCiphertext: string | undefined;
  let tokenIv: string | undefined;

  if (config.token) {
    const wrappingKey = await getOrCreateWrappingKey();
    const wrapped = await wrapSyncPassword(config.token, wrappingKey);
    tokenCiphertext = wrapped.ct_b64;
    tokenIv = wrapped.iv_b64;
  }

  const stored: StoredRemoteConfig = {
    baseUrl: config.baseUrl,
    username: config.username,
    deviceId: config.deviceId,
    deviceLabel: config.deviceLabel,
    ...(config.reauthReason ? { reauthReason: config.reauthReason } : {}),
    ...(config.syncStatus ? { syncStatus: config.syncStatus } : {}),
    ...(tokenCiphertext ? { tokenCiphertext } : {}),
    ...(tokenIv ? { tokenIv } : {}),
  };

  await localStore.set({ remoteConfig: stored });
}

export async function loadRemoteConfig(): Promise<RemoteConfig | null> {
  const store = await localStore.get(['remoteConfig']);
  if (!store.remoteConfig) {
    return null;
  }

  const raw = store.remoteConfig;

  if (isRemoteConfig(raw)) {
    await saveRemoteConfig(raw);
    return raw;
  }

  if (!isStoredRemoteConfig(raw)) {
    return null;
  }

  const stored = raw;
  let decryptedToken = '';

  if (stored.tokenCiphertext && stored.tokenIv) {
    try {
      const wrappingKey = await getOrCreateWrappingKey();
      decryptedToken = await unwrapSyncPassword(stored.tokenCiphertext, stored.tokenIv, wrappingKey);
    } catch (err) {
      if (err instanceof Error) {
        const failedConfig: RemoteConfig = {
          baseUrl: stored.baseUrl,
          username: stored.username,
          token: '',
          deviceId: stored.deviceId,
          deviceLabel: stored.deviceLabel,
          reauthReason: 'expired',
          syncStatus: 'failed',
        };
        await saveRemoteConfig(failedConfig);
        return failedConfig;
      }
      throw err;
    }
  }

  return {
    baseUrl: stored.baseUrl,
    username: stored.username,
    token: decryptedToken,
    deviceId: stored.deviceId,
    deviceLabel: stored.deviceLabel,
    ...(stored.reauthReason ? { reauthReason: stored.reauthReason } : {}),
    ...(stored.syncStatus ? { syncStatus: stored.syncStatus } : {}),
  };
}

export async function removeRemoteConfig(): Promise<void> {
  await localStore.remove(['remoteConfig']);
}
