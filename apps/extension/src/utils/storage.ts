import type { Item, Group, Account, Relation } from '@2fa/api-types';

export interface StorageLocal {
  get(keys: string[] | Record<string, unknown>): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  clear(): Promise<void>;
}

export const localStore: StorageLocal = {
  get: async (keys) => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      return await chrome.storage.local.get(keys);
    }
    const res: Record<string, unknown> = {};
    const keyList = Array.isArray(keys) ? keys : Object.keys(keys);
    for (const k of keyList) {
      const v = localStorage.getItem(k);
      res[k] = v ? JSON.parse(v) : (Array.isArray(keys) ? undefined : keys[k]);
    }
    return res;
  },
  set: async (items) => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set(items);
      return;
    }
    for (const [k, v] of Object.entries(items)) {
      localStorage.setItem(k, JSON.stringify(v));
    }
  },
  remove: async (keys) => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.remove(keys);
      return;
    }
    for (const k of keys) {
      localStorage.removeItem(k);
    }
  },
  clear: async () => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.clear();
      return;
    }
    localStorage.clear();
  }
};

export function openStorageDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('2fa-vault-db', 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('items')) {
        db.createObjectStore('items', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('groups')) {
        db.createObjectStore('groups', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('keys')) {
        db.createObjectStore('keys');
      }
      if (!db.objectStoreNames.contains('accounts')) {
        db.createObjectStore('accounts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('relations')) {
        db.createObjectStore('relations', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveItems(items: Item[]): Promise<void> {
  const db = await openStorageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('items', 'readwrite');
    const store = tx.objectStore('items');
    for (const item of items) {
      store.put(item);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getItems(): Promise<Item[]> {
  const db = await openStorageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('items', 'readonly');
    const store = tx.objectStore('items');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteItems(ids: string[]): Promise<void> {
  const db = await openStorageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('items', 'readwrite');
    const store = tx.objectStore('items');
    for (const id of ids) {
      store.delete(id);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveGroups(groups: Group[]): Promise<void> {
  const db = await openStorageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('groups', 'readwrite');
    const store = tx.objectStore('groups');
    for (const group of groups) {
      store.put(group);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getGroups(): Promise<Group[]> {
  const db = await openStorageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('groups', 'readonly');
    const store = tx.objectStore('groups');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteGroups(ids: string[]): Promise<void> {
  const db = await openStorageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('groups', 'readwrite');
    const store = tx.objectStore('groups');
    for (const id of ids) {
      store.delete(id);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearVault(): Promise<void> {
  const db = await openStorageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['items', 'groups', 'keys', 'accounts', 'relations'], 'readwrite');
    tx.objectStore('items').clear();
    tx.objectStore('groups').clear();
    tx.objectStore('keys').clear();
    tx.objectStore('accounts').clear();
    tx.objectStore('relations').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveAccounts(accounts: Account[]): Promise<void> {
  const db = await openStorageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('accounts', 'readwrite');
    const store = tx.objectStore('accounts');
    for (const account of accounts) {
      store.put(account);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAccounts(): Promise<Account[]> {
  const db = await openStorageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('accounts', 'readonly');
    const store = tx.objectStore('accounts');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteAccounts(ids: string[]): Promise<void> {
  const db = await openStorageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('accounts', 'readwrite');
    const store = tx.objectStore('accounts');
    for (const id of ids) {
      store.delete(id);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveRelations(relations: Relation[]): Promise<void> {
  const db = await openStorageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('relations', 'readwrite');
    const store = tx.objectStore('relations');
    for (const relation of relations) {
      store.put(relation);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getRelations(): Promise<Relation[]> {
  const db = await openStorageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('relations', 'readonly');
    const store = tx.objectStore('relations');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteRelations(ids: string[]): Promise<void> {
  const db = await openStorageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('relations', 'readwrite');
    const store = tx.objectStore('relations');
    for (const id of ids) {
      store.delete(id);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
