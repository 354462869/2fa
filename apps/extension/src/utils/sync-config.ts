import type { LoginRequest } from '@2fa/api-types';

export interface RemoteConfig {
  readonly baseUrl: string;
  readonly username: string;
  readonly token: string;
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly reauthReason?: 'expired' | 'device_revoked';
  readonly syncStatus?: 'synced' | 'pending' | 'failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isRemoteConfig(value: unknown): value is RemoteConfig {
  return isRecord(value)
    && typeof value.baseUrl === 'string'
    && typeof value.username === 'string'
    && typeof value.token === 'string'
    && typeof value.deviceId === 'string'
    && typeof value.deviceLabel === 'string'
    && (value.reauthReason === undefined || value.reauthReason === 'expired' || value.reauthReason === 'device_revoked')
    && (value.syncStatus === undefined || value.syncStatus === 'synced' || value.syncStatus === 'pending' || value.syncStatus === 'failed');
}

export function expireRemoteCredentials(config: RemoteConfig, reason: 'expired' | 'device_revoked'): RemoteConfig {
  return {
    ...config,
    token: '',
    reauthReason: reason,
    syncStatus: 'failed'
  };
}

export function restoreRemoteCredentials(config: RemoteConfig, token: string): RemoteConfig {
  const { reauthReason, ...rest } = config;
  return {
    ...rest,
    token
  };
}

export function buildRemoteReLoginRequest(config: RemoteConfig, password: string): LoginRequest {
  return {
    username: config.username,
    password,
    device_id: config.deviceId
  };
}
