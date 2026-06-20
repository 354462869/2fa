import React, { useState, useEffect, useRef } from 'react';
import jsQR from 'jsqr';
import {
  Lock,
  Settings,
  RefreshCw,
  Plus,
  Search,
  Trash2,
  Edit2,
  Folder,
  Key,
  Globe,
  PlusCircle,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronRight,
  Apple,
  Link
} from 'lucide-react';
import { ApiClient } from '@2fa/api-client';
import type { Item, Group, VaultEnvelope } from '@2fa/api-types';
import {
  deriveKeyFromPassword,
  generateDEK,
  wrapDEK,
  unwrapDEK,
  encryptRecord,
  decryptRecord,
  bytesToBase64,
  base64ToBytes
} from './utils/crypto';
import {
  getItems,
  saveItems,
  getGroups,
  saveGroups,
  deleteItems,
  deleteGroups,
  clearVault,
  localStore
} from './utils/storage';
import { decodeBase32, generateTOTP } from './utils/totp';
import { runSync } from './utils/sync';

interface PlaintextItem {
  id: string;
  group_id: string | null;
  rev: number;
  seq: number;
  deleted: boolean;
  updated_at: string;
  issuer: string;
  account: string;
  secret: string;
  notes?: string;
}

interface AccountNotes {
  type?: 'google' | 'gpt' | 'email' | 'proxy' | 'site';
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

function stringifyNotes(info: AccountNotes): string {
  return JSON.stringify({
    vault_v1: info
  });
}

function inferType(issuer: string, account: string): 'google' | 'gpt' | 'email' | 'proxy' | 'site' {
  const name = (issuer + ' ' + account).toLowerCase();
  if (name.includes('google') || name.includes('gmail')) return 'google';
  if (name.includes('gpt') || name.includes('openai') || name.includes('chatgpt')) return 'gpt';
  if (name.includes('mail') || name.includes('@')) return 'email';
  if (name.includes('proxy') || name.includes('代理')) return 'proxy';
  return 'site';
}

function getAccountType(item: PlaintextItem): 'google' | 'gpt' | 'email' | 'proxy' | 'site' {
  const info = parseNotes(item.notes);
  if (info.type) return info.type;
  return inferType(item.issuer, item.account);
}

function getRelationHint(item: PlaintextItem, info: AccountNotes): string | null {
  if (info.bound_google) {
    return `关联谷歌: ${info.bound_google}`;
  }
  if (info.phone) {
    return `关联手机: ${info.phone}`;
  }
  if (info.proxy) {
    return `使用代理: ${info.proxy}`;
  }
  if ((info.type === 'gpt' || inferType(item.issuer, item.account) === 'gpt') && item.account.toLowerCase().includes('@gmail.com')) {
    return `使用 Google 登录: ${item.account}`;
  }
  return null;
}

function getStatusChips(item: PlaintextItem, info: AccountNotes) {
  const chips: Array<{ text: string; bg: string }> = [];

  const type = info.type || inferType(item.issuer, item.account);
  if (type === 'google') chips.push({ text: 'Google', bg: 'bg-blue-500/15 text-blue-400 border border-blue-500/20' });
  else if (type === 'gpt') chips.push({ text: 'GPT', bg: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20' });
  else if (type === 'email') chips.push({ text: '邮箱', bg: 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/20' });
  else if (type === 'proxy') chips.push({ text: '代理', bg: 'bg-amber-500/15 text-amber-400 border border-amber-500/20' });
  else chips.push({ text: '常规', bg: 'bg-slate-500/15 text-slate-400 border border-slate-500/20' });

  if (item.secret) {
    chips.push({ text: '2FA', bg: 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/20' });
  } else {
    chips.push({ text: '无2FA', bg: 'bg-rose-500/15 text-rose-400 border border-rose-500/20' });
  }

  if (info.password) {
    chips.push({ text: '密码', bg: 'bg-teal-500/15 text-teal-300 border border-teal-500/20' });
  }

  if (info.phone) {
    chips.push({ text: '绑定手机', bg: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/20' });
  }

  if (info.proxy) {
    chips.push({ text: '使用代理', bg: 'bg-amber-500/15 text-amber-300 border border-amber-500/20' });
  }

  return chips;
}

interface PlaintextGroup {
  id: string;
  rev: number;
  seq: number;
  deleted: boolean;
  sort_index: number;
  updated_at: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
}

interface RemoteConfig {
  baseUrl: string;
  username: string;
  token: string;
  deviceId: string;
  deviceLabel: string;
}

function getErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
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

function isRemoteConfig(value: unknown): value is RemoteConfig {
  return isRecord(value)
    && typeof value.baseUrl === 'string'
    && typeof value.username === 'string'
    && typeof value.token === 'string'
    && typeof value.deviceId === 'string'
    && typeof value.deviceLabel === 'string';
}

function isClipboardImageItem(item: DataTransferItem): boolean {
  return item.kind === 'file' && item.type.startsWith('image/');
}

function getPlatformBadge(issuer: string) {
  const name = issuer.toLowerCase().trim();
  const baseClass = "w-6 h-6 rounded-lg flex items-center justify-center text-xs font-bold shrink-0";

  if (name.includes("github")) {
    return (
      <div className={`${baseClass} bg-slate-800 text-white border border-slate-700`}>
        <span className="text-[10px] font-extrabold">GH</span>
      </div>
    );
  }
  if (name.includes("google")) {
    return (
      <div className={`${baseClass} bg-white text-slate-900 border border-slate-200`}>
        <span className="text-[10px] font-black tracking-tighter">
          <span className="text-blue-500">G</span>
          <span className="text-red-500">o</span>
          <span className="text-yellow-500">o</span>
          <span className="text-green-500">g</span>
        </span>
      </div>
    );
  }
  if (name.includes("microsoft") || name.includes("outlook") || name.includes("live")) {
    return (
      <div className={`${baseClass} bg-[#0078d4] text-white`}>
        <span className="text-[10px] font-extrabold">MS</span>
      </div>
    );
  }
  if (name.includes("apple") || name.includes("icloud")) {
    return (
      <div className={`${baseClass} bg-slate-950 text-white border border-slate-800`}>
        <Apple className="w-3.5 h-3.5" />
      </div>
    );
  }
  if (name.includes("aws") || name.includes("amazon")) {
    return (
      <div className={`${baseClass} bg-[#FF9900] text-black`}>
        <span className="text-[9px] font-black">AWS</span>
      </div>
    );
  }
  if (name.includes("facebook") || name.includes("fb")) {
    return (
      <div className={`${baseClass} bg-[#1877F2] text-white`}>
        <span className="text-[10px] font-extrabold">FB</span>
      </div>
    );
  }
  if (name.includes("gitlab")) {
    return (
      <div className={`${baseClass} bg-[#FC6D26]/10 text-[#FC6D26] border border-[#FC6D26]/20`}>
        <span className="text-[10px] font-extrabold">GL</span>
      </div>
    );
  }
  if (name.includes("slack")) {
    return (
      <div className={`${baseClass} bg-[#4A154B] text-white`}>
        <span className="text-[10px] font-extrabold">SL</span>
      </div>
    );
  }
  if (name.includes("discord")) {
    return (
      <div className={`${baseClass} bg-[#5865F2] text-white`}>
        <span className="text-[9px] font-bold">DC</span>
      </div>
    );
  }

  const initial = issuer.charAt(0).toUpperCase() || "?";
  const charCode = initial.charCodeAt(0);
  const gradients = [
    "from-cyan-600 to-blue-600",
    "from-blue-600 to-cyan-600",
    "from-emerald-600 to-teal-600",
    "from-rose-600 to-pink-600",
    "from-amber-600 to-orange-600",
    "from-sky-600 to-cyan-600"
  ];
  const gradient = gradients[charCode % gradients.length];
  return (
    <div className={`${baseClass} bg-gradient-to-tr ${gradient} text-white shadow-sm shadow-cyan-500/10`}>
      {initial}
    </div>
  );
}

export default function App() {
  const [isInitialized, setIsInitialized] = useState(false);
  const [hasEnvelope, setHasEnvelope] = useState(false);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [syncPassword, setSyncPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [items, setItems] = useState<Item[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [decryptedItems, setDecryptedItems] = useState<PlaintextItem[]>([]);
  const [decryptedGroups, setDecryptedGroups] = useState<PlaintextGroup[]>([]);

  const [activeTab, setActiveTab] = useState<'vault' | 'groups' | 'sync' | 'settings'>('vault');
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const [secondsRemaining, setSecondsRemaining] = useState(30);
  const [totpCodes, setTotpCodes] = useState<Record<string, string>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [accountType, setAccountType] = useState<'google' | 'gpt' | 'email' | 'proxy' | 'site'>('site');
  const [password, setPassword] = useState('');
  const [boundPhone, setBoundPhone] = useState('');
  const [boundProxy, setBoundProxy] = useState('');
  const [boundGoogle, setBoundGoogle] = useState('');
  const [filterChip, setFilterChip] = useState('全部');

  const [showAddModal, setShowAddModal] = useState(false);
  const [editingItem, setEditingItem] = useState<PlaintextItem | null>(null);
  const [newItemIssuer, setNewItemIssuer] = useState('');
  const [newItemAccount, setNewItemAccount] = useState('');
  const [newItemSecret, setNewItemSecret] = useState('');
  const [newItemGroupId, setNewItemGroupId] = useState<string>('');
  const [newItemNotes, setNewItemNotes] = useState('');

  const [showGroupModal, setShowGroupModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState<PlaintextGroup | null>(null);
  const [newGroupName, setNewGroupName] = useState('');

  const [remoteServer, setRemoteServer] = useState('');
  const [remoteUsername, setRemoteUsername] = useState('');
  const [remotePassword, setRemotePassword] = useState('');
  const [remoteLabel, setRemoteLabel] = useState('我的浏览器');
  const [isSyncing, setIsSyncing] = useState(false);
  const [remoteConfig, setRemoteConfig] = useState<RemoteConfig | null>(null);

  const [autoLockMinutes, setAutoLockMinutes] = useState(15);
  const [requireSyncPassword, setRequireSyncPassword] = useState(false);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [showPassword, setShowPassword] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const dekRef = useRef<CryptoKey | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFileName, setSelectedFileName] = useState('');
  const [qrPreviewSrc, setQrPreviewSrc] = useState('');
  const [isScanningTab, setIsScanningTab] = useState(false);
  const syncInFlightRef = useRef(false);

  useEffect(() => {
    checkExtensionState();
  }, []);

  useEffect(() => {
    setErrorMessage(null);
    setSuccessMessage(null);
  }, [activeTab]);

  const pingActivity = () => {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({ type: 'PING' }, () => {});
    }
  };

  useEffect(() => {
    window.addEventListener('click', pingActivity);
    window.addEventListener('keydown', pingActivity);
    return () => {
      window.removeEventListener('click', pingActivity);
      window.removeEventListener('keydown', pingActivity);
    };
  }, []);

  const checkExtensionState = async () => {
    const store = await localStore.get([
      'vaultEnvelope',
      'remoteConfig',
      'autoLockMinutes',
      'requireSyncPasswordEachSession'
    ]);

    setHasEnvelope(isVaultEnvelope(store.vaultEnvelope));
    if (typeof store.autoLockMinutes === 'number') setAutoLockMinutes(store.autoLockMinutes);
    if (store.requireSyncPasswordEachSession) setRequireSyncPassword(!!store.requireSyncPasswordEachSession);
    if (isRemoteConfig(store.remoteConfig)) setRemoteConfig(store.remoteConfig);

    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({ type: 'GET_STATE' }, async (response) => {
        if (response && response.isUnlocked) {
          await handleUnlocked(response.syncPassword);
        } else {
          setIsInitialized(true);
        }
      });
    } else {
      setIsInitialized(true);
    }
  };

  const handleUnlocked = async (pw: string) => {
    setSyncPassword(pw);
    await reloadDekFromStoredEnvelope(pw);
    setIsUnlocked(true);
    await loadAndDecryptVault();
    setIsInitialized(true);
    const store = await localStore.get(['remoteConfig']);
    if (isRemoteConfig(store.remoteConfig)) {
      await syncVault(store.remoteConfig, pw, false);
    }
  };

  const reloadDekFromStoredEnvelope = async (password: string) => {
    const store = await localStore.get(['vaultEnvelope']);
    if (!isVaultEnvelope(store.vaultEnvelope)) {
      throw new Error('Vault envelope is missing or invalid');
    }
    const envelope = store.vaultEnvelope;
    const salt = base64ToBytes(envelope.kdf_salt_b64);
    const kek = await deriveKeyFromPassword(password, salt);
    const dek = await unwrapDEK(
      base64ToBytes(envelope.wrapped_dek_b64),
      kek,
      base64ToBytes(envelope.wrap_iv_b64)
    );
    dekRef.current = dek;
  };

  const syncVault = async (
    config: RemoteConfig,
    password: string,
    showSuccess = true
  ): Promise<boolean> => {
    if (!password || syncInFlightRef.current) return false;
    syncInFlightRef.current = true;
    setIsSyncing(true);
    setErrorMessage(null);
    if (showSuccess) setSuccessMessage(null);

    const client = new ApiClient({
      baseUrl: config.baseUrl,
      auth: {
        getToken: () => config.token
      }
    });

    const res = await runSync(client, password);
    syncInFlightRef.current = false;
    setIsSyncing(false);

    if (res.success) {
      if (showSuccess) setSuccessMessage('保管库同步成功！');
      await reloadDekFromStoredEnvelope(password);
      await loadAndDecryptVault();
      return true;
    }

    if (res.error === 'decryption.wrong_sync_password') {
      setErrorMessage('同步密码与远程保管库封装不匹配！');
    } else {
      setErrorMessage(res.error || '同步失败');
    }
    return false;
  };

  const syncAfterLocalChange = async () => {
    if (remoteConfig && syncPassword) {
      await syncVault(remoteConfig, syncPassword, false);
    }
  };

  const loadAndDecryptVault = async () => {
    const lItems = await getItems();
    const lGroups = await getGroups();
    setItems(lItems);
    setGroups(lGroups);

    if (dekRef.current) {
      const decItems: PlaintextItem[] = [];
      for (const item of lItems) {
        if (item.deleted || !item.ciphertext) continue;
        try {
          const ptJson = await decryptRecord(
            item.ciphertext.iv_b64,
            item.ciphertext.ct_b64,
            dekRef.current,
            item.id,
            item.ciphertext.aad_b64
          );
          const pt = JSON.parse(ptJson);
          decItems.push({
            id: item.id,
            group_id: item.group_id || null,
            rev: item.rev,
            seq: item.seq,
            deleted: item.deleted,
            updated_at: item.updated_at,
            issuer: pt.issuer || '',
            account: pt.account || '',
            secret: pt.secret || '',
            notes: pt.notes || ''
          });
        } catch {
          continue;
        }
      }

      const decGroups: PlaintextGroup[] = [];
      for (const group of lGroups) {
        if (group.deleted || !group.ciphertext) continue;
        try {
          const ptJson = await decryptRecord(
            group.ciphertext.iv_b64,
            group.ciphertext.ct_b64,
            dekRef.current,
            group.id,
            group.ciphertext.aad_b64
          );
          const pt = JSON.parse(ptJson);
          decGroups.push({
            id: group.id,
            rev: group.rev,
            seq: group.seq,
            deleted: group.deleted,
            sort_index: group.sort_index,
            updated_at: group.updated_at,
            name: pt.name || '',
            description: pt.description || '',
            color: pt.color || '',
            icon: pt.icon || ''
          });
        } catch {
          continue;
        }
      }

      setDecryptedItems(decItems);
      setDecryptedGroups(decGroups);
    }
  };

  useEffect(() => {
    let active = true;
    const tick = async () => {
      const now = Math.floor(Date.now() / 1000);
      const rem = 30 - (now % 30);
      if (!active) return;
      setSecondsRemaining(rem);

      const codes: Record<string, string> = {};
      for (const item of decryptedItems) {
        try {
          if (!item.secret) {
            codes[item.id] = '';
          } else {
            codes[item.id] = await generateTOTP(item.secret, 30, 6, now);
          }
        } catch {
          codes[item.id] = 'Error';
        }
      }
      if (active) {
        setTotpCodes(codes);
      }
    };

    if (isUnlocked && decryptedItems.length > 0) {
      tick();
      const timer = setInterval(tick, 1000);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }
  }, [isUnlocked, decryptedItems]);

  const handleSetupPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    if (syncPassword.length < 6) {
      setErrorMessage('同步密码必须至少包含 6 个字符');
      return;
    }
    if (syncPassword !== confirmPassword) {
      setErrorMessage('密码不匹配');
      return;
    }

    try {
      const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
      const kek = await deriveKeyFromPassword(syncPassword, salt);
      const dek = await generateDEK();
      const { wrappedDek, iv } = await wrapDEK(dek, kek);

      const envelope: VaultEnvelope = {
        alg: 'A256GCM',
        kdf: 'pbkdf2',
        kdf_params: { iterations: 100000, hash: 'SHA-256' },
        kdf_salt_b64: bytesToBase64(salt),
        wrapped_dek_b64: bytesToBase64(wrappedDek),
        wrap_iv_b64: bytesToBase64(iv)
      };

      await localStore.set({
        vaultEnvelope: envelope,
        lastSyncSeq: 0
      });
      setHasEnvelope(true);
      dekRef.current = dek;

      if (typeof chrome !== 'undefined' && chrome.runtime) {
        chrome.runtime.sendMessage({
          type: 'UNLOCK',
          payload: {
            syncPassword,
            autoLockMinutes,
            requireSyncPassword
          }
        }, () => {
          setIsUnlocked(true);
          loadAndDecryptVault();
        });
      } else {
        setIsUnlocked(true);
        loadAndDecryptVault();
      }
    } catch (err: unknown) {
      setErrorMessage(getErrorMessage(err, '设置失败'));
    }
  };

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    if (!syncPassword) return;

    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({
        type: 'UNLOCK',
        payload: {
          syncPassword,
          autoLockMinutes,
          requireSyncPassword
        }
      }, async (response) => {
        if (response && response.success) {
          await handleUnlocked(syncPassword);
        } else {
          setErrorMessage('同步密码无效或解密失败');
        }
      });
    } else {
      try {
        await handleUnlocked(syncPassword);
      } catch {
        setErrorMessage('同步密码无效或解密失败');
      }
    }
  };

  const handleManualLock = async () => {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({ type: 'LOCK', payload: { clearSaved: true } }, () => {
        setIsUnlocked(false);
        setSyncPassword('');
        setConfirmPassword('');
        setDecryptedItems([]);
        setDecryptedGroups([]);
        dekRef.current = null;
      });
    } else {
      setIsUnlocked(false);
      setSyncPassword('');
      setConfirmPassword('');
      setDecryptedItems([]);
      setDecryptedGroups([]);
      dekRef.current = null;
    }
  };

  const handleCopy = (id: string, value: string, type: 'account' | 'password' | 'totp') => {
    navigator.clipboard.writeText(value);
    const key = `${id}:${type}`;
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((current) => current === key ? null : current);
    }, 1500);
  };

  const handleAutofill = (item: PlaintextItem, info: AccountNotes) => {
    setErrorMessage(null);
    setSuccessMessage(null);
    if (typeof chrome === 'undefined' || !chrome.tabs) {
      setErrorMessage('chrome.tabs API 不可用');
      return;
    }
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs[0];
        if (!activeTab || !activeTab.id) {
          setErrorMessage('未找到活动标签页，请确保在网页中操作。');
          return;
        }

        chrome.tabs.sendMessage(
          activeTab.id,
          {
            type: 'FILL_CREDENTIALS',
            payload: {
              username: item.account || '',
              password: info.password || ''
            }
          },
          (response) => {
            if (chrome.runtime.lastError) {
              setErrorMessage('自动填充失败：未能在当前页面加载脚本。请刷新页面后重试。');
              return;
            }
            if (response && response.success) {
              setSuccessMessage('账号密码已成功填充到当前页面！');
              setTimeout(() => setSuccessMessage(null), 3000);
            } else {
              setErrorMessage('未能在当前页面找到匹配的输入框。');
              setTimeout(() => setErrorMessage(null), 3000);
            }
          }
        );
      });
    } catch (err) {
      setErrorMessage(getErrorMessage(err, '自动填充时出错'));
      setTimeout(() => setErrorMessage(null), 3000);
    }
  };

