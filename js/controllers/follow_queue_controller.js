import { call } from '../api.js';

let processor = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isoToMs(iso) {
  try {
    const t = Date.parse(String(iso || ''));
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

async function emitStatus() {
  try {
    const res = await call('followQueueStatus', {});
    window.dispatchEvent(new CustomEvent('bsky-follow-queue-status', { detail: res?.status || res || {} }));
    return res;
  } catch {
    return null;
  }
}

async function processLoop({ maxPerTick = 50 } = {}) {
  // Single global loop; safe to call multiple times.
  if (processor?.running) return;
  processor = processor || { running: false, stop: false };
  processor.running = true;
  processor.stop = false;

  try {
    for (;;) {
      if (processor.stop) break;

      let out = null;
      try {
        out = await call('processFollowQueue', { max: maxPerTick });
        try { window.dispatchEvent(new CustomEvent('bsky-follow-queue-processed', { detail: out || {} })); } catch {}
      } catch (e) {
        // If this call itself gets rate limited at the app layer, just back off briefly.
        const msg = String(e?.message || '');
        const isRate = (e && (e.status === 429 || e.code === 'RATE_LIMITED' || e.name === 'RateLimitError'))
          || /\bHTTP\s*429\b/i.test(msg);
        if (!isRate) throw e;
        await sleep(10_000);
        continue;
      }

      const status = out?.status || null;
      const pending = Number(status?.pending || status?.counts?.pending || 0);
      const rateUntilIso = out?.rateLimitedUntil || status?.rateLimitedUntil || status?.rateLimitedUntil;
      const nextAttemptAt = status?.nextAttemptAt || null;

      // Emit status event for UIs.
      try { window.dispatchEvent(new CustomEvent('bsky-follow-queue-status', { detail: status || {} })); } catch {}

      if (!pending) break;

      // If we're rate limited, sleep until then.
      const untilMs = isoToMs(rateUntilIso);
      if (untilMs && untilMs > Date.now()) {
        await sleep(Math.min(60_000, Math.max(1000, untilMs - Date.now())));
        continue;
      }

      // Otherwise, if items are scheduled for later, wait until the soonest attempt.
      const nextMs = isoToMs(nextAttemptAt);
      if (nextMs && nextMs > Date.now()) {
        await sleep(Math.min(60_000, Math.max(1000, nextMs - Date.now())));
        continue;
      }

      // Tight loop protection: small delay.
      await sleep(750);
    }
  } finally {
    processor.running = false;
    await emitStatus();
  }
}

export async function queueFollows(dids, { processNow = true, maxNow = 50, maxPerTick = 50 } = {}) {
  const unique = Array.from(new Set((Array.isArray(dids) ? dids : []).map((d) => String(d || '').trim()).filter(Boolean)));
  if (!unique.length) return { ok: false, error: 'No DIDs' };

  const res = await call('queueFollows', { dids: unique, processNow, maxNow });
  try { window.dispatchEvent(new CustomEvent('bsky-follow-queue-enqueued', { detail: res || {} })); } catch {}

  // If the server processed nothing (rate-limited), this will naturally wait.
  if (processNow) {
    try { processLoop({ maxPerTick }); } catch {}
  }

  return res;
}

export function startFollowQueueProcessor({ maxPerTick = 50 } = {}) {
  try { processLoop({ maxPerTick }); } catch {}
}

export function stopFollowQueueProcessor() {
  if (processor) processor.stop = true;
}
