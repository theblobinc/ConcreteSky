import { call } from './api.js';

let _last = null;
let _lastAt = 0;
let _inflight = null;

export function isNotConnectedError(err) {
  const msg = String(err?.message || err || '');
  return /not connected to bluesky|connect\/login button|concretecms login required/i.test(msg);
}

export async function getAuthStatusCached(maxAgeMs = 1500) {
  const now = Date.now();
  if (_last && (now - _lastAt) <= maxAgeMs) return _last;
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const res = await call('authStatus', {});
      _last = res;
      _lastAt = Date.now();
      return res;
    } finally {
      _inflight = null;
    }
  })();

  return _inflight;
}
