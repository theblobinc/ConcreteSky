import { call } from '../api.js';

export async function fetchLists({ limit = 100 } = {}) {
  const res = await call('getLists', { limit });
  const lists = Array.isArray(res?.lists)
    ? res.lists
    : (Array.isArray(res?.data?.lists) ? res.data.lists : []);
  return lists.map((l) => ({ uri: l?.uri, name: l?.name }));
}

export function bindListsRequest(root, { limit = 100 } = {}) {
  if (!root || typeof root.addEventListener !== 'function') return () => {};

  const handler = async (e) => {
    const composer = (e?.target && String(e.target.tagName || '').toLowerCase() === 'bsky-comment-composer') ? e.target : null;
    if (!composer) return;

    try { composer.setListsLoading?.(true); } catch {}
    try {
      const shaped = await fetchLists({ limit });
      try { composer.setLists?.(shaped); } catch {}
    } catch (err) {
      try { composer.setListsError?.(err?.message || String(err || 'Failed to load lists')); } catch {}
    }
  };

  root.addEventListener('bsky-request-lists', handler);
  return () => {
    try { root.removeEventListener('bsky-request-lists', handler); } catch {}
  };
}
