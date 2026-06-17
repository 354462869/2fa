import {
  getOrCreateWrappingKey,
  unwrapSyncPassword,
  deriveKeyFromPassword,
  base64ToBytes,
  unwrapDEK,
  wrapSyncPassword
} from './utils/crypto';
import { localStore } from './utils/storage';
import type { VaultEnvelope } from '@2fa/api-types';

interface BackgroundState {
  isUnlocked: boolean;
  syncPassword: string | null;
  dek: CryptoKey | null;
  kek: CryptoKey | null;
  lastActive: number;
  autoLockMinutes: number;
}

const state: BackgroundState = {
  isUnlocked: false,
  syncPassword: null,
  dek: null,
  kek: null,
  lastActive: Date.now(),
  autoLockMinutes: 15
};

interface WrappedSyncPassword {
  ct_b64: string;
  iv_b64: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isVaultEnvelope(value: unknown): value is VaultEnvelope {
  return isRecord(value)
    && typeof value.alg === 'string'
    && typeof value.kdf === 'string'
    && typeof value.kdf_salt_b64 === 'string'
    && typeof value.wrapped_dek_b64 === 'string'
    && typeof value.wrap_iv_b64 === 'string';
}

function isWrappedSyncPassword(value: unknown): value is WrappedSyncPassword {
  return isRecord(value)
    && typeof value.ct_b64 === 'string'
    && typeof value.iv_b64 === 'string';
}

async function checkAutoLock() {
  if (!state.isUnlocked) return;
  const elapsed = Date.now() - state.lastActive;
  if (elapsed > state.autoLockMinutes * 60000) {
    await lockVault();
  }
}

async function lockVault(clearSaved = false) {
  state.isUnlocked = false;
  state.syncPassword = null;
  state.dek = null;
  state.kek = null;
  if (clearSaved) {
    await localStore.remove(['wrappedSyncPassword']);
  }
}

async function tryAutoUnlock(): Promise<boolean> {
  if (state.isUnlocked) {
    return true;
  }

  try {
    const settings = await localStore.get([
      'requireSyncPasswordEachSession',
      'wrappedSyncPassword',
      'vaultEnvelope',
      'autoLockMinutes'
    ]);

    if (typeof settings.autoLockMinutes === 'number') {
      state.autoLockMinutes = settings.autoLockMinutes;
    }

    if (settings.requireSyncPasswordEachSession === true) {
      return false;
    }

    const wrapped = settings.wrappedSyncPassword;
    const envelope = settings.vaultEnvelope;

    if (!isWrappedSyncPassword(wrapped) || !isVaultEnvelope(envelope)) {
      return false;
    }

    const wrappingKey = await getOrCreateWrappingKey();
    const syncPassword = await unwrapSyncPassword(
      wrapped.ct_b64,
      wrapped.iv_b64,
      wrappingKey
    );

    const salt = base64ToBytes(envelope.kdf_salt_b64);
    const kek = await deriveKeyFromPassword(syncPassword, salt);
    const dek = await unwrapDEK(
      base64ToBytes(envelope.wrapped_dek_b64),
      kek,
      base64ToBytes(envelope.wrap_iv_b64)
    );

    state.isUnlocked = true;
    state.syncPassword = syncPassword;
    state.kek = kek;
    state.dek = dek;
    state.lastActive = Date.now();

    return true;
  } catch {
    await lockVault(true);
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    await checkAutoLock();

    if (message.type === 'GET_STATE') {
      const unlocked = await tryAutoUnlock();
      sendResponse({
        isUnlocked: unlocked,
        autoLockMinutes: state.autoLockMinutes,
        syncPassword: state.syncPassword
      });
    } else if (message.type === 'UNLOCK') {
      try {
        const { syncPassword, autoLockMinutes, requireSyncPassword } = message.payload;
        state.autoLockMinutes = autoLockMinutes || 15;

        const settings = await localStore.get(['vaultEnvelope']);
        const envelope = settings.vaultEnvelope;
        if (!isVaultEnvelope(envelope)) {
          sendResponse({ success: false, error: 'No vault envelope found' });
          return;
        }

        const salt = base64ToBytes(envelope.kdf_salt_b64);
        const kek = await deriveKeyFromPassword(syncPassword, salt);
        const dek = await unwrapDEK(
          base64ToBytes(envelope.wrapped_dek_b64),
          kek,
          base64ToBytes(envelope.wrap_iv_b64)
        );

        state.isUnlocked = true;
        state.syncPassword = syncPassword;
        state.kek = kek;
        state.dek = dek;
        state.lastActive = Date.now();

        await localStore.set({
          requireSyncPasswordEachSession: requireSyncPassword,
          autoLockMinutes: state.autoLockMinutes
        });

        if (!requireSyncPassword) {
          const wrappingKey = await getOrCreateWrappingKey();
          const wrapped = await wrapSyncPassword(syncPassword, wrappingKey);
          await localStore.set({ wrappedSyncPassword: wrapped });
        } else {
          await localStore.remove(['wrappedSyncPassword']);
        }

        sendResponse({ success: true });
      } catch {
        sendResponse({ success: false, error: 'decryption.wrong_sync_password' });
      }
    } else if (message.type === 'LOCK') {
      await lockVault(message.payload?.clearSaved);
      sendResponse({ success: true });
    } else if (message.type === 'PING') {
      if (state.isUnlocked) {
        state.lastActive = Date.now();
      }
      sendResponse({ success: true });
    } else {
      sendResponse({ error: 'Unknown message type' });
    }
  })();
  return true;
});

chrome.alarms?.create('autoLockCheck', { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'autoLockCheck') {
    await checkAutoLock();
  }
});

if (typeof chrome !== 'undefined' && chrome.sidePanel) {
  if (typeof chrome.sidePanel.setPanelBehavior === 'function') {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error) => console.error('Error setting panel behavior:', error));
  }
}
