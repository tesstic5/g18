// apps/web/src/lib/safe-storage.ts — try/catch storage wrappers.
// The preview iframe is sandboxed (no allow-same-origin) and private mode / some
// embedded contexts block localStorage/sessionStorage/IndexedDB entirely — a raw
// access throws SecurityError and breaks hydration. Every storage access in the app
// must go through these.
export const safeStorage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* unavailable — ignore */
    }
  },
  remove(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export const safeSession = {
  get(key: string): string | null {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
  remove(key: string): void {
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

/** IndexedDB wrapper that never throws (falls back to in-memory). */
export function createSafeCache<T>(store = 'kv') {
  const mem = new Map<string, T>();
  let db: IDBDatabase | null = null;
  let supported = typeof indexedDB !== 'undefined';

  function open(): Promise<IDBDatabase | null> {
    if (!supported || db) return Promise.resolve(db);
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open('casino-offline', 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(store)) d.createObjectStore(store);
        };
        req.onsuccess = () => {
          db = req.result;
          resolve(db);
        };
        req.onerror = () => {
          supported = false;
          resolve(null);
        };
      } catch {
        supported = false;
        resolve(null);
      }
    });
  }

  return {
    async put(key: string, value: T): Promise<void> {
      const d = await open();
      if (!d) {
        mem.set(key, value);
        return;
      }
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = d.transaction(store, 'readwrite');
          tx.objectStore(store).put(value, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch {
        mem.set(key, value);
      }
    },
    async get(key: string): Promise<T | undefined> {
      const d = await open();
      if (!d) return mem.get(key);
      try {
        return await new Promise<T | undefined>((resolve, reject) => {
          const tx = d.transaction(store, 'readonly');
          const req = tx.objectStore(store).get(key);
          req.onsuccess = () => resolve(req.result as T | undefined);
          req.onerror = () => reject(req.error);
        });
      } catch {
        return mem.get(key);
      }
    },
  };
}
