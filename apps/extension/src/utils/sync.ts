import type {
  Item,
  Group,
  VaultEnvelope,
  PushItem,
  PushGroup,
  Account,
  Relation,
  PushAccount,
  PushRelation,
  RecordCipher
} from '@2fa/api-types';
import { ApiClient } from '@2fa/api-client';
import {
  deriveKeyFromPassword,
  generateDEK,
  wrapDEK,
  unwrapDEK,
  bytesToBase64,
  base64ToBytes,
  decryptRecord,
  encryptRecord
} from './crypto';
import {
  getItems,
  saveItems,
  getGroups,
  saveGroups,
  getAccounts,
  saveAccounts,
  getRelations,
  saveRelations,
  localStore
} from './storage';

interface AccountSecretPayload {
  schema_version: 1;
  password?: string;
  totp_secret?: string;
  full_phone_number?: string;
  proxy?: string;
  proxy_auth?: string;
  private_notes?: string;
  legacy_item_id: string;
}

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

export function mergeAccount(local: Account, remote: Account): Account {
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

export function mergeRelation(local: Relation, remote: Relation): Relation {
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

type AccountKind = 'google' | 'gpt' | 'email' | 'proxy' | 'site';

interface AccountNotes {
  type?: AccountKind;
  password?: string;
  phone?: string;
  proxy?: string;
  bound_google?: string;
  notes?: string;
}

function parseNotes(notesStr?: string): AccountNotes {
  if (!notesStr) return {};
  try {
    const parsed = JSON.parse(notesStr);
    if (parsed && typeof parsed === 'object' && 'vault_v1' in parsed) {
      return parsed.vault_v1 || {};
    }
  } catch {
    return parseLegacyNotes(notesStr);
  }

  return parseLegacyNotes(notesStr);
}

function parseLegacyNotes(notesStr: string): AccountNotes {
  const lines = (notesStr || '').split('\n');
  const info: AccountNotes = { notes: notesStr };

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    const colIdxCn = line.indexOf('：');
    const idx = colonIdx !== -1 ? (colIdxCn !== -1 ? Math.min(colonIdx, colIdxCn) : colonIdx) : colIdxCn;

    if (idx !== -1) {
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      if (key === 'password' || key === '密码') {
        info.password = val;
      } else if (key === 'phone' || key === '手机号' || key === '手机') {
        info.phone = val;
      } else if (key === 'proxy' || key === '代理') {
        info.proxy = val;
      } else if (key === 'bound_google' || key === '绑定谷歌' || key === '关联谷歌' || key === '谷歌') {
        info.bound_google = val;
      }
    }
  }
  return info;
}

function inferType(issuer: string, account: string): AccountKind {
  const name = (issuer + ' ' + account).toLowerCase();
  if (name.includes('google') || name.includes('gmail')) return 'google';
  if (name.includes('gpt') || name.includes('openai') || name.includes('chatgpt')) return 'gpt';
  if (name.includes('mail') || name.includes('@')) return 'email';
  if (name.includes('proxy') || name.includes('代理')) return 'proxy';
  return 'site';
}

function accountKindLabel(type: AccountKind): string {
  switch (type) {
    case 'google':
      return 'Google';
    case 'gpt':
      return 'GPT';
    case 'email':
      return '邮箱';
    case 'proxy':
      return '代理';
    default:
      return '网站';
  }
}

function looksLikeSensitiveIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.includes('@')) return true;
  const digitCount = (trimmed.match(/\d/g) || []).length;
  if (digitCount >= 6) return true;
  if (/^https?:\/\//i.test(trimmed)) return true;
  return false;
}

export function safeAccountProjectionFields(issuer: string, account: string, type: AccountKind) {
  const kindLabel = accountKindLabel(type);
  const platform = issuer && !looksLikeSensitiveIdentifier(issuer) ? issuer : kindLabel;
  const maskedLogin = maskLoginIdentifier(account);
  return {
    platform,
    display_name: maskedLogin ? `${platform} 账号` : platform,
    login_identifier: maskedLogin || null,
    login_identifier_hash: null
  };
}

function maskLoginIdentifier(id: string): string {
  if (!id) return '';
  if (id.includes('@')) {
    const [localPart, domain] = id.split('@');
    if (!localPart || !domain) return id;
    if (localPart.length <= 2) {
      return `*@${domain}`;
    }
    return `${localPart[0]}***${localPart[localPart.length - 1]}@${domain}`;
  }
  if (id.length <= 4) {
    return '***';
  }
  return `${id.slice(0, 2)}***${id.slice(-2)}`;
}

