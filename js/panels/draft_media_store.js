const DB_NAME = 'bsky';
const DB_VERSION = 1;
const STORE = 'draftMedia';

function openDb() {
  return new Promise((resolve, reject) => {
    try {
      if (!('indexedDB' in window)) {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

async function withStore(mode, fn) {
  const db = await openDb().catch(() => null);
  if (!db) return null;
  try {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const res = await fn(store);
    await new Promise((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
    return res;
  } finally {
    try { db.close(); } catch {}
  }
}

export async function saveDraftMedia(key, parts) {
  const k = String(key || '').trim();
  if (!k) return false;

  let draft = null;
  if (arguments.length >= 3) {
    const maybe = arguments[2];
    if (maybe && typeof maybe === 'object') draft = maybe;
  }

  const safeParts = Array.isArray(parts) ? parts : [];
  const payload = {
    v: 2,
    ts: Date.now(),
    draft: draft && typeof draft === 'object' ? draft : null,
    parts: safeParts.map((p) => {
      const imgs = Array.isArray(p?.images) ? p.images : [];
      return {
        images: imgs.slice(0, 4).map((img) => ({
          name: String(img?.name || ''),
          mime: String(img?.mime || ''),
          dataBase64: String(img?.dataBase64 || ''),
          alt: String(img?.alt || ''),
        })).filter((img) => img.dataBase64 && img.mime),
      };
    }).slice(0, 10),
  };

  await withStore('readwrite', (store) => new Promise((resolve) => {
    const req = store.put(payload, k);
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
  })).catch(() => false);

  return true;
}

export async function loadDraftMedia(key) {
  const k = String(key || '').trim();
  if (!k) return null;

  return await withStore('readonly', (store) => new Promise((resolve) => {
    const req = store.get(k);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  })).catch(() => null);
}

export async function deleteDraftMedia(key) {
  const k = String(key || '').trim();
  if (!k) return false;

  await withStore('readwrite', (store) => new Promise((resolve) => {
    const req = store.delete(k);
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
  })).catch(() => false);

  return true;
}
