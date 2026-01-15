import { call } from './api.js';
import { getAuthStatusCached } from './auth_state.js';

const _queue = new Set();
let _timer = null;
let _running = false;

function uniqDids(arr) {
  return Array.from(new Set((arr || []).map(String).map(s => s.trim()).filter(Boolean)));
}

function scheduleFlush() {
  if (_timer) return;
  _timer = setTimeout(() => {
    _timer = null;
    flush().catch((e) => console.warn('[BSKY hydrate] flush failed', e));
  }, 400);
}

async function flush() {
  if (_running) return;
  _running = true;
  try {
    const auth = await getAuthStatusCached();
    if (!auth?.connected) return;

    while (_queue.size) {
      const batch = [];
      for (const did of _queue) {
        batch.push(did);
        _queue.delete(did);
        if (batch.length >= 200) break;
      }

      if (!batch.length) break;

      try {
        const res = await call('profilesHydrate', { dids: batch, staleHours: 24, max: 200 });
        try {
          const updated = Number(res?.updated ?? 0);
          if (updated > 0) {
            window.dispatchEvent(new CustomEvent('bsky-profiles-hydrated', {
              detail: { dids: batch, updated, requested: res?.requested ?? batch.length },
            }));
          }
        } catch {}
      } catch (e) {
        console.warn('[BSKY hydrate] batch failed', e);
      }
    }
  } finally {
    _running = false;
  }
}

export function queueProfiles(dids) {
  const list = uniqDids(dids);
  if (!list.length) return;
  for (const did of list) _queue.add(did);
  scheduleFlush();
}
