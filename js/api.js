// application/single_pages/bluesky_feed/js/api.js
function getCsrfFromMeta() {
  const el = document.querySelector('meta[name="csrf-token"]');
  return el?.getAttribute('content') || null;
}
function getCsrfFromCookie() {
  const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function getFreshCsrf() {
  // prefer latest DOM/cookie over a possibly stale window.BSKY.csrf
  return getCsrfFromMeta() || getCsrfFromCookie() || window.BSKY?.csrf || null;
}
async function fetchJson(url, opts) {
  let res, text;
  try {
    res = await fetch(url, { credentials: 'include', ...opts }); // send cookies/session
    text = await res.text();
  } catch (e) {
    console.error('[BSKY > call] network error', e);
    throw new Error('Network error contacting API');
  }
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch {
    console.warn('[BSKY > call] non-JSON response', { status: res.status, text: text?.slice(0, 500) });
    // keep body null; surface plain text below if needed
  }
  return { ok: res.ok, status: res.status, body, text, headers: res.headers };
}

function parseRetryAfterSeconds(retryAfterRaw) {
  const raw = String(retryAfterRaw || '').trim();
  if (!raw) return null;
  // Retry-After can be either delta-seconds or an HTTP date.
  if (/^\d+$/.test(raw)) {
    const sec = parseInt(raw, 10);
    return Number.isFinite(sec) ? Math.max(0, sec) : null;
  }
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  const deltaMs = t - Date.now();
  if (!Number.isFinite(deltaMs)) return null;
  return Math.max(0, Math.ceil(deltaMs / 1000));
}

function enrichError(err, extra = {}) {
  try {
    Object.assign(err, extra);
  } catch {}
  return err;
}

function isExpiredToken(errMsg) {
  return /token has expired/i.test(String(errMsg || ''));
}

function emitAuthExpired(detail) {
  try {
    window.dispatchEvent(new CustomEvent('bsky-auth-expired', { detail }));
  } catch {}
}

function markCacheUnavailable(errMsg) {
  const msg = String(errMsg || '');
  if (!/could not find driver|pdo_sqlite|sqlite/i.test(msg)) return;
  window.BSKY = window.BSKY || {};
  window.BSKY.cacheAvailable = false;
  try {
    window.dispatchEvent(new CustomEvent('bsky-cache-unavailable', { detail: { error: msg } }));
  } catch {}
}

export async function call(method, params = {}) {
  const url = window.BSKY?.apiPath || '/api';
  const buildReq = (csrf) => ({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: JSON.stringify({ method, params }),
  });

  console.log('[BSKY > call] →', { url, method, params });

  // 1st attempt with freshest token we can read
  let csrf = getFreshCsrf();
  let { ok, status, body, text, headers } = await fetchJson(url, buildReq(csrf));

  // Retry once if token expired / 400/401/403
  if ((!ok || body?.error) && (status === 400 || status === 401 || status === 403)) {
    const msg = body?.error || body?.message || text || `HTTP ${status}`;
    if (isExpiredToken(msg)) {
      // refresh CSRF from DOM/cookie again (it might have rotated)
      const newCsrf = getFreshCsrf();
      if (newCsrf && newCsrf !== csrf) {
        csrf = newCsrf;
        ({ ok, status, body, text, headers } = await fetchJson(url, buildReq(csrf)));
      }
      if (!ok || body?.error) {
        emitAuthExpired({ status, error: body?.error || msg });
      }
    }
  }

  if (!ok || body?.error) {
    const errMsg = body?.error || body?.message || text || `HTTP ${status}`;
    console.error('[BSKY > call] HTTP error', { status, url, body: body ?? text });

    if (status === 429) {
      let ra = null;
      try {
        const h = headers?.get?.('retry-after') || headers?.get?.('Retry-After') || null;
        if (h) ra = String(h);
      } catch {}
      const retryAfterSeconds = parseRetryAfterSeconds(ra);
      const suffix = ra ? ` (retry-after: ${ra})` : '';
      throw enrichError(new Error(`HTTP 429: Rate limited${suffix}`), {
        name: 'RateLimitError',
        status,
        code: 'RATE_LIMITED',
        retryAfterRaw: ra,
        retryAfterSeconds,
      });
    }

    // If cache endpoints are failing due to missing SQLite support, stop retrying elsewhere.
    if (String(method || '').startsWith('cache')) {
      markCacheUnavailable(errMsg);
    }

    throw enrichError(new Error(errMsg.startsWith('HTTP ') ? errMsg : `HTTP ${status}: ${errMsg}`), {
      status,
    });
  }

  return body;
}