async function runProjection(localItems: Item[], dek: CryptoKey): Promise<void> {
  const localAccounts = await getAccounts();
  const localRelations = await getRelations();

  const accountsToSave: Account[] = [];
  const relationsToSave: Relation[] = [];

  for (const item of localItems) {
    let plaintext = { issuer: '', account: '', secret: '', notes: '' };
    let decryptedSuccessfully = false;

    if (!item.deleted && item.ciphertext) {
      try {
        const ptJson = await decryptRecord(
          item.ciphertext.iv_b64,
          item.ciphertext.ct_b64,
          dek,
          item.id,
          item.ciphertext.aad_b64
        );
        const pt = JSON.parse(ptJson);
        plaintext = {
          issuer: pt.issuer || '',
          account: pt.account || '',
          secret: pt.secret || '',
          notes: pt.notes || ''
        };
        decryptedSuccessfully = true;
      } catch {
        continue;
      }
    } else if (item.deleted) {
      decryptedSuccessfully = true;
    }

    if (!decryptedSuccessfully) {
      continue;
    }

    const info = parseNotes(plaintext.notes);
    const type = info.type || inferType(plaintext.issuer, plaintext.account);

    const has_password = !!info.password;
    const has_totp = !!plaintext.secret;
    const has_phone = !!info.phone;
    const has_proxy = !!info.proxy;
    const has_bound_google = !!info.bound_google;

    const relation_labels: string[] = [];
    if (has_bound_google) relation_labels.push('bound_google');
    if (has_phone) relation_labels.push('phone');
    if (has_proxy) relation_labels.push('proxy');

    const metadata_json = {
      has_password,
      has_totp,
      has_phone,
      has_proxy,
      has_bound_google,
      relation_labels
    };

    const safeFields = safeAccountProjectionFields(plaintext.issuer, plaintext.account, type);

    const existingAccount = localAccounts.find(a => a.id === item.id);
    const projectedAccountDeleted = item.deleted;

    let secret_ciphertext: RecordCipher | null = null;
    const isOldFormat = !!(
      item.ciphertext &&
      existingAccount?.secret_ciphertext &&
      existingAccount.secret_ciphertext.ct_b64 === item.ciphertext.ct_b64
    );

    if (!projectedAccountDeleted && decryptedSuccessfully) {
      if (item.seq === 0 || !existingAccount?.secret_ciphertext || isOldFormat) {
        const payload: AccountSecretPayload = {
          schema_version: 1,
          legacy_item_id: item.id
        };
        if (info.password) payload.password = info.password;
        if (plaintext.secret) payload.totp_secret = plaintext.secret;
        if (info.phone) payload.full_phone_number = info.phone;
        if (info.proxy) {
          payload.proxy = info.proxy;
          payload.proxy_auth = info.proxy;
        }
        if (plaintext.notes) payload.private_notes = plaintext.notes;
        try {
          const ptJson = JSON.stringify(payload);
          secret_ciphertext = await encryptRecord(
            ptJson,
            dek,
            `${item.id}:account-secret`
          );
        } catch (err) {
          console.error('Failed to encrypt account secret', err);
          secret_ciphertext = existingAccount?.secret_ciphertext || null;
        }
      } else {
        secret_ciphertext = existingAccount.secret_ciphertext;
      }
    }

    const proposedAccount: Account = {
      id: item.id,
      rev: existingAccount ? existingAccount.rev : 0,
      seq: (existingAccount && item.seq !== 0 && !isOldFormat) ? existingAccount.seq : 0,
      deleted: projectedAccountDeleted,
      kind: type,
      platform: safeFields.platform,
      display_name: safeFields.display_name,
      login_identifier: safeFields.login_identifier,
      login_identifier_hash: safeFields.login_identifier_hash,
      status: projectedAccountDeleted ? 'deleted' : 'active',
      metadata_json,
      secret_ciphertext,
      updated_at: item.updated_at
    };

    let saveAccount = false;
    if (!existingAccount) {
      proposedAccount.seq = 0;
      saveAccount = true;
    } else if (item.seq === 0 || isOldFormat) {
      proposedAccount.seq = 0;
      saveAccount = true;
    } else {
      const changed =
        existingAccount.deleted !== proposedAccount.deleted ||
        existingAccount.kind !== proposedAccount.kind ||
        existingAccount.platform !== proposedAccount.platform ||
        existingAccount.display_name !== proposedAccount.display_name ||
        existingAccount.login_identifier !== proposedAccount.login_identifier ||
        existingAccount.login_identifier_hash !== proposedAccount.login_identifier_hash ||
        existingAccount.status !== proposedAccount.status ||
        JSON.stringify(existingAccount.metadata_json) !== JSON.stringify(proposedAccount.metadata_json);
      if (changed) {
        proposedAccount.seq = 0;
        saveAccount = true;
      }
    }

    if (saveAccount) {
      accountsToSave.push(proposedAccount);
    }

    const activeRelations: { id: string; kind: string; to_kind: string; to_id: string; metadata_json: Record<string, string> }[] = [];
    if (!item.deleted) {
      if (has_bound_google) {
        activeRelations.push({
          id: item.id + '-bound_google',
          kind: 'bound_google',
          to_kind: 'account',
          to_id: item.id + '-bound-google-target',
          metadata_json: { label: 'bound_google' }
        });
      }
      if (has_phone) {
        activeRelations.push({
          id: item.id + '-phone',
          kind: 'phone',
          to_kind: 'phone',
          to_id: item.id + '-phone-target',
          metadata_json: { label: 'phone' }
        });
      }
      if (has_proxy) {
        activeRelations.push({
          id: item.id + '-proxy',
          kind: 'proxy',
          to_kind: 'proxy',
          to_id: item.id + '-proxy-target',
          metadata_json: { label: 'proxy' }
        });
      }
    }

    for (const rel of activeRelations) {
      const existingRel = localRelations.find(r => r.id === rel.id);
      const proposedRel: Relation = {
        id: rel.id,
        rev: existingRel ? existingRel.rev : 0,
        seq: (existingRel && item.seq !== 0) ? existingRel.seq : 0,
        deleted: false,
        kind: rel.kind,
        from_kind: 'account',
        from_id: item.id,
        to_kind: rel.to_kind,
        to_id: rel.to_id,
        metadata_json: rel.metadata_json,
        secret_ciphertext: null,
        updated_at: item.updated_at
      };

      let saveRel = false;
      if (!existingRel) {
        proposedRel.seq = 0;
        saveRel = true;
      } else if (item.seq === 0) {
        proposedRel.seq = 0;
        saveRel = true;
      } else {
        const changed =
          existingRel.deleted !== proposedRel.deleted ||
          existingRel.kind !== proposedRel.kind ||
          existingRel.to_kind !== proposedRel.to_kind ||
          existingRel.to_id !== proposedRel.to_id ||
          JSON.stringify(existingRel.metadata_json) !== JSON.stringify(proposedRel.metadata_json);
        if (changed) {
          proposedRel.seq = 0;
          saveRel = true;
        }
      }

      if (saveRel) {
        relationsToSave.push(proposedRel);
      }
    }

    const activeRelIds = new Set(activeRelations.map(r => r.id));
    const itemRelations = localRelations.filter(r => r.from_id === item.id);
    for (const existingRel of itemRelations) {
      if (!activeRelIds.has(existingRel.id) && !existingRel.deleted) {
        relationsToSave.push({
          ...existingRel,
          deleted: true,
          seq: 0,
          updated_at: item.updated_at
        });
      }
    }
  }

  if (accountsToSave.length > 0) {
    await saveAccounts(accountsToSave);
  }
  if (relationsToSave.length > 0) {
    await saveRelations(relationsToSave);
  }
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

      const {
        items: remoteItems,
        groups: remoteGroups,
        accounts: remoteAccounts,
        relations: remoteRelations,
        next_seq,
        has_more
      } = pullRes.data;

      const localItems = await getItems();
      const localGroups = await getGroups();
      const localAccounts = await getAccounts();
      const localRelations = await getRelations();

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

      const accountsToSave: Account[] = [];
      for (const rAccount of remoteAccounts || []) {
        const lAccount = localAccounts.find((a) => a.id === rAccount.id);
        if (lAccount) {
          accountsToSave.push(mergeAccount(lAccount, rAccount));
        } else {
          accountsToSave.push(rAccount);
        }
      }
      if (accountsToSave.length > 0) {
        await saveAccounts(accountsToSave);
      }

      const relationsToSave: Relation[] = [];
      for (const rRelation of remoteRelations || []) {
        const lRelation = localRelations.find((r) => r.id === rRelation.id);
        if (lRelation) {
          relationsToSave.push(mergeRelation(lRelation, rRelation));
        } else {
          relationsToSave.push(rRelation);
        }
      }
      if (relationsToSave.length > 0) {
        await saveRelations(relationsToSave);
      }

      lastSyncSeq = next_seq;
      hasMore = has_more;
    }

    await localStore.set({ lastSyncSeq, lastSyncTime: new Date().toISOString() });

    const localItems = await getItems();
    const localGroups = await getGroups();

    await runProjection(localItems, dek);

    const localAccounts = await getAccounts();
    const localRelations = await getRelations();

    const unsyncedItems = localItems.filter((i) => i.seq === 0);
    const unsyncedGroups = localGroups.filter((g) => g.seq === 0);
    const unsyncedAccounts = localAccounts.filter((a) => a.seq === 0);
    const unsyncedRelations = localRelations.filter((r) => r.seq === 0);

    if (
      unsyncedItems.length > 0 ||
      unsyncedGroups.length > 0 ||
      unsyncedAccounts.length > 0 ||
      unsyncedRelations.length > 0
    ) {
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

      const pushAccounts: PushAccount[] = unsyncedAccounts.map((acc) => {
        const pa: PushAccount = {
          id: acc.id,
          deleted: acc.deleted,
          kind: acc.kind,
          platform: acc.platform,
          display_name: acc.display_name,
          login_identifier: acc.login_identifier ?? null,
          login_identifier_hash: acc.login_identifier_hash ?? null,
          status: acc.status,
          expected_rev: acc.rev === 0 ? null : acc.rev
        };
        if (acc.tags_json !== undefined) {
          pa.tags_json = acc.tags_json;
        }
        if (acc.metadata_json !== undefined) {
          pa.metadata_json = acc.metadata_json;
        }
        if (acc.secret_ciphertext !== undefined) {
          pa.secret_ciphertext = acc.secret_ciphertext;
        }
        return pa;
      });

      const pushRelations: PushRelation[] = unsyncedRelations.map((rel) => {
        const pr: PushRelation = {
          id: rel.id,
          deleted: rel.deleted,
          kind: rel.kind,
          from_kind: rel.from_kind,
          from_id: rel.from_id,
          to_kind: rel.to_kind,
          to_id: rel.to_id,
          expected_rev: rel.rev === 0 ? null : rel.rev
        };
        if (rel.metadata_json !== undefined) {
          pr.metadata_json = rel.metadata_json;
        }
        if (rel.secret_ciphertext !== undefined) {
          pr.secret_ciphertext = rel.secret_ciphertext;
        }
        return pr;
      });

      const pushRes = await client.sync.push({
        items: pushItems,
        groups: pushGroups,
        accounts: pushAccounts,
        relations: pushRelations
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

      const accountsToUpdate: Account[] = [];
      for (const app of applied.filter((a) => a.kind === 'account')) {
        const account = localAccounts.find((a) => a.id === app.id);
        if (account) {
          accountsToUpdate.push({
            ...account,
            rev: app.rev,
            seq: app.seq
          });
        }
      }
      if (accountsToUpdate.length > 0) {
        await saveAccounts(accountsToUpdate);
      }

      const relationsToUpdate: Relation[] = [];
      for (const app of applied.filter((a) => a.kind === 'relation')) {
        const relation = localRelations.find((r) => r.id === app.id);
        if (relation) {
          relationsToUpdate.push({
            ...relation,
            rev: app.rev,
            seq: app.seq
          });
        }
      }
      if (relationsToUpdate.length > 0) {
        await saveRelations(relationsToUpdate);
      }

      if (conflicts.length > 0) {
        const resolvedItems: Item[] = [];
        const resolvedGroups: Group[] = [];
        const resolvedAccounts: Account[] = [];
        const resolvedRelations: Relation[] = [];

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
          } else if (conf.kind === 'account' && conf.current_account) {
            const lAccount = localAccounts.find((a) => a.id === conf.id);
            if (lAccount) {
              const merged = mergeAccount(lAccount, conf.current_account);
              resolvedAccounts.push({
                ...merged,
                seq: 0
              });
            }
          } else if (conf.kind === 'relation' && conf.current_relation) {
            const lRelation = localRelations.find((r) => r.id === conf.id);
            if (lRelation) {
              const merged = mergeRelation(lRelation, conf.current_relation);
              resolvedRelations.push({
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
        if (resolvedAccounts.length > 0) {
          await saveAccounts(resolvedAccounts);
        }
        if (resolvedRelations.length > 0) {
          await saveRelations(resolvedRelations);
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