  const closeAddModal = () => {
    setShowAddModal(false);
    setEditingItem(null);
    setNewItemIssuer('');
    setNewItemAccount('');
    setNewItemSecret('');
    setNewItemGroupId('');
    setNewItemNotes('');
    setAccountType('site');
    setPassword('');
    setBoundPhone('');
    setBoundProxy('');
    setBoundGoogle('');
    setQrPreviewSrc('');
    setSelectedFileName('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleEditItemClick = (item: PlaintextItem) => {
    setEditingItem(item);
    setNewItemIssuer(item.issuer);
    setNewItemAccount(item.account);
    setNewItemSecret(item.secret);
    setNewItemGroupId(item.group_id || '');

    const info = parseNotes(item.notes);
    setAccountType(info.type || inferType(item.issuer, item.account));
    setPassword(info.password || '');
    setBoundPhone(info.phone || '');
    setBoundProxy(info.proxy || '');
    setBoundGoogle(info.bound_google || '');
    setNewItemNotes(info.notes || '');

    setSelectedFileName('');
    setQrPreviewSrc('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    setShowAddModal(true);
  };

  const decodeQrFromImageSrc = (src: string, notFoundMessage: string) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setErrorMessage('无法读取二维码图片');
        return;
      }

      ctx.drawImage(img, 0, 0);
      const imgData = ctx.getImageData(0, 0, img.width, img.height);
      const code = jsQR(imgData.data, imgData.width, imgData.height);
      if (code && code.data) {
        if (parseAndPopulateOtp(code.data)) {
          setQrPreviewSrc(src);
          setErrorMessage(null);
        }
      } else {
        setErrorMessage(notFoundMessage);
      }
    };
    img.onerror = () => setErrorMessage('二维码图片读取失败');
    img.src = src;
  };

  const decodeQrFromFile = (file: File, sourceName: string) => {
    setSelectedFileName(sourceName);
    const reader = new FileReader();
    reader.onload = (event) => {
      const src = event.target?.result;
      if (typeof src === 'string') {
        decodeQrFromImageSrc(src, '在图片中找不到有效的二维码');
      }
    };
    reader.onerror = () => setErrorMessage('二维码图片读取失败');
    reader.readAsDataURL(file);
  };

  const handleQrUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    decodeQrFromFile(file, file.name);
  };

  const handleQrPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const imageItem = Array.from(e.clipboardData.items).find(isClipboardImageItem);
    if (!imageItem) return;

    e.preventDefault();
    const file = imageItem.getAsFile();
    if (!file) {
      setErrorMessage('剪贴板中没有可读取的图片');
      return;
    }
    decodeQrFromFile(file, '已粘贴截图');
  };

  const handleScanCurrentTab = () => {
    setErrorMessage(null);
    if (typeof chrome === 'undefined' || !chrome.tabs?.captureVisibleTab || !chrome.windows?.getCurrent) {
      setErrorMessage('当前浏览器不支持标签页截图识别');
      return;
    }

    setIsScanningTab(true);
    chrome.windows.getCurrent((currentWindow) => {
      const windowId = currentWindow.id;
      if (typeof windowId !== 'number') {
        setIsScanningTab(false);
        setErrorMessage('无法确定当前浏览器窗口');
        return;
      }

      chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
        setIsScanningTab(false);
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          setErrorMessage(runtimeError.message || '无法截取当前标签页');
          return;
        }
        if (!dataUrl) {
          setErrorMessage('无法截取当前标签页');
          return;
        }
        setSelectedFileName('当前标签页截图');
        decodeQrFromImageSrc(dataUrl, '当前标签页可见区域中没有找到有效二维码');
      });
    });
  };

  const parseAndPopulateOtp = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'otpauth:' || parsed.host !== 'totp') {
        setErrorMessage('无效的 otpauth 链接');
        return false;
      }
      const pathname = decodeURIComponent(parsed.pathname.slice(1));
      let issuer = '';
      let account = '';
      const colonIdx = pathname.indexOf(':');
      if (colonIdx !== -1) {
        issuer = pathname.slice(0, colonIdx);
        account = pathname.slice(colonIdx + 1);
      } else {
        account = pathname;
      }
      const secret = parsed.searchParams.get('secret') || '';
      const paramIssuer = parsed.searchParams.get('issuer');
      if (paramIssuer) {
        issuer = paramIssuer;
      }
      setNewItemSecret(secret);
      setNewItemIssuer(issuer.trim());
      setNewItemAccount(account.trim());
      setAccountType(inferType(issuer, account));
      setSuccessMessage('已识别二维码并填入账户信息');
      return true;
    } catch {
      setErrorMessage('解析二维码失败');
      return false;
    }
  };

  const handleSaveItem = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    if (!newItemIssuer) {
      setErrorMessage('发行方/平台为必填项');
      return;
    }
    if (!dekRef.current) return;

    try {
      const itemId = editingItem ? editingItem.id : globalThis.crypto.randomUUID();

      let cleanedSecret = '';
      if (newItemSecret) {
        cleanedSecret = newItemSecret.replace(/\s+/g, '').toUpperCase();
        try {
          decodeBase32(cleanedSecret);
        } catch (err) {
          setErrorMessage('2FA 密钥 Base32 格式不正确');
          return;
        }
      }

      const notesObj: AccountNotes = {
        type: accountType,
        password,
        phone: boundPhone,
        proxy: boundProxy,
        bound_google: boundGoogle,
        notes: newItemNotes
      };

      const itemPlaintext = JSON.stringify({
        issuer: newItemIssuer,
        account: newItemAccount,
        secret: cleanedSecret,
        notes: stringifyNotes(notesObj)
      });

      const cipher = await encryptRecord(itemPlaintext, dekRef.current, itemId);

      const updatedItem: Item = {
        id: itemId,
        group_id: newItemGroupId || null,
        rev: editingItem ? editingItem.rev : 0,
        seq: 0,
        deleted: false,
        updated_at: new Date().toISOString(),
        ciphertext: cipher
      };

      await saveItems([updatedItem]);
      await loadAndDecryptVault();
      await syncAfterLocalChange();

      setShowAddModal(false);
      setEditingItem(null);
      setNewItemIssuer('');
      setNewItemAccount('');
      setNewItemSecret('');
      setNewItemGroupId('');
      setNewItemNotes('');
      setAccountType('site');
      setPassword('');
      setBoundPhone('');
      setBoundProxy('');
      setBoundGoogle('');
      setSelectedFileName('');
      setQrPreviewSrc('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err: unknown) {
      setErrorMessage(getErrorMessage(err, '保存失败'));
    }
  };

  const handleDeleteItem = async (id: string) => {
    const item = items.find((i) => i.id === id);
    if (!item) return;

    const syncDelete = remoteConfig
      ? confirm('是否同步删除到线上？选择“取消”将只从本地删除。')
      : false;

    if (!syncDelete && !confirm('仅从本地删除此项目？下次同步可能会从服务端重新下载。')) return;

    if (syncDelete) {
      const deletedItem: Item = {
        ...item,
        seq: 0,
        deleted: true,
        updated_at: new Date().toISOString(),
        ciphertext: null
      };
      await saveItems([deletedItem]);
      await loadAndDecryptVault();
      await syncAfterLocalChange();
      return;
    }

    await deleteItems([id]);
    await loadAndDecryptVault();
  };

  const handleSaveGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    if (!newGroupName.trim() || !dekRef.current) return;

    try {
      const gId = editingGroup ? editingGroup.id : globalThis.crypto.randomUUID();
      const groupPlaintext = JSON.stringify({
        name: newGroupName,
        description: '',
        color: '',
        icon: ''
      });

      const cipher = await encryptRecord(groupPlaintext, dekRef.current, gId);

      const updatedGroup: Group = {
        id: gId,
        rev: editingGroup ? editingGroup.rev : 0,
        seq: 0,
        deleted: false,
        sort_index: editingGroup ? editingGroup.sort_index : Date.now(),
        updated_at: new Date().toISOString(),
        ciphertext: cipher
      };

      await saveGroups([updatedGroup]);
      await loadAndDecryptVault();
      await syncAfterLocalChange();

      setShowGroupModal(false);
      setEditingGroup(null);
      setNewGroupName('');
    } catch (err: unknown) {
      setErrorMessage(getErrorMessage(err, '保存分组失败'));
    }
  };

  const handleDeleteGroup = async (id: string) => {
    const syncDelete = remoteConfig
      ? confirm('是否同步删除此分组到线上？选择“取消”将只从本地删除分组。')
      : false;
    const groupItems = decryptedItems.filter((i) => i.group_id === id);
    let action: 'move' | 'delete' | 'cancel' = 'move';

    if (groupItems.length > 0) {
      const opt = prompt(
        `该分组包含 ${groupItems.length} 个项目。输入 "move" 将它们设置为未分组，输入 "delete" 删除其中的所有项目，或输入 "cancel" 取消：`
      );
      if (opt === 'delete') {
        action = 'delete';
      } else if (opt === 'move') {
        action = 'move';
      } else {
        return;
      }
    } else {
      if (!confirm('您确定要删除此空分组吗？')) return;
    }

    if (action === 'delete') {
      const itemIds = items.filter((i) => i.group_id === id).map((i) => i.id);
      if (syncDelete) {
        const deletedItems = items
          .filter((i) => i.group_id === id)
          .map((i) => ({
            ...i,
            seq: 0,
            deleted: true,
            updated_at: new Date().toISOString(),
            ciphertext: null
          }));
        await saveItems(deletedItems);
      } else {
        await deleteItems(itemIds);
      }
    } else if (action === 'move') {
      const movedItems = items
        .filter((i) => i.group_id === id)
        .map((i) => ({
          ...i,
          seq: 0,
          group_id: null,
          updated_at: new Date().toISOString()
        }));
      await saveItems(movedItems);
    }

    const group = groups.find((g) => g.id === id);
    if (group) {
      if (syncDelete) {
        const deletedGroup: Group = {
          ...group,
          seq: 0,
          deleted: true,
          updated_at: new Date().toISOString(),
          ciphertext: null
        };
        await saveGroups([deletedGroup]);
      } else {
        await deleteGroups([id]);
      }
    }

    await loadAndDecryptVault();
    if (syncDelete) {
      await syncAfterLocalChange();
    }
    if (selectedGroupId === id) {
      setSelectedGroupId(null);
    }
  };

  const handleRemoteConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsSyncing(true);

    try {
      const cleanUrl = remoteServer.replace(/\/+$/, '');
      const api = new ApiClient({ baseUrl: cleanUrl });

      const deviceId = globalThis.crypto.randomUUID();
      const loginRes = await api.auth_.login({
        username: remoteUsername,
        password: remotePassword
      });

      if (!loginRes.ok) {
        setErrorMessage(loginRes.error.message || '登录失败');
        setIsSyncing(false);
        return;
      }

      const session = loginRes.data;
      const authenticatedApi = new ApiClient({
        baseUrl: cleanUrl,
        auth: { getToken: () => session.token }
      });
      const deviceRegister = await authenticatedApi.devices.register({
        id: deviceId,
        label: remoteLabel
      });

      if (!deviceRegister.ok) {
        setErrorMessage(deviceRegister.error.message || '设备注册失败');
        setIsSyncing(false);
        return;
      }

      const config: RemoteConfig = {
        baseUrl: cleanUrl,
        username: remoteUsername,
        token: session.token,
        deviceId,
        deviceLabel: remoteLabel
      };

      await localStore.set({ remoteConfig: config });
      setRemoteConfig(config);
      const synced = await syncVault(config, syncPassword, false);
      setSuccessMessage(synced ? '成功连接并同步保管库！' : '成功连接到远程同步服务器！');

      setRemoteUsername('');
      setRemotePassword('');
    } catch (err: unknown) {
      setErrorMessage(getErrorMessage(err, '连接失败'));
    } finally {
      setIsSyncing(false);
    }
  };

  const handleTriggerSync = async () => {
    if (!remoteConfig || !syncPassword) return;
    await syncVault(remoteConfig, syncPassword);
  };

  const handleDisconnect = async () => {
    if (!confirm('您确定要断开同步连接吗？这不会删除本地的保管库记录。')) return;
    await localStore.remove(['remoteConfig', 'lastSyncSeq', 'lastSyncTime']);
    setRemoteConfig(null);
    setSuccessMessage('已断开远程同步。');
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSuccessMessage(null);
    await localStore.set({
      autoLockMinutes,
      requireSyncPasswordEachSession: requireSyncPassword
    });

    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({
        type: 'UNLOCK',
        payload: {
          syncPassword,
          autoLockMinutes,
          requireSyncPassword
        }
      }, () => {
        setSuccessMessage('设置保存成功！');
      });
    } else {
      setSuccessMessage('设置保存成功！');
    }
  };

  const handleWipeLocal = async () => {
    if (!confirm('警告：这将永久清空本地数据库中的所有项目、分组及同步设置。您确定要执行此操作吗？')) return;
    await clearVault();
    await localStore.clear();
    setHasEnvelope(false);
    setIsUnlocked(false);
    setSyncPassword('');
    setConfirmPassword('');
    setDecryptedItems([]);
    setDecryptedGroups([]);
    setRemoteConfig(null);
    dekRef.current = null;
    alert('本地数据已清空。');
    window.location.reload();
  };

  const filteredItems = decryptedItems.filter((item) => {
    const matchesGroup = selectedGroupId === null || item.group_id === selectedGroupId;

    const info = parseNotes(item.notes);
    const textToSearch = [
      item.issuer,
      item.account,
      info.notes || '',
      info.phone || '',
      info.proxy || '',
      info.bound_google || '',
      info.type || ''
    ].join(' ').toLowerCase();

    const matchesSearch = textToSearch.includes(searchQuery.toLowerCase());

    const type = getAccountType(item);
    const matchesChip = (() => {
      if (filterChip === '全部') return true;
      if (filterChip === 'Google') return type === 'google';
      if (filterChip === 'GPT') return type === 'gpt';
      if (filterChip === '邮箱') return type === 'email';
      if (filterChip === '手机号') {
        return !!info.phone || /\b\d{11}\b/.test(item.account) || (info.notes && info.notes.toLowerCase().includes('手机')) || (info.notes && info.notes.toLowerCase().includes('phone'));
      }
      if (filterChip === '代理') {
        return type === 'proxy' || !!info.proxy || (info.notes && info.notes.toLowerCase().includes('代理')) || (info.notes && info.notes.toLowerCase().includes('proxy'));
      }
      if (filterChip === '2FA') {
        return !!item.secret;
      }
      if (filterChip === '异常') {
        const anomalyInNotes = info.notes && (info.notes.toLowerCase().includes('异常') || info.notes.toLowerCase().includes('error') || info.notes.toLowerCase().includes('警告') || info.notes.toLowerCase().includes('invalid'));
        return !item.secret || !!anomalyInNotes;
      }
      return true;
    })();

    return matchesGroup && matchesSearch && matchesChip;
  });

  if (!isInitialized) {
    return (
      <div className="w-full h-screen min-w-[320px] flex items-center justify-center bg-[#0B0F19] text-slate-100 relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(6,182,212,0.15),transparent_60%)] pointer-events-none" />
        <div className="flex flex-col items-center gap-3 z-10">
          <RefreshCw className="w-8 h-8 text-cyan-500 animate-spin" />
          <p className="text-sm text-slate-400 font-medium">正在初始化保管库...</p>
        </div>
      </div>
    );
  }

  if (!hasEnvelope) {
    return (
      <div className="w-full h-screen min-w-[320px] flex flex-col justify-between bg-[#0B0F19] text-slate-100 overflow-hidden relative p-6">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(6,182,212,0.15),transparent_60%)] pointer-events-none" />
        <div className="overflow-y-auto flex-1 no-scrollbar z-10">
          <div className="flex flex-col items-center text-center mt-6">
            <div className="w-14 h-14 bg-gradient-to-tr from-cyan-600 to-blue-600 rounded-2xl flex items-center justify-center text-white mb-4 shadow-lg shadow-cyan-500/20">
              <Key className="w-7 h-7" />
            </div>
            <h1 className="text-xl font-bold bg-gradient-to-r from-white via-slate-100 to-slate-300 bg-clip-text text-transparent">账号管理器</h1>
            <h2 className="text-xs font-semibold text-cyan-400 mt-1">创建同步密码</h2>
            <p className="text-xs text-slate-400 mt-2 max-w-[280px] leading-relaxed">
              此密码用于在本地以及远程同步前加密您的账号密码与 2FA 数据。
            </p>
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 text-[11px] text-amber-300 text-left mt-4 leading-relaxed max-w-[300px]">
              <strong className="block font-semibold mb-0.5 text-amber-400">⚠️ 至关重要的警告：</strong>
              同步密码绝不会上传到任何服务器。如果您丢失了此密码，您加密的账号与 2FA 数据将无法恢复。
            </div>
          </div>

          <form onSubmit={handleSetupPassword} className="mt-6 space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                同步密码（最少 6 个字符）
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={syncPassword}
                  onChange={(e) => setSyncPassword(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-900/50 border border-slate-800/80 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-2.5 text-slate-500 hover:text-slate-300 focus:outline-none"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                确认密码
              </label>
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-3 py-2 bg-slate-900/50 border border-slate-800/80 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                required
              />
            </div>

            {errorMessage && (
              <div className="text-xs text-rose-400 bg-rose-500/10 p-2.5 rounded-xl border border-rose-500/20 leading-normal">
                {errorMessage}
              </div>
            )}

            <button
              type="submit"
              className="w-full bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-medium text-sm py-2.5 px-4 rounded-xl shadow-lg shadow-cyan-600/20 transition-all focus:ring-2 focus:ring-cyan-500 focus:outline-none"
            >
              初始化保管库
            </button>
          </form>
        </div>
        <div className="px-6 py-4 border-t border-slate-800/60 text-[10px] text-center text-slate-500 z-10">
          基于 AGPL-3.0 自托管安全保管库
        </div>
      </div>
    );
  }

  if (!isUnlocked) {
    return (
      <div className="w-full h-screen min-w-[320px] flex flex-col justify-between bg-[#0B0F19] text-slate-100 overflow-hidden relative p-6">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(6,182,212,0.15),transparent_60%)] pointer-events-none" />
        <div className="overflow-y-auto flex-1 no-scrollbar z-10">
          <div className="flex flex-col items-center text-center mt-12">
            <div className="w-14 h-14 bg-gradient-to-tr from-cyan-600 to-blue-600 rounded-2xl flex items-center justify-center text-white mb-4 shadow-lg shadow-cyan-500/20">
              <Lock className="w-7 h-7" />
            </div>
            <h1 className="text-xl font-bold bg-gradient-to-r from-white via-slate-100 to-slate-300 bg-clip-text text-transparent">账号管理器</h1>
            <h2 className="text-xs font-semibold text-cyan-400 mt-1">保管库已锁定</h2>
            <p className="text-xs text-slate-400 mt-2 max-w-[260px] leading-relaxed">
              请输入您的同步密码以解密您的账号保险库数据。
            </p>
          </div>

          <form onSubmit={handleUnlock} className="mt-8 space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                同步密码
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={syncPassword}
                  onChange={(e) => setSyncPassword(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-900/50 border border-slate-800/80 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  required
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-2.5 text-slate-500 hover:text-slate-300 focus:outline-none"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {errorMessage && (
              <div className="text-xs text-rose-400 bg-rose-500/10 p-2.5 rounded-xl border border-rose-500/20">
                {errorMessage}
              </div>
            )}

            <button
              type="submit"
              className="w-full bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-medium text-sm py-2.5 px-4 rounded-xl shadow-lg shadow-cyan-600/20 transition-all focus:ring-2 focus:ring-cyan-500 focus:outline-none"
            >
              解锁保管库
            </button>
          </form>
        </div>
        <div className="px-6 py-4 border-t border-slate-800/60 flex justify-between items-center text-[10px] text-slate-500 z-10">
          <span>锁定模式</span>
          <button
            onClick={handleWipeLocal}
            className="text-rose-400 hover:underline hover:text-rose-300 focus:outline-none"
          >
            重置保管库
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-screen min-w-[320px] bg-[#0B0F19] text-slate-100 overflow-hidden flex flex-col font-sans select-none relative">
      {/* Radial Glow */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(6,182,212,0.12),transparent_60%)] pointer-events-none" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom_left,rgba(59,130,246,0.08),transparent_50%)] pointer-events-none" />

      <div className="flex-1 flex flex-col min-h-0 z-10">
        {/* Branded Header */}
        <div className="bg-slate-900/40 backdrop-blur-md border-b border-slate-800/60 px-4 py-3 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-gradient-to-tr from-cyan-600 to-blue-600 rounded-lg flex items-center justify-center text-white shadow-sm shadow-cyan-500/25">
              <Lock className="w-3.5 h-3.5" />
            </div>
            <span className="font-extrabold text-sm text-white tracking-tight flex items-center gap-1.5">
              账号管理器
            </span>
            {/* Sync Status Badge */}
            {remoteConfig ? (
              <span className="flex items-center gap-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded-full text-[9px] font-medium">
                <span className="w-1 h-1 bg-emerald-400 rounded-full animate-pulse"></span>
                已同步
              </span>
            ) : (
              <span className="flex items-center gap-1 bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full text-[9px] font-medium border border-slate-700/50">
                本地
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {remoteConfig && (
              <button
                onClick={handleTriggerSync}
                className="p-1.5 text-slate-400 hover:text-cyan-400 hover:bg-slate-800/50 rounded-lg transition-colors focus:outline-none focus:ring-1 focus:ring-cyan-500"
                title="立即同步"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin text-cyan-400' : ''}`} />
              </button>
            )}
            <button
              onClick={() => handleManualLock()}
              className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-slate-800/50 rounded-lg transition-colors focus:outline-none focus:ring-1 focus:ring-cyan-500"
              title="锁定保管库"
            >
              <Lock className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Thin countdown indicator progress bar */}
        <div className="w-full bg-slate-950 h-0.5 shrink-0">
          <div
            className={`h-full transition-all duration-1000 ease-linear ${
              secondsRemaining < 5 ? 'bg-rose-500' : 'bg-cyan-500'
            }`}
            style={{ width: `${(secondsRemaining / 30) * 100}%` }}
          ></div>
        </div>

        {/* Content Pane */}
        <div className="flex-1 overflow-y-auto min-h-0 no-scrollbar">
          {activeTab === 'vault' && (
            <div className="p-3 space-y-3">
              {errorMessage && (
                <div className="text-xs text-rose-400 bg-rose-500/10 p-2.5 rounded-xl border border-rose-500/20 leading-normal">
                  {errorMessage}
                </div>
              )}

              {successMessage && (
                <div className="text-xs text-emerald-400 bg-emerald-500/10 p-2.5 rounded-xl border border-emerald-500/20">
                  {successMessage}
                </div>
              )}

              <div className="flex gap-2">
                <div className="relative flex-1">
                  <span className="absolute inset-y-0 left-0 pl-2.5 flex items-center text-slate-500 pointer-events-none">
                    <Search className="w-3.5 h-3.5" />
                  </span>
                  <input
                    type="text"
                    placeholder="搜索账号、邮箱、平台、标签"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-8 pr-3 py-1.5 bg-slate-900/50 border border-slate-800/80 rounded-xl text-xs text-white focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent placeholder-slate-500 backdrop-blur-md"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setEditingItem(null);
                    setNewItemIssuer('');
                    setNewItemAccount('');
                    setNewItemSecret('');
                    setNewItemGroupId(selectedGroupId || '');
                    setNewItemNotes('');
                    setAccountType('site');
                    setPassword('');
                    setBoundPhone('');
                    setBoundProxy('');
                    setBoundGoogle('');
                    setSelectedFileName('');
                    setQrPreviewSrc('');
                    if (fileInputRef.current) fileInputRef.current.value = '';
                    setShowAddModal(true);
                  }}
                  className="bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white p-1.5 rounded-xl transition-all flex items-center justify-center shadow-lg shadow-cyan-600/25 active:scale-95 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  title="添加账户"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>

              <div className="flex items-center gap-1 overflow-x-auto pb-1 text-[11px] no-scrollbar">
                {['全部', 'Google', 'GPT', '邮箱', '手机号', '代理', '2FA', '异常'].map((chip) => {
                  const isActive = filterChip === chip;
                  return (
                    <button
                      key={chip}
                      type="button"
                      onClick={() => setFilterChip(chip)}
                      className={`px-2.5 py-1 rounded-full whitespace-nowrap transition-colors focus:outline-none ${
                        isActive
                          ? 'bg-gradient-to-r from-cyan-600 to-blue-600 text-white font-medium shadow-sm shadow-cyan-500/20'
                          : 'bg-slate-900/40 text-slate-400 border border-slate-800/60 hover:bg-slate-800/50 hover:text-slate-200'
                      }`}
                    >
                      {chip}
                    </button>
                  );
                })}
              </div>

              {filteredItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-center py-14 px-4 bg-slate-900/30 backdrop-blur-md rounded-2xl border border-slate-800/60 shadow-sm">
                  <div className="w-10 h-10 bg-slate-800/60 rounded-xl flex items-center justify-center text-slate-500 mb-3">
                    <Search className="w-5 h-5" />
                  </div>
                  <p className="text-xs font-semibold text-slate-300">未找到记录</p>
                  <p className="text-[10px] text-slate-500 mt-1.5 max-w-[200px] leading-relaxed">
                    {searchQuery ? '请调整您的搜索词' : '点击加号按钮添加您的第一个身份验证验证码。'}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {(() => {
                    const groupsMap = filteredItems.reduce<Record<string, PlaintextItem[]>>((acc, item) => {
                      const gid = item.group_id || 'ungrouped';
                      if (!acc[gid]) acc[gid] = [];
                      acc[gid].push(item);
                      return acc;
                    }, {});

                    const sortedGroupIds = Object.keys(groupsMap).sort((a, b) => {
                      if (a === 'ungrouped') return 1;
                      if (b === 'ungrouped') return -1;
                      const groupA = decryptedGroups.find((g) => g.id === a);
                      const groupB = decryptedGroups.find((g) => g.id === b);
                      if (groupA && groupB) {
                        return groupA.sort_index - groupB.sort_index;
                      }
                      return 0;
                    });

                    return sortedGroupIds.map((gid) => {
                      const itemsInGroup = groupsMap[gid] || [];
                      const isUngrouped = gid === 'ungrouped';
                      const group = isUngrouped ? null : decryptedGroups.find((g) => g.id === gid);
                      const groupName = group ? group.name : '未分组';
                      const isCollapsed = collapsedGroups[gid] || false;

                      return (
                        <div key={gid} className="space-y-2">
                          <div
                            onClick={() =>
                              setCollapsedGroups((prev) => ({
                                ...prev,
                                [gid]: !prev[gid]
                              }))
                            }
                            className="flex items-center justify-between py-1.5 px-3 bg-slate-900/40 hover:bg-slate-900/60 rounded-xl cursor-pointer transition-all border border-slate-800/40 select-none"
                          >
                            <div className="flex items-center gap-2">
                              <Folder className="w-3.5 h-3.5 text-cyan-400" />
                              <span className="text-xs font-semibold text-slate-300">{groupName}</span>
                              <span className="text-[10px] text-cyan-400 bg-cyan-500/10 px-2 py-0.2 rounded-full font-mono font-medium">
                                {itemsInGroup.length}
                              </span>
                            </div>
                            {isCollapsed ? (
                              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                            ) : (
                              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                            )}
                          </div>

                          {!isCollapsed && (
                            <div className="space-y-2">
                              {itemsInGroup.map((item) => {
                                const code = totpCodes[item.id] || '------';
                                const info = parseNotes(item.notes);
                                const statusChips = getStatusChips(item, info);
                                const relationHint = getRelationHint(item, info);

                                return (
                                  <div
                                    key={item.id}
                                    onClick={() => handleEditItemClick(item)}
                                    className="bg-slate-900/40 backdrop-blur-md border border-slate-800/80 hover:border-cyan-500/40 hover:bg-slate-900/60 rounded-2xl p-3 flex flex-col justify-between cursor-pointer transition-all duration-150 relative active:scale-[0.98] group"
                                  >
                                    <div className="flex items-start justify-between">
                                      <div className="flex items-center gap-2.5 min-w-0 pr-2">
                                        {getPlatformBadge(item.issuer)}
                                        <div className="min-w-0">
                                          <span className="font-semibold text-xs text-slate-200 truncate block">
                                            {item.issuer}
                                          </span>
                                          <span className="text-[10px] text-slate-500 truncate block">
                                            {item.account || '无账号名'}
                                          </span>
                                        </div>
                                      </div>

                                      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                                        <button
                                          type="button"
                                          onClick={() => handleEditItemClick(item)}
                                          className="p-1 text-slate-400 hover:text-cyan-400 hover:bg-slate-800/60 rounded transition-colors focus:outline-none"
                                          title="编辑"
                                        >
                                          <Edit2 className="w-3.5 h-3.5" />
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => handleDeleteItem(item.id)}
                                          className="p-1 text-slate-400 hover:text-rose-400 hover:bg-slate-800/60 rounded transition-colors focus:outline-none"
                                          title="删除"
                                        >
                                          <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                      </div>
                                    </div>

                                    {statusChips.length > 0 && (
                                      <div className="flex flex-wrap gap-1 mt-2">
                                        {statusChips.map((chip, idx) => (
                                          <span key={idx} className={`text-[9px] px-1.5 py-0.2 rounded font-medium ${chip.bg}`}>
                                            {chip.text}
                                          </span>
                                        ))}
                                      </div>
                                    )}

                                    {relationHint && (
                                      <div className="text-[9px] text-cyan-300 mt-1.5 flex items-center gap-1 bg-cyan-950/20 px-2 py-0.5 rounded border border-cyan-950/40">
                                        <Link className="w-2.5 h-2.5 shrink-0" />
                                        <span className="truncate">{relationHint}</span>
                                      </div>
                                    )}

                                    {item.secret && (
                                      <div className="flex items-center justify-between mt-2.5 bg-slate-950/30 p-2 rounded-xl border border-slate-800/50">
                                        <span className={`text-2xl font-bold font-mono tracking-widest transition-all duration-300 ${
                                          secondsRemaining < 5 ? 'text-rose-500 animate-pulse' : 'text-cyan-400'
                                        }`}>
                                          {code.slice(0, 3)} {code.slice(3)}
                                        </span>

                                        <div className="shrink-0 flex items-center justify-center" title={`剩余时间: ${secondsRemaining}秒`}>
                                          <svg height="16" width="16" className="transform -rotate-90">
                                            <circle
                                              stroke="rgba(255, 255, 255, 0.08)"
                                              fill="transparent"
                                              strokeWidth="2"
                                              r="6"
                                              cx="8"
                                              cy="8"
                                            />
                                            <circle
                                              stroke={secondsRemaining < 5 ? '#ef4444' : '#06b6d4'}
                                              fill="transparent"
                                              strokeWidth="2"
                                              strokeDasharray={`${2 * Math.PI * 6}`}
                                              style={{ strokeDashoffset: `${2 * Math.PI * 6 * (1 - secondsRemaining / 30)}` }}
                                              strokeLinecap="round"
                                              r="6"
                                              cx="8"
                                              cy="8"
                                              className="transition-all duration-1000 ease-linear"
                                            />
                                          </svg>
                                        </div>
                                      </div>
                                    )}

                                    <div className="flex items-center gap-1.5 mt-3 pt-2 border-t border-slate-800/40" onClick={(e) => e.stopPropagation()}>
                                      {(item.account || info.password) && (
                                        <button
                                          type="button"
                                          onClick={() => handleAutofill(item, info)}
                                          className="flex-1 flex items-center justify-center py-1 rounded text-[10px] font-medium transition-all bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white border border-cyan-600/30 active:scale-95"
                                        >
                                          填充
                                        </button>
                                      )}

                                      <button
                                        type="button"
                                        disabled={!item.account}
                                        onClick={() => handleCopy(item.id, item.account, 'account')}
                                        className={`flex-1 flex items-center justify-center py-1 rounded text-[10px] font-medium transition-all ${
                                          copiedKey === `${item.id}:account`
                                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                            : 'bg-slate-900/60 hover:bg-slate-800/60 text-slate-300 border border-slate-800/60 disabled:opacity-30 disabled:cursor-not-allowed'
                                        }`}
                                      >
                                        {copiedKey === `${item.id}:account` ? '已复制' : '账号'}
                                      </button>

                                      <button
                                        type="button"
                                        disabled={!info.password}
                                        onClick={() => handleCopy(item.id, info.password || '', 'password')}
                                        className={`flex-1 flex items-center justify-center py-1 rounded text-[10px] font-medium transition-all ${
                                          copiedKey === `${item.id}:password`
                                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                            : 'bg-slate-900/60 hover:bg-slate-800/60 text-slate-300 border border-slate-800/60 disabled:opacity-30 disabled:cursor-not-allowed'
                                        }`}
                                      >
                                        {copiedKey === `${item.id}:password` ? '已复制' : '密码'}
                                      </button>

                                      <button
                                        type="button"
                                        disabled={!item.secret || !code || code === 'Error' || code === '------' || code === ''}
                                        onClick={() => handleCopy(item.id, code.replace(/\s+/g, ''), 'totp')}
                                        className={`flex-1 flex items-center justify-center py-1 rounded text-[10px] font-medium transition-all ${
                                          copiedKey === `${item.id}:totp`
                                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                            : 'bg-slate-900/60 hover:bg-slate-800/60 text-slate-300 border border-slate-800/60 disabled:opacity-30 disabled:cursor-not-allowed'
                                        }`}
                                      >
                                        {copiedKey === `${item.id}:totp` ? '已复制' : '2FA'}
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>
          )}

          {activeTab === 'groups' && (
            <div className="p-3 space-y-3">
              <div className="flex justify-between items-center">
                <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  管理分组
                </h2>
                <button
                  type="button"
                  onClick={() => {
                    setEditingGroup(null);
                    setNewGroupName('');
                    setShowGroupModal(true);
                  }}
                  className="text-xs text-cyan-400 hover:text-cyan-300 font-semibold flex items-center gap-1 focus:outline-none"
                >
                  <PlusCircle className="w-3.5 h-3.5" />
                  添加分组
                </button>
              </div>

              {decryptedGroups.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-center py-14 px-4 bg-slate-900/30 backdrop-blur-md rounded-2xl border border-slate-800/60 shadow-sm">
                  <div className="w-10 h-10 bg-slate-800/60 rounded-xl flex items-center justify-center text-slate-500 mb-3">
                    <Folder className="w-5 h-5" />
                  </div>
                  <p className="text-xs font-semibold text-slate-300">未创建分组</p>
                  <p className="text-[10px] text-slate-500 mt-1.5 max-w-[200px] leading-relaxed">
                    创建分组以整理您的身份验证验证码。
                  </p>
                </div>
              ) : (
                <div className="bg-slate-900/30 backdrop-blur-md rounded-2xl border border-slate-800/60 divide-y divide-slate-800/60 overflow-hidden">
                  {decryptedGroups.map((g) => (
                    <div key={g.id} className="p-3 flex justify-between items-center hover:bg-slate-900/20 transition-all">
                      <div className="min-w-0">
                        <span className="font-semibold text-xs text-slate-200 truncate block">
                          {g.name}
                        </span>
                        <span className="text-[10px] text-slate-500 block mt-0.5">
                          {decryptedItems.filter((i) => i.group_id === g.id).length} 个项目
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingGroup(g);
                            setNewGroupName(g.name);
                            setShowGroupModal(true);
                          }}
                          className="p-1 text-slate-400 hover:text-cyan-400 hover:bg-slate-800/60 rounded transition-colors focus:outline-none"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteGroup(g.id)}
                          className="p-1 text-slate-400 hover:text-rose-400 hover:bg-slate-800/60 rounded transition-colors focus:outline-none"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'sync' && (
            <div className="p-3 space-y-4">
              {remoteConfig ? (
                <div className="space-y-3">
                  <div className="bg-slate-900/40 backdrop-blur-md border border-slate-800/80 rounded-2xl p-4 space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                        <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
                        已连接
                      </span>
                      <button
                        onClick={handleDisconnect}
                        className="text-[10px] text-rose-400 hover:underline hover:text-rose-300 focus:outline-none"
                      >
                        断开连接
                      </button>
                    </div>
                    <div className="text-[11px] text-slate-400 space-y-1.5">
                      <div className="flex justify-between">
                        <span>服务器：</span>
                        <span className="font-mono truncate max-w-[180px] text-slate-200">{remoteConfig.baseUrl}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>用户名：</span>
                        <span className="font-mono text-slate-200">{remoteConfig.username}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>设备标签：</span>
                        <span className="text-slate-200">{remoteConfig.deviceLabel}</span>
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={handleTriggerSync}
                    disabled={isSyncing}
                    className="w-full bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 disabled:from-cyan-600/50 disabled:to-blue-600/50 text-white font-medium text-xs py-2.5 px-4 rounded-xl flex items-center justify-center gap-1.5 transition-all shadow-lg shadow-cyan-600/20 focus:ring-2 focus:ring-cyan-500 focus:outline-none"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                    {isSyncing ? '同步中...' : '立即同步保管库'}
                  </button>
                </div>
              ) : (
                <form onSubmit={handleRemoteConnect} className="bg-slate-900/40 backdrop-blur-md border border-slate-800/80 rounded-2xl p-4 space-y-3">
                  <h3 className="text-xs font-semibold text-slate-200">连接到同步服务器</h3>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 mb-1">
                      服务器地址
                    </label>
                    <input
                      type="url"
                      placeholder="http://127.0.0.1:8080"
                      value={remoteServer}
                      onChange={(e) => setRemoteServer(e.target.value)}
                      className="w-full px-3 py-1.5 bg-slate-900/50 border border-slate-800/80 rounded-xl text-xs text-white focus:outline-none focus:ring-2 focus:ring-cyan-500 placeholder-slate-600"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 mb-1">
                      账户用户名
                    </label>
                    <input
                      type="text"
                      value={remoteUsername}
                      onChange={(e) => setRemoteUsername(e.target.value)}
                      className="w-full px-3 py-1.5 bg-slate-900/50 border border-slate-800/80 rounded-xl text-xs text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 mb-1">
                      账户密码
                    </label>
                    <input
                      type="password"
                      value={remotePassword}
                      onChange={(e) => setRemotePassword(e.target.value)}
                      className="w-full px-3 py-1.5 bg-slate-900/50 border border-slate-800/80 rounded-xl text-xs text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 mb-1">
                      设备标签
                    </label>
                    <input
                      type="text"
                      value={remoteLabel}
                      onChange={(e) => setRemoteLabel(e.target.value)}
                      className="w-full px-3 py-1.5 bg-slate-900/50 border border-slate-800/80 rounded-xl text-xs text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                      required
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={isSyncing}
                    className="w-full bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 disabled:from-cyan-600/50 disabled:to-blue-600/50 text-white font-medium text-xs py-2.5 px-4 rounded-xl flex items-center justify-center gap-1.5 transition-all shadow-lg shadow-cyan-600/20 focus:ring-2 focus:ring-cyan-500 focus:outline-none"
                  >
                    {isSyncing ? '正在连接...' : '连接服务器'}
                  </button>
                </form>
              )}

              {errorMessage && (
                <div className="text-xs text-rose-400 bg-rose-500/10 p-2.5 rounded-xl border border-rose-500/20">
                  {errorMessage}
                </div>
              )}

              {successMessage && (
                <div className="text-xs text-emerald-400 bg-emerald-500/10 p-2.5 rounded-xl border border-emerald-500/20">
                  {successMessage}
                </div>
              )}
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="p-3 space-y-4">
              <form onSubmit={handleSaveSettings} className="bg-slate-900/40 backdrop-blur-md border border-slate-800/80 rounded-2xl p-4 space-y-3">
                <h3 className="text-xs font-semibold text-slate-200">安全首选项</h3>

                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 mb-1">
                    无活动自动锁定（分钟）
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="1440"
                    value={autoLockMinutes}
                    onChange={(e) => setAutoLockMinutes(Number(e.target.value))}
                    className="w-full px-3 py-1.5 bg-slate-900/50 border border-slate-800/80 rounded-xl text-xs text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                    required
                  />
                </div>

                <div className="flex items-start gap-2 pt-1">
                  <input
                    type="checkbox"
                    id="requireSyncPassword"
                    checked={requireSyncPassword}
                    onChange={(e) => setRequireSyncPassword(e.target.checked)}
                    className="mt-1 rounded border-slate-800 bg-slate-900 text-cyan-600 focus:ring-cyan-500 shrink-0"
                  />
                  <div>
                    <label htmlFor="requireSyncPassword" className="text-xs font-semibold text-slate-300 cursor-pointer">
                      每次会话都需要同步密码
                    </label>
                    <p className="text-[9px] text-slate-500 mt-0.5 leading-relaxed">
                      如果不勾选，将使用存储在 IndexedDB 中的不可导出密钥在本地加密您的同步密码以便自动解锁，以防范随意的本地目录复制。
                    </p>
                  </div>
                </div>

                <button
                  type="submit"
                  className="w-full bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-medium text-xs py-2.5 px-4 rounded-xl shadow-lg shadow-cyan-600/20 transition-all focus:ring-2 focus:ring-cyan-500 focus:outline-none"
                >
                  保存设置
                </button>
              </form>

              <div className="bg-slate-900/40 backdrop-blur-md border border-slate-800/80 rounded-2xl p-4 space-y-2.5">
                <h3 className="text-xs font-semibold text-slate-200">存储管理</h3>
                <p className="text-[9px] text-slate-500 leading-relaxed">
                  清空您的本地数据将删除所有离线记录、密钥和配置。这不会影响存储在远程服务器上的同步记录。
                </p>
                <button
                  onClick={handleWipeLocal}
                  className="w-full border border-rose-500/30 text-rose-400 hover:bg-rose-500/10 font-medium text-xs py-2 px-4 rounded-xl transition-colors focus:ring-2 focus:ring-rose-500/50"
                >
                  清空本地数据库
                </button>
              </div>

              {successMessage && (
                <div className="text-xs text-emerald-400 bg-emerald-500/10 p-2.5 rounded-xl border border-emerald-500/20">
                  {successMessage}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Four-Item Bottom Navigation */}
        <div className="bg-slate-950/80 backdrop-blur-md border-t border-slate-800/85 flex justify-around py-1.5 shrink-0">
          <button
            onClick={() => setActiveTab('vault')}
            className={`flex flex-col items-center gap-0.5 py-1 px-4 rounded-xl transition-all focus:outline-none ${
              activeTab === 'vault' ? 'text-cyan-400 bg-cyan-500/10 font-semibold' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/40'
            }`}
          >
            <Key className="w-4 h-4" />
            <span className="text-[9px]">账号库</span>
          </button>
          <button
            onClick={() => setActiveTab('groups')}
            className={`flex flex-col items-center gap-0.5 py-1 px-4 rounded-xl transition-all focus:outline-none ${
              activeTab === 'groups' ? 'text-cyan-400 bg-cyan-500/10 font-semibold' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/40'
            }`}
          >
            <Link className="w-4 h-4" />
            <span className="text-[9px]">关系</span>
          </button>
          <button
            onClick={() => setActiveTab('sync')}
            className={`flex flex-col items-center gap-0.5 py-1 px-4 rounded-xl transition-all focus:outline-none ${
              activeTab === 'sync' ? 'text-cyan-400 bg-cyan-500/10 font-semibold' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/40'
            }`}
          >
            <Globe className="w-4 h-4" />
            <span className="text-[9px]">同步</span>
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`flex flex-col items-center gap-0.5 py-1 px-4 rounded-xl transition-all focus:outline-none ${
              activeTab === 'settings' ? 'text-cyan-400 bg-cyan-500/10 font-semibold' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/40'
            }`}
          >
            <Settings className="w-4 h-4" />
            <span className="text-[9px]">设置</span>
          </button>
        </div>
      </div>

      {/* Slide-Up Overlay Panel for Add/Edit Account */}
      {showAddModal && (
        <div className="absolute inset-0 bg-[#0B0F19] z-50 flex flex-col p-4 animate-slide-up overflow-y-auto no-scrollbar">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(99,102,241,0.12),transparent_60%)] pointer-events-none" />

          <div className="relative flex-1 flex flex-col z-10">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800/80 mb-4">
              <h3 className="text-sm font-bold text-white">
                {editingItem ? '编辑账户' : '添加新账户'}
              </h3>
              <button
                type="button"
                onClick={closeAddModal}
                className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1 bg-slate-900/60 border border-slate-800/80 rounded-lg"
              >
                关闭
              </button>
            </div>

            <form onSubmit={handleSaveItem} className="space-y-4 flex-1 flex flex-col justify-between">
              <div className="space-y-4">
                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 mb-1.5">
                    账号分类
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        { key: 'google', label: 'Google' },
                        { key: 'gpt', label: 'GPT/OpenAI' },
                        { key: 'email', label: '邮箱' },
                        { key: 'proxy', label: '代理' },
                        { key: 'site', label: '其他网站' }
                      ] as const
                    ).map((opt) => {
                      const isSelected = accountType === opt.key;
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => setAccountType(opt.key)}
                          className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all focus:outline-none ${
                            isSelected
                              ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/35 shadow-sm shadow-cyan-500/10'
                              : 'bg-slate-900/40 text-slate-400 border-slate-800/60 hover:bg-slate-800/50 hover:text-slate-200'
                          }`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="p-3 bg-slate-950/30 rounded-2xl border border-slate-800/60 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                      服务端可见信息
                    </span>
                    <span className="text-[9px] text-slate-500">仅包含分组关联等公开元数据</span>
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 mb-1">
                      所属分组
                    </label>
                    <select
                      value={newItemGroupId}
                      onChange={(e) => setNewItemGroupId(e.target.value)}
                      className="w-full px-2.5 py-1.5 bg-slate-900/50 border border-slate-800/80 rounded-xl text-xs text-white focus:outline-none focus:ring-2 focus:ring-cyan-500 [&>option]:bg-[#0B0F19]"
                    >
                      <option value="">未分组</option>
                      {decryptedGroups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="p-3 bg-slate-950/30 rounded-2xl border border-slate-800/60 space-y-3.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-wider flex items-center gap-1">
                      <Lock className="w-3 h-3" />
                      仅本地加密保存
                    </span>
                    <span className="text-[9px] text-cyan-500/80">服务端仅存储密文，无法解密</span>
                  </div>

                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 mb-1 flex items-center gap-1">
                      <Lock className="w-2.5 h-2.5 text-cyan-500" />
                      发行方/网站
                    </label>
                    <input
                      type="text"
                      placeholder="例如 GitHub"
                      value={newItemIssuer}
                      onChange={(e) => setNewItemIssuer(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-900/50 border border-slate-800/80 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 mb-1 flex items-center gap-1">
                      <Lock className="w-2.5 h-2.5 text-cyan-500" />
                      登录账号/邮箱
                    </label>
                    <input
                      type="text"
                      placeholder="例如 user@email.com"
                      value={newItemAccount}
                      onChange={(e) => setNewItemAccount(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-900/50 border border-slate-800/80 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 mb-1 flex items-center gap-1">
                      <Lock className="w-2.5 h-2.5 text-cyan-500" />
                      登录密码
                    </label>
                    <input
                      type="password"
                      placeholder="本地加密保存的密码"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-900/50 border border-slate-800/80 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 mb-1 flex items-center gap-1">
                      <Lock className="w-2.5 h-2.5 text-cyan-500" />
                      2FA 密钥 (Base32, 可选)
                    </label>
                    <input
                      type="text"
                      placeholder="如果不启用 2FA 请留空"
                      value={newItemSecret}
                      onChange={(e) => setNewItemSecret(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-900/50 border border-slate-800/80 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 uppercase font-mono"
                    />
                  </div>

                  {!editingItem && (
                    <div onPaste={handleQrPaste} className="rounded-xl border border-dashed border-slate-800/80 bg-slate-950/20 p-2.5 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[9px] font-semibold text-slate-400">导入 2FA 二维码 (可选)</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="bg-slate-900 border border-slate-800 text-[10px] font-semibold text-cyan-400 hover:bg-slate-800 px-2.5 py-1.5 rounded-lg cursor-pointer"
                        >
                          选择图片
                        </button>
                        <button
                          type="button"
                          onClick={handleScanCurrentTab}
                          disabled={isScanningTab}
                          className="bg-cyan-500/10 border border-cyan-500/30 text-[10px] font-semibold text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-60 px-2.5 py-1.5 rounded-lg"
                        >
                          {isScanningTab ? '识别中...' : '识别当前页'}
                        </button>
                      </div>
                      <p className="text-[9px] leading-relaxed text-slate-400">
                        可在上方框内按 Ctrl+V 粘贴截图，或自动扫描当前标签页。
                      </p>
                      {selectedFileName && (
                        <span className="block text-[9px] text-slate-400 truncate">
                          已选择: {selectedFileName}
                        </span>
                      )}
                      {qrPreviewSrc && (
                        <div className="flex items-center gap-2.5 rounded-lg border border-slate-800 bg-slate-900/50 p-2">
                          <img
                            src={qrPreviewSrc}
                            alt="当前二维码预览"
                            className="h-10 w-10 rounded border border-slate-700 bg-white object-contain p-0.5"
                          />
                          <div className="min-w-0">
                            <p className="text-[9px] font-semibold text-slate-300">二维码已解析</p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="border-t border-slate-800/60 pt-3 space-y-3">
                    <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider block">
                      关联账号/网络关系
                    </span>

                    <div>
                      <label className="block text-[10px] font-semibold text-slate-400 mb-1 flex items-center gap-1">
                        <Lock className="w-2.5 h-2.5 text-cyan-500" />
                        关联手机
                      </label>
                      <input
                        type="text"
                        placeholder="例如 13800138000"
                        value={boundPhone}
                        onChange={(e) => setBoundPhone(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-900/50 border border-slate-800/80 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-semibold text-slate-400 mb-1 flex items-center gap-1">
                        <Lock className="w-2.5 h-2.5 text-cyan-500" />
                        使用代理
                      </label>
                      <input
                        type="text"
                        placeholder="例如 127.0.0.1:7890"
                        value={boundProxy}
                        onChange={(e) => setBoundProxy(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-900/50 border border-slate-800/80 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-semibold text-slate-400 mb-1 flex items-center gap-1">
                        <Lock className="w-2.5 h-2.5 text-cyan-500" />
                        关联谷歌账号
                      </label>
                      <input
                        type="text"
                        placeholder="例如 google@gmail.com"
                        value={boundGoogle}
                        onChange={(e) => setBoundGoogle(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-900/50 border border-slate-800/80 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 mb-1 flex items-center gap-1">
                      <Lock className="w-2.5 h-2.5 text-cyan-500" />
                      其他备注 / 说明
                    </label>
                    <textarea
                      rows={2}
                      placeholder="其他备注说明..."
                      value={newItemNotes}
                      onChange={(e) => setNewItemNotes(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-900/50 border border-slate-800/80 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none"
                    />
                  </div>
                </div>
              </div>

              <div className="flex gap-3 pt-4 border-t border-slate-800/60 mt-6">
                <button
                  type="button"
                  onClick={closeAddModal}
                  className="flex-1 bg-slate-900/60 border border-slate-800/80 text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 py-2 rounded-xl text-xs font-medium focus:outline-none"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="flex-1 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white py-2 rounded-xl text-xs font-medium focus:outline-none shadow-md shadow-cyan-600/25"
                >
                  保存
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleQrUpload}
                className="hidden"
              />
            </form>
          </div>
        </div>
      )}

      {/* Slide-Up Overlay Panel for Add/Edit Group */}
      {showGroupModal && (
        <div className="absolute inset-0 bg-[#0B0F19] z-50 flex flex-col p-4 animate-slide-up">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(6,182,212,0.12),transparent_60%)] pointer-events-none" />

          <div className="relative flex-1 flex flex-col z-10">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800/80 mb-4">
              <h3 className="text-sm font-bold text-white">
                {editingGroup ? '重命名分组' : '添加新分组'}
              </h3>
              <button
                type="button"
                onClick={() => setShowGroupModal(false)}
                className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1 bg-slate-900/60 border border-slate-800/80 rounded-lg"
              >
                关闭
              </button>
            </div>

            <form onSubmit={handleSaveGroup} className="space-y-4 flex-1 flex flex-col justify-between">
              <div className="space-y-3">
                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 mb-1">
                    分组名称
                  </label>
                  <input
                    type="text"
                    placeholder="例如 个人"
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-900/50 border border-slate-800/80 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                    required
                    autoFocus
                  />
                </div>
              </div>

              <div className="flex gap-3 pt-4 border-t border-slate-800/60 mt-auto">
                <button
                  type="button"
                  onClick={() => setShowGroupModal(false)}
                  className="flex-1 bg-slate-900/60 border border-slate-800/80 text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 py-2 rounded-xl text-xs font-medium focus:outline-none"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="flex-1 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white py-2 rounded-xl text-xs font-medium focus:outline-none shadow-md shadow-cyan-600/25"
                >
                  保存
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
