export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function deriveKeyFromPassword(password: string, salt: Uint8Array, iterations = 100000): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passwordBytes = encoder.encode(password);
  
  const baseKey = await globalThis.crypto.subtle.importKey(
    'raw',
    passwordBytes,
    'PBKDF2',
    false,
    ['deriveKey', 'deriveBits']
  );
  
  return await globalThis.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: iterations,
      hash: 'SHA-256'
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

export async function generateDEK(): Promise<CryptoKey> {
  return await globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

export async function wrapDEK(dek: CryptoKey, kek: CryptoKey): Promise<{ wrappedDek: Uint8Array; iv: Uint8Array }> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const rawDEK = await globalThis.crypto.subtle.exportKey('raw', dek);
  const wrapped = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    kek,
    rawDEK
  );
  return {
    wrappedDek: new Uint8Array(wrapped),
    iv: iv
  };
}

export async function unwrapDEK(wrappedDek: Uint8Array, kek: CryptoKey, iv: Uint8Array): Promise<CryptoKey> {
  const decrypted = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv },
    kek,
    wrappedDek
  );
  return await globalThis.crypto.subtle.importKey(
    'raw',
    decrypted,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

export async function encryptRecord(plaintext: string, dek: CryptoKey, id: string): Promise<{ iv_b64: string; ct_b64: string; alg: string; aad_b64?: string }> {
  const encoder = new TextEncoder();
  const ptBytes = encoder.encode(plaintext);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(id);
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv, additionalData: aad },
    dek,
    ptBytes
  );
  return {
    alg: 'A256GCM',
    iv_b64: bytesToBase64(iv),
    ct_b64: bytesToBase64(new Uint8Array(ct)),
    aad_b64: bytesToBase64(aad)
  };
}

export async function decryptRecord(iv_b64: string, ct_b64: string, dek: CryptoKey, id: string, aad_b64?: string): Promise<string> {
  const decoder = new TextDecoder();
  const iv = base64ToBytes(iv_b64);
  const ct = base64ToBytes(ct_b64);
  const encoder = new TextEncoder();
  const aad = aad_b64 ? base64ToBytes(aad_b64) : encoder.encode(id);
  const decrypted = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv, additionalData: aad },
    dek,
    ct
  );
  return decoder.decode(decrypted);
}

function openDB(): Promise<IDBDatabase> {
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

export async function getOrCreateWrappingKey(): Promise<CryptoKey> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('keys', 'readwrite');
    const store = tx.objectStore('keys');
    const getReq = store.get('deviceWrappingKey');
    
    getReq.onsuccess = async () => {
      let key = getReq.result as CryptoKey | undefined;
      if (key) {
        resolve(key);
      } else {
        key = await globalThis.crypto.subtle.generateKey(
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
        const putReq = store.put(key, 'deviceWrappingKey');
        putReq.onsuccess = () => resolve(key!);
        putReq.onerror = () => reject(putReq.error);
      }
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

export async function deleteWrappingKey(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('keys', 'readwrite');
    const store = tx.objectStore('keys');
    const delReq = store.delete('deviceWrappingKey');
    delReq.onsuccess = () => resolve();
    delReq.onerror = () => reject(delReq.error);
  });
}

export async function wrapSyncPassword(password: string, wrappingKey: CryptoKey): Promise<{ ct_b64: string; iv_b64: string }> {
  const encoder = new TextEncoder();
  const ptBytes = encoder.encode(password);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    wrappingKey,
    ptBytes
  );
  return {
    ct_b64: bytesToBase64(new Uint8Array(ct)),
    iv_b64: bytesToBase64(iv)
  };
}

export async function unwrapSyncPassword(ct_b64: string, iv_b64: string, wrappingKey: CryptoKey): Promise<string> {
  const decoder = new TextDecoder();
  const iv = base64ToBytes(iv_b64);
  const ct = base64ToBytes(ct_b64);
  const decrypted = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv },
    wrappingKey,
    ct
  );
  return decoder.decode(decrypted);
}
