import { call } from '../api.js';

export async function syncRecent({ minutes = 10, refreshMinutes = 30, allowDirectFallback = true } = {}) {
  try {
    if (typeof window === 'undefined') return { ok: false, skipped: true, reason: 'noWindow' };
    if (window.BSKY?.cacheAvailable === false) return { ok: false, skipped: true, reason: 'cacheUnavailable' };

    const notifBar = (typeof document !== 'undefined' && typeof document.querySelector === 'function')
      ? document.querySelector('bsky-notification-bar')
      : null;

    const canUseThrottledSync = !!(notifBar && notifBar.isConnected);

    if (canUseThrottledSync) {
      window.dispatchEvent(new CustomEvent('bsky-sync-recent', { detail: { minutes } }));
      return { ok: true, mode: 'event' };
    }

    if (!allowDirectFallback) return { ok: false, skipped: true, reason: 'noNotificationBar' };

    await call('cacheSyncRecent', { minutes });
    window.dispatchEvent(new CustomEvent('bsky-refresh-recent', { detail: { minutes: refreshMinutes } }));
    return { ok: true, mode: 'direct' };
  } catch (error) {
    return { ok: false, error };
  }
}
