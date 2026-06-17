import type { Item, Group, VaultEnvelope, PushItem, PushGroup } from '@2fa/api-types';
import { ApiClient } from '@2fa/api-client';
import {
  deriveKeyFromPassword,
  generateDEK,
  wrapDEK,
  unwrapDEK,
  bytesToBase64,
  base64ToBytes
} from './crypto';
import {
  getItems,
  saveItems,
  getGroups,
  saveGroups,
  localStore
} from './storage';

export function mergeItem(local: Item, remote: Item): Item {
  const localTime = new Date(local.updated_at).getTime();
  const remoteTime = new Date(remote.updated_at).getTime();

  if (remote.deleted) {
    if (local.deleted || remoteTime >= localTime) {
      return remote;
    } else {
      return {
        ...local,
        rev: remote.rev,
        seq: remote.seq
      };
    }
  }

  if (local.deleted) {
    if (localTime >= remoteTime) {
      return local;
    } else {
      return remote;
    }
  }

  if (remoteTime >= localTime) {
    return remote;
  }

  return {
    ...local,
    rev: remote.rev,
    seq: remote.seq
  };
}

export function mergeGroup(local: Group, remote: Group): Group {
  const localTime = new Date(local.updated_at).getTime();
  const remoteTime = new Date(remote.updated_at).getTime();

  if (remote.deleted) {
    if (local.deleted || remoteTime >= localTime) {
      return remote;
    } else {
      return {
        ...local,
        rev: remote.rev,
        seq: remote.seq
      };
    }
  }

  if (local.deleted) {
    if (localTime >= remoteTime) {
      return local;
    } else {
      return remote;
    }
  }

  if (remoteTime >= localTime) {
    return remote;
  }

  return {
    ...local,
    rev: remote.rev,
    seq: remote.seq
  };
}

function getErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export async function runSync(
  client: ApiClient,
  syncPassword: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const vaultRes = await client.sync.vault();
    if (!vaultRes.ok) {
      return { success: false, error: vaultRes.error.message };
    }

    const remoteVault = vaultRes.data;
    const storeData = await localStore.get([
      'lastSyncSeq',
      'vaultEnvelope'
    ]);

    let lastSyncSeq = typeof storeData.lastSyncSeq === 'number' ? storeData.lastSyncSeq : 0;
    let localEnvelope = storeData.vaultEnvelope as VaultEnvelope | null;
    let dek: CryptoKey | null = null;

    if (remoteVault.envelope) {
      const salt = base64ToBytes(remoteVault.envelope.kdf_salt_b64);
      const kek = await deriveKeyFromPassword(syncPassword, salt);
      try {
        dek = await unwrapDEK(
          base64ToBytes(remoteVault.envelope.wrapped_dek_b64),
          kek,
          base64ToBytes(remoteVault.envelope.wrap_iv_b64)
        );
      } catch {
        return { success: false, error: 'decryption.wrong_sync_password' };
      }
      localEnvelope = remoteVault.envelope;
      await localStore.set({ vaultEnvelope: localEnvelope });
    } else {
      if (localEnvelope) {
        const salt = base64ToBytes(localEnvelope.kdf_salt_b64);
        const kek = await deriveKeyFromPassword(syncPassword, salt);
        dek = await unwrapDEK(
          base64ToBytes(localEnvelope.wrapped_dek_b64),
          kek,
          base64ToBytes(localEnvelope.wrap_iv_b64)
        );
        const uploadRes = await client.sync.putEnvelope({
          envelope: localEnvelope,
          expected_rev: null
        });
        if (!uploadRes.ok && uploadRes.status !== 409) {
          return { success: false, error: uploadRes.error.message };
        }
      } else {
        const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
        const kek = await deriveKeyFromPassword(syncPassword, salt);
        dek = await generateDEK();
        const { wrappedDek, iv } = await wrapDEK(dek, kek);
        localEnvelope = {
          alg: 'A256GCM',
          kdf: 'pbkdf2',
          kdf_params: { iterations: 100000, hash: 'SHA-256' },
          kdf_salt_b64: bytesToBase64(salt),
          wrapped_dek_b64: bytesToBase64(wrappedDek),
          wrap_iv_b64: bytesToBase64(iv)
        };
        const uploadRes = await client.sync.putEnvelope({
          envelope: localEnvelope,
          expected_rev: null
        });
        if (!uploadRes.ok) {
          return { success: false, error: uploadRes.error.message };
        }
        await localStore.set({ vaultEnvelope: localEnvelope });
      }
    }

    if (!dek) {
      return { success: false, error: 'Cryptographic initialization failed' };
    }

    let hasMore = true;
    while (hasMore) {
      const pullRes = await client.sync.pull({
        since_seq: lastSyncSeq,
        limit: 100
      });
      if (!pullRes.ok) {
        return { success: false, error: pullRes.error.message };
      }

      const { items: remoteItems, groups: remoteGroups, next_seq, has_more } = pullRes.data;
      const localItems = await getItems();
      const localGroups = await getGroups();

      const itemsToSave: Item[] = [];
      for (const rItem of remoteItems) {
        const lItem = localItems.find((i) => i.id === rItem.id);
        if (lItem) {
          itemsToSave.push(mergeItem(lItem, rItem));
        } else {
          itemsToSave.push(rItem);
        }
      }
      if (itemsToSave.length > 0) {
        await saveItems(itemsToSave);
      }

      const groupsToSave: Group[] = [];
      for (const rGroup of remoteGroups) {
        const lGroup = localGroups.find((g) => g.id === rGroup.id);
        if (lGroup) {
          groupsToSave.push(mergeGroup(lGroup, rGroup));
        } else {
          groupsToSave.push(rGroup);
        }
      }
      if (groupsToSave.length > 0) {
        await saveGroups(groupsToSave);
      }

      lastSyncSeq = next_seq;
      hasMore = has_more;
    }

    await localStore.set({ lastSyncSeq, lastSyncTime: new Date().toISOString() });

    const localItems = await getItems();
    const localGroups = await getGroups();
    const unsyncedItems = localItems.filter((i) => i.seq === 0);
    const unsyncedGroups = localGroups.filter((g) => g.seq === 0);

    if (unsyncedItems.length > 0 || unsyncedGroups.length > 0) {
      const pushItems: PushItem[] = unsyncedItems.map((item) => {
        const pi: PushItem = {
          id: item.id,
          deleted: item.deleted,
          expected_rev: item.rev === 0 ? null : item.rev
        };
        if (item.group_id !== undefined) {
          pi.group_id = item.group_id;
        }
        if (item.ciphertext !== undefined) {
          pi.ciphertext = item.ciphertext;
        }
        return pi;
      });

      const pushGroups: PushGroup[] = unsyncedGroups.map((group) => {
        const pg: PushGroup = {
          id: group.id,
          deleted: group.deleted,
          sort_index: group.sort_index,
          expected_rev: group.rev === 0 ? null : group.rev
        };
        if (group.ciphertext !== undefined) {
          pg.ciphertext = group.ciphertext;
        }
        return pg;
      });

      const pushRes = await client.sync.push({
        items: pushItems,
        groups: pushGroups
      });

      if (!pushRes.ok) {
        return { success: false, error: pushRes.error.message };
      }

      const { applied, conflicts, next_seq } = pushRes.data;

      const itemsToUpdate: Item[] = [];
      for (const app of applied.filter((a) => a.kind === 'item')) {
        const item = localItems.find((i) => i.id === app.id);
        if (item) {
          itemsToUpdate.push({
            ...item,
            rev: app.rev,
            seq: app.seq
          });
        }
      }
      if (itemsToUpdate.length > 0) {
        await saveItems(itemsToUpdate);
      }

      const groupsToUpdate: Group[] = [];
      for (const app of applied.filter((a) => a.kind === 'group')) {
        const group = localGroups.find((g) => g.id === app.id);
        if (group) {
          groupsToUpdate.push({
            ...group,
            rev: app.rev,
            seq: app.seq
          });
        }
      }
      if (groupsToUpdate.length > 0) {
        await saveGroups(groupsToUpdate);
      }

      if (conflicts.length > 0) {
        const resolvedItems: Item[] = [];
        const resolvedGroups: Group[] = [];

        for (const conf of conflicts) {
          if (conf.kind === 'item' && conf.current_item) {
            const lItem = localItems.find((i) => i.id === conf.id);
            if (lItem) {
              const merged = mergeItem(lItem, conf.current_item);
              resolvedItems.push({
                ...merged,
                seq: 0
              });
            }
          } else if (conf.kind === 'group' && conf.current_group) {
            const lGroup = localGroups.find((g) => g.id === conf.id);
            if (lGroup) {
              const merged = mergeGroup(lGroup, conf.current_group);
              resolvedGroups.push({
                ...merged,
                seq: 0
              });
            }
          }
        }

        if (resolvedItems.length > 0) {
          await saveItems(resolvedItems);
        }
        if (resolvedGroups.length > 0) {
          await saveGroups(resolvedGroups);
        }
      }

      await localStore.set({
        lastSyncSeq: next_seq,
        lastSyncTime: new Date().toISOString()
      });
    }

    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: getErrorMessage(err, 'Sync failed') };
  }
}
