import { call } from '../../../api.js';
import { getAuthStatusCached, isNotConnectedError } from '../../../auth_state.js';

const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));

// Convert at://did/app.bsky.feed.post/rkey → https://bsky.app/profile/did/post/rkey
const atUriToWebPost = (uri) => {
  const m = String(uri || '').match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)/);
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : '';
};

const dayStartIso = (ymd) => `${String(ymd)}T00:00:00Z`;
const dayEndIso = (ymd) => `${String(ymd)}T23:59:59Z`;

function normalizeCachedNotifRow(n) {
  const base = (n && typeof n === 'object') ? n : {};
  const a = (base.author && typeof base.author === 'object') ? base.author : {};
  const did = a.did || base.authorDid || base.author_did || '';
  const handle = a.handle || base.authorHandle || base.author_handle || '';
  const displayName = a.displayName || base.authorDisplayName || base.author_display_name || '';
  const avatar = a.avatar || base.authorAvatar || base.author_avatar || '';
  return { ...base, author: { ...a, did, handle, displayName, avatar } };
}

function fmtCompactTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

class BskyDbManager extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._busy = false;
    this._status = null;
    this._log = [];

    this._prefsKey = 'bsky.dbManager.prefs';
    this._prefsTimer = null;

    this._op = {
      name: null,
      phase: null,
      step: 0,
      steps: 0,
      loops: 0,
      loopsMax: 0,
      inserted: 0,
      updated: 0,
      startedAt: 0,
    };
    this._cancelRequested = false;

    this._cfg = {
      pagesMax: 200,
      postsPagesMax: 50,
      postsFilter: null,
      notificationsHours: 24 * 90,
      notificationsPagesMax: 60,
      postsStaleHours: 24 * 7,
      notifsStaleHours: 24 * 7,
    };

    this._profile = null; // { did, handle, displayName, createdAt }

    this._maint = {
      keepDaysPosts: 365,
      keepDaysNotifs: 365,
      lastResult: null,
      lastError: null,
      inspect: null,
      inspectError: null,
      inspectLoading: false,
    };

    this._cal = {
      open: false,
      month: null, // YYYY-MM
      cache: new Map(),
      loading: false,
      error: null,
      selected: new Set(), // YYYY-MM-DD

      mode: 'select', // 'select' | 'inspect'
      selectedDay: null,
      dayLoading: false,
      dayError: null,
      dayPosts: null,
      dayNotifs: null,
    };

    this._queued = new Map();
    this._queueTimer = null;
  }

  loadPrefs() {
    try {
      const raw = localStorage.getItem(this._prefsKey);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (!p || typeof p !== 'object') return;

      const cfg = p.cfg && typeof p.cfg === 'object' ? p.cfg : null;
      if (cfg) {
        if (typeof cfg.pagesMax !== 'undefined') this._cfg.pagesMax = clampInt(cfg.pagesMax, 1, 200, this._cfg.pagesMax);
        if (typeof cfg.postsPagesMax !== 'undefined') this._cfg.postsPagesMax = clampInt(cfg.postsPagesMax, 1, 200, this._cfg.postsPagesMax);
        if (typeof cfg.postsFilter !== 'undefined') this._cfg.postsFilter = (cfg.postsFilter ? String(cfg.postsFilter) : null);
        if (typeof cfg.notificationsHours !== 'undefined') this._cfg.notificationsHours = clampInt(cfg.notificationsHours, 1, 24 * 365 * 30, this._cfg.notificationsHours);
        if (typeof cfg.notificationsPagesMax !== 'undefined') this._cfg.notificationsPagesMax = clampInt(cfg.notificationsPagesMax, 1, 60, this._cfg.notificationsPagesMax);
        if (typeof cfg.postsStaleHours !== 'undefined') this._cfg.postsStaleHours = clampInt(cfg.postsStaleHours, 1, 24 * 365 * 30, this._cfg.postsStaleHours);
        if (typeof cfg.notifsStaleHours !== 'undefined') this._cfg.notifsStaleHours = clampInt(cfg.notifsStaleHours, 1, 24 * 365 * 30, this._cfg.notifsStaleHours);
      }

      const cal = p.cal && typeof p.cal === 'object' ? p.cal : null;
      if (cal) {
        if (cal.mode === 'select' || cal.mode === 'inspect') this._cal.mode = cal.mode;
        if (typeof cal.month === 'string' && /^\d{4}-\d{2}$/.test(cal.month)) this._cal.month = cal.month;
        if (typeof cal.selectedDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cal.selectedDay)) this._cal.selectedDay = cal.selectedDay;
        if (Array.isArray(cal.selected)) {
          this._cal.selected.clear();
          for (const v of cal.selected.slice(0, 400)) {
            if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) this._cal.selected.add(v);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  savePrefsDebounced() {
    try {
      if (this._prefsTimer) clearTimeout(this._prefsTimer);
      this._prefsTimer = setTimeout(() => {
        this._prefsTimer = null;
        try {
          const payload = {
            v: 1,
            cfg: {
              pagesMax: this._cfg.pagesMax,
              postsPagesMax: this._cfg.postsPagesMax,
              postsFilter: this._cfg.postsFilter || null,
              notificationsHours: this._cfg.notificationsHours,
              notificationsPagesMax: this._cfg.notificationsPagesMax,
              postsStaleHours: this._cfg.postsStaleHours,
              notifsStaleHours: this._cfg.notifsStaleHours,
            },
            cal: {
              month: this._cal.month || null,
              mode: this._cal.mode,
              selectedDay: this._cal.selectedDay || null,
              selected: Array.from(this._cal.selected.values()).slice(0, 400),
            },
          };
          localStorage.setItem(this._prefsKey, JSON.stringify(payload));
        } catch {
          // ignore
        }
      }, 250);
    } catch {
      // ignore
    }
  }

  connectedCallback() {
    this.loadPrefs();
    this.render();
    this.refreshStatus();
		this.refreshProfile();
    this.shadowRoot.addEventListener('click', (e) => this.onClick(e));
    this.shadowRoot.addEventListener('change', (e) => this.onChange(e));

    // When embedded as a calendar-only view (e.g. inside the cache settings lightbox),
    // render the calendar inline and load the current month immediately.
    if (this.getAttribute('data-view') === 'calendar') {
      queueMicrotask(() => {
        try { this.openCalendar(); } catch { /* ignore */ }
      });
    }
  }

  setOp(op) {
    this._op = {
      name: op?.name ?? null,
      phase: op?.phase ?? null,
      step: op?.step ?? 0,
      steps: op?.steps ?? 0,
      loops: op?.loops ?? 0,
      loopsMax: op?.loopsMax ?? 0,
      inserted: op?.inserted ?? 0,
      updated: op?.updated ?? 0,
      startedAt: op?.startedAt ?? (Date.now()),
    };
    this.render();
  }

  clearOp() {
    this._op = { name: null, phase: null, step: 0, steps: 0, loops: 0, loopsMax: 0, inserted: 0, updated: 0, startedAt: 0 };
    this._cancelRequested = false;
    this.render();
  }

  requestCancel() {
    if (!this._busy) return;
    this._cancelRequested = true;
    this.log('Cancel requested… stopping after current chunk.', 'info');
    this.render();
  }

  setBusy(v) {
    this._busy = !!v;
    this.render();
  }

  log(msg, kind = 'info') {
    const line = { ts: new Date().toLocaleTimeString(), msg: String(msg || ''), kind };
    this._log = [line, ...this._log].slice(0, 50);
    this.render();
  }

  async refreshStatus() {
    if (this._busy) return;
    this.setBusy(true);
    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) {
        this._status = { ok: false, error: 'Not connected. Use the Connect button.' };
        return;
      }
      this._status = await call('cacheStatus', {});
    } catch (e) {
      this._status = { ok: false, error: isNotConnectedError(e) ? 'Not connected. Use the Connect button.' : (e?.message || String(e)) };
    } finally {
      this.setBusy(false);
    }
  }

  queue(key, fn, delayMs = 250) {
    if (this._queued.has(key)) return;
    this._queued.set(key, fn);
    if (this._queueTimer) return;
    this._queueTimer = setTimeout(async () => {
      this._queueTimer = null;
      if (this._busy) {
        // Try again soon.
        this._queueTimer = setTimeout(() => {
          this._queueTimer = null;
          this.queue('__drain__', async () => {}, 0);
        }, 500);
        return;
      }
      const entries = Array.from(this._queued.entries());
      this._queued.clear();
      for (const [, work] of entries) {
        try { await work(); } catch { /* ignore */ }
      }
    }, delayMs);
  }

  queueStatusRefresh() {
    this.queue('cacheStatus', async () => {
      try {
        if (this._busy) return;
        this._status = await call('cacheStatus', {});
        this.render();
      } catch {
        // ignore
      }
    }, 750);
  }

  monthKey(d = new Date()) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  parseIso(iso) {
    try {
      const t = new Date(String(iso)).getTime();
      return Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  }

  formatAge(iso) {
    const t = this.parseIso(iso);
    if (!t) return '—';
    const days = Math.floor((Date.now() - t) / (24 * 3600 * 1000));
    if (days < 0) return '—';
    const years = Math.floor(days / 365.25);
    const rem = days - Math.floor(years * 365.25);
    if (years >= 1) return `${years}y ${rem}d`;
    return `${days}d`;
  }

  ageHours(iso) {
    const t = this.parseIso(iso);
    if (!t) return null;
    return Math.floor((Date.now() - t) / 3600000);
  }

  async refreshProfile() {
    try {
      const auth = await getAuthStatusCached();
      const did = auth?.did || auth?.session?.did;
      if (!auth?.connected || !did) return;
      const out = await call('getProfiles', { actors: [did] });
      const p = (out?.profiles || [])[0];
      if (!p) return;
      this._profile = {
        did: p.did,
        handle: p.handle,
        displayName: p.displayName,
        createdAt: p.createdAt || null,
      };
      this.render();
    } catch {
      // ignore
    }
  }

  monthBoundsUtc(month) {
    const m = String(month || '').match(/^(\d{4})-(\d{2})$/);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return null;
    const start = new Date(Date.UTC(y, mo - 1, 1, 0, 0, 0));
    const end = new Date(Date.UTC(y, mo, 1, 0, 0, 0));
    return { start, end, y, mo };
  }

  daysInMonthUtc(y, mo) {
    return new Date(Date.UTC(y, mo, 0)).getUTCDate();
  }

  isoDay(y, mo, day) {
    return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  async loadCalendarMonth(month) {
    if (!month) return;
    if (this._cal.cache.has(month)) return;
    this._cal.loading = true;
    this._cal.error = null;
    this.render();
    try {
      const res = await call('cacheCalendarMonth', { month, kind: 'both' });
      this._cal.cache.set(month, res);
      this.queueStatusRefresh();
    } catch (e) {
      this._cal.error = e?.message || String(e);
    } finally {
      this._cal.loading = false;
      this.render();
    }
  }

  openCalendar() {
    this._cal.open = true;
    if (!this._cal.month) this._cal.month = this.monthKey();
    this.loadCalendarMonth(this._cal.month);
    this.savePrefsDebounced();
    this.render();
  }

  closeCalendar() {
    this._cal.open = false;
    this.savePrefsDebounced();
    this.render();
  }

  shiftCalendarMonth(delta) {
    const b = this.monthBoundsUtc(this._cal.month);
    if (!b) return;
    const d = new Date(Date.UTC(b.y, b.mo - 1 + delta, 1));
    this._cal.month = this.monthKey(d);
    this.loadCalendarMonth(this._cal.month);
    this.savePrefsDebounced();
    this.render();
  }

  async selectMissingSinceJoin() {
    if (this._busy) return;
    const createdAt = this._profile?.createdAt || null;
    const joinTs = this.parseIso(createdAt);
    if (!joinTs) {
      this.log('Join date unavailable yet. Try again after connecting.', 'error');
      return;
    }

    const todayTs = Date.now();
    const joinDate = new Date(joinTs);
    const start = new Date(Date.UTC(joinDate.getUTCFullYear(), joinDate.getUTCMonth(), 1));
    const end = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const monthsTotal = Math.max(1, ((end.getUTCFullYear() - start.getUTCFullYear()) * 12) + (end.getUTCMonth() - start.getUTCMonth()) + 1);

    const preserveMonth = this._cal.month || this.monthKey();

    this.setBusy(true);
    this._cancelRequested = false;
    this.setOp({ name: 'Select', phase: 'Missing since join', steps: monthsTotal, step: 0, loopsMax: 0, loops: 0, inserted: 0, updated: 0, startedAt: Date.now() });

    let selectedCount = 0;
    try {
      const d = new Date(start.getTime());
      for (let i = 0; i < monthsTotal; i++) {
        if (this._cancelRequested) break;

        const y = d.getUTCFullYear();
        const mo = d.getUTCMonth() + 1;
        const month = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}`;

        let calRes = this._cal.cache.get(month);
        if (!calRes) {
          calRes = await call('cacheCalendarMonth', { month, kind: 'both' });
          this._cal.cache.set(month, calRes);
        }

        const postsDays = new Set((calRes?.posts?.days || []).map(Number));
        const notifDays = new Set((calRes?.notifications?.days || []).map(Number));
        const hasData = (day) => postsDays.has(day) || notifDays.has(day);

        const daysIn = this.daysInMonthUtc(y, mo);
        for (let day = 1; day <= daysIn; day++) {
          const iso = this.isoDay(y, mo, day);
          const t = Date.parse(iso + 'T00:00:00Z');
          if (!Number.isFinite(t)) continue;
          if (t < joinTs) continue;
          if (t > todayTs) continue;
          if (hasData(day)) continue;
          if (!this._cal.selected.has(iso)) {
            this._cal.selected.add(iso);
            selectedCount++;
          }
        }

        this.setOp({ ...this._op, step: i + 1, phase: `Missing since join • ${month}` });
        // Advance month
        d.setUTCMonth(d.getUTCMonth() + 1);
      }

      if (this._cancelRequested) {
        this.log('Selection cancelled.', 'info');
      } else {
        this.log(`Selected ${selectedCount} missing day(s) since join.`, 'ok');
      }
    } catch (e) {
      this.log(`Select missing failed: ${isNotConnectedError(e) ? 'Not connected.' : (e?.message || e)}`, 'error');
    } finally {
      this._cal.month = preserveMonth;
      // Ensure current month view is available after running.
      this.loadCalendarMonth(this._cal.month);

      this.savePrefsDebounced();
      this.setBusy(false);
      this.clearOp();
    }
  }

  toggleSelectedDay(ymd) {
    if (!ymd) return;
    if (this._cal.selected.has(ymd)) this._cal.selected.delete(ymd);
    else this._cal.selected.add(ymd);
    this.savePrefsDebounced();
    this.render();
  }

  async openCalendarDay(ymd) {
    const day = String(ymd || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    this._cal.selectedDay = day;
    this._cal.dayLoading = true;
    this._cal.dayError = null;
    this._cal.dayPosts = null;
    this._cal.dayNotifs = null;
    this.savePrefsDebounced();
    this.render();

    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) {
        this._cal.dayError = 'Not connected. Use the Connect button.';
        return;
      }
      const [postsRes, notifRes] = await Promise.all([
        call('cacheQueryMyPosts', { since: dayStartIso(day), until: dayEndIso(day), hours: 0, limit: 200, offset: 0, newestFirst: true }),
        call('cacheQueryNotifications', { since: dayStartIso(day), until: dayEndIso(day), hours: 0, limit: 200, offset: 0, newestFirst: true }),
      ]);
      this._cal.dayPosts = Array.isArray(postsRes?.items) ? postsRes.items : [];
      this._cal.dayNotifs = Array.isArray(notifRes?.items) ? notifRes.items : [];
    } catch (e) {
      this._cal.dayError = isNotConnectedError(e) ? 'Not connected. Use the Connect button.' : (e?.message || String(e));
    } finally {
      this._cal.dayLoading = false;
      this.render();
    }
  }

  selectAllInCurrentMonth({ missingOnly }) {
    const b = this.monthBoundsUtc(this._cal.month);
    if (!b) return;
    const monthRes = this._cal.cache.get(this._cal.month);
    const postsDays = new Set((monthRes?.posts?.days || []).map(Number));
    const notifDays = new Set((monthRes?.notifications?.days || []).map(Number));
    const hasData = (d) => postsDays.has(d) || notifDays.has(d);

    const joinTs = this.parseIso(this._profile?.createdAt);
    const todayTs = Date.now();

    for (let day = 1; day <= this.daysInMonthUtc(b.y, b.mo); day++) {
      const iso = this.isoDay(b.y, b.mo, day);
      const t = Date.parse(iso + 'T00:00:00Z');
      if (joinTs && t < joinTs) continue;
      if (t > todayTs) continue;
      if (missingOnly && hasData(day)) continue;
      this._cal.selected.add(iso);
    }
    this.savePrefsDebounced();
    this.render();
  }

  clearSelection() {
    this._cal.selected.clear();
    this.savePrefsDebounced();
    this.render();
  }

  isRateLimitError(e) {
    return (e && (e.status === 429 || e.code === 'RATE_LIMITED' || e.name === 'RateLimitError'))
      || /\bHTTP\s*429\b/i.test(String(e?.message || ''));
  }

  getRetryAfterSeconds(e) {
    const v = e?.retryAfterSeconds;
    if (Number.isFinite(v) && v >= 0) return v;
    const msg = String(e?.message || '');
    const m = msg.match(/retry-after:\s*([^\)\s]+)/i);
    if (!m) return null;
    const raw = String(m[1] || '').trim();
    if (/^\d+$/.test(raw)) return Math.max(0, parseInt(raw, 10));
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) return null;
    return Math.max(0, Math.ceil((t - Date.now()) / 1000));
  }

  async backoffForRateLimit(e, label) {
    if (!this.isRateLimitError(e)) return false;
    const sec = this.getRetryAfterSeconds(e);
    const waitSec = Number.isFinite(sec) ? Math.min(3600, Math.max(1, sec)) : 10;

    this.log(`Rate limited. Backing off ${waitSec}s…`, 'info');
    const endAt = Date.now() + (waitSec * 1000);
    while (!this._cancelRequested) {
      const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      this.setOp({
        ...this._op,
        phase: `${label}: rate limited; waiting ${remaining}s`,
      });
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return true;
  }

  earliestSelectedIso() {
    const all = Array.from(this._cal.selected.values());
    if (!all.length) return null;
    all.sort();
    return all[0];
  }

  async backfillPostsToSelection() {
    const earliest = this.earliestSelectedIso();
    if (!earliest) return;
    if (this._busy) return;
    this.setBusy(true);
    this._cancelRequested = false;
    this.setOp({ name: 'Backfill', phase: `Posts → ${earliest}`, steps: 0, step: 0, loopsMax: 250, loops: 0, inserted: 0, updated: 0, startedAt: Date.now() });
    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) {
        this.log('Not connected. Use the Connect button.', 'error');
        return;
      }

      const stopBefore = earliest + 'T00:00:00Z';
      let loops = 0;
      while (loops < 250) {
        if (this._cancelRequested) break;
        let out;
        try {
          out = await call('cacheBackfillMyPosts', {
            pagesMax: this._cfg.postsPagesMax,
            filter: this._cfg.postsFilter || null,
            reset: false,
            stopBefore,
          });
        } catch (e) {
          const waited = await this.backoffForRateLimit(e, `Posts → ${earliest}`);
          if (waited) continue;
          throw e;
        }
        loops++;
        const inserted = out?.inserted ?? 0;
        const updated = out?.updated ?? 0;
        const done = !!out?.done;
        const stoppedEarly = !!out?.stoppedEarly;
        this.setOp({
          ...this._op,
          loops,
          inserted: (this._op.inserted || 0) + inserted,
          updated: (this._op.updated || 0) + updated,
        });
        this.log(`Posts → ${earliest}: +${inserted} / ~${updated} (pages ${out?.pages ?? '?'})${stoppedEarly ? ' REACHED' : ''}${done ? ' DONE' : ''}`, (stoppedEarly || done) ? 'ok' : 'info');
        this.queueStatusRefresh();
        // Refresh coverage for the current month so circles update quickly.
        if (this._cal.month) this._cal.cache.delete(this._cal.month);
        this.loadCalendarMonth(this._cal.month);
        if (stoppedEarly || done || !out?.cursor) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      if (this._cancelRequested) this.log('Posts range backfill cancelled.', 'info');
    } catch (e) {
      this.log(`Posts range backfill failed: ${isNotConnectedError(e) ? 'Not connected.' : (e?.message || e)}`, 'error');
    } finally {
      this.setBusy(false);
      this.clearOp();
    }
  }

  async refreshPostsSelection() {
    const earliest = this.earliestSelectedIso();
    if (!earliest) return;
    if (this._busy) return;
    this.setBusy(true);
    this._cancelRequested = false;
    this.setOp({ name: 'Refresh', phase: `Posts → ${earliest}`, steps: 0, step: 0, loopsMax: 250, loops: 0, inserted: 0, updated: 0, startedAt: Date.now() });
    try {
      const stopBefore = earliest + 'T00:00:00Z';
      let loops = 0;
      while (loops < 250) {
        if (this._cancelRequested) break;
        let out;
        try {
          out = await call('cacheBackfillMyPosts', {
            pagesMax: this._cfg.postsPagesMax,
            filter: this._cfg.postsFilter || null,
            reset: loops === 0,
            stopBefore,
          });
        } catch (e) {
          const waited = await this.backoffForRateLimit(e, `Refresh posts → ${earliest}`);
          if (waited) continue;
          throw e;
        }
        loops++;
        const inserted = out?.inserted ?? 0;
        const updated = out?.updated ?? 0;
        const stoppedEarly = !!out?.stoppedEarly;
        this.setOp({
          ...this._op,
          loops,
          inserted: (this._op.inserted || 0) + inserted,
          updated: (this._op.updated || 0) + updated,
        });
        this.log(`Refresh posts → ${earliest}: +${inserted} / ~${updated}${stoppedEarly ? ' REACHED' : ''}`, (stoppedEarly) ? 'ok' : 'info');
        this.queueStatusRefresh();
        if (this._cal.month) this._cal.cache.delete(this._cal.month);
        this.loadCalendarMonth(this._cal.month);
        if (stoppedEarly || !out?.cursor) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      if (this._cancelRequested) this.log('Refresh posts cancelled.', 'info');
    } catch (e) {
      this.log(`Refresh posts failed: ${isNotConnectedError(e) ? 'Not connected.' : (e?.message || e)}`, 'error');
    } finally {
      this.setBusy(false);
      this.clearOp();
    }
  }

  async syncNotificationsToSelection() {
    const earliest = this.earliestSelectedIso();
    if (!earliest) return;
    if (this._busy) return;
    const startTs = Date.parse(earliest + 'T00:00:00Z');
    if (!Number.isFinite(startTs)) return;
    // Force deep/backfill mode (not incremental) and allow large windows.
    // We still pass stopBefore for a deterministic cutoff.
    const hours = Math.max(49, Math.ceil((Date.now() - startTs) / 3600000));
    const stopBefore = earliest + 'T00:00:00Z';

    this.setBusy(true);
    this._cancelRequested = false;
    this.setOp({ name: 'Backfill', phase: `Notifications → ${earliest}`, steps: 0, step: 0, loopsMax: 250, loops: 0, inserted: 0, updated: 0, startedAt: Date.now() });
    try {
      let loops = 0;
      while (loops < 250) {
        if (this._cancelRequested) break;
        let out;
        try {
          out = await call('cacheBackfillNotifications', {
            hours,
            pagesMax: this._cfg.notificationsPagesMax,
            reset: loops === 0,
            stopBefore,
          });
        } catch (e) {
          const waited = await this.backoffForRateLimit(e, `Notifications → ${earliest}`);
          if (waited) continue;
          throw e;
        }
        loops++;
        const cursor = out?.cursor;
        const r = out?.result || {};
        const inserted = r?.inserted ?? 0;
        const updated = r?.updated ?? 0;
        const skipped = r?.skipped ?? 0;
        const pages = r?.pages ?? '?';
        const stoppedEarly = !!r?.stoppedEarly;
        const done = !!r?.done || !cursor;
        const cutoffIso = r?.cutoffIso;
        const retentionLimited = !!r?.retentionLimited;
        const oldestSeenIso = r?.oldestSeenIso;
        this.setOp({
          ...this._op,
          loops,
          inserted: (this._op.inserted || 0) + inserted,
          updated: (this._op.updated || 0) + updated,
        });
        this.log(`Notifications → ${earliest}: +${inserted} / ~${updated} / skip ${skipped} (pages ${pages})${cutoffIso ? ` cutoff ${cutoffIso}` : ''}${retentionLimited ? ` RETENTION? (oldest ${oldestSeenIso || '?'})` : ''}${stoppedEarly ? ' REACHED' : ''}${done ? ' DONE' : ''}`, (stoppedEarly || done) ? 'ok' : 'info');
        this.queueStatusRefresh();
        if (this._cal.month) this._cal.cache.delete(this._cal.month);
        this.loadCalendarMonth(this._cal.month);
        if (stoppedEarly || done) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      if (this._cancelRequested) this.log('Notifications range backfill cancelled.', 'info');
    } catch (e) {
      this.log(`Notifications range backfill failed: ${isNotConnectedError(e) ? 'Not connected.' : (e?.message || e)}`, 'error');
    } finally {
      this.setBusy(false);
      this.clearOp();
    }
  }

  async refreshNotificationsSelection() {
    // Same as backfill, but named explicitly for UI clarity.
    return this.syncNotificationsToSelection();
  }

  async runSync(kind) {
    return this._runSync(kind, { internal: false });
  }

  async _runSync(kind, { internal }) {
    if (!internal && this._busy) return;
    if (!internal) {
      this.setBusy(true);
      this._cancelRequested = false;
      this.setOp({ name: 'Sync', phase: `cacheSync(${kind})`, steps: 0, step: 0, loopsMax: 0, loops: 0, inserted: 0, updated: 0, startedAt: Date.now() });
    } else {
      this.setOp({ ...this._op, phase: `cacheSync(${kind})` });
    }
    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) {
        this.log('Not connected. Use the Connect button.', 'error');
        return;
      }

      this.log(`Sync start: ${kind}`);
      const res = await call('cacheSync', {
        kind,
        mode: 'force',
        pagesMax: this._cfg.pagesMax,
        notificationsHours: this._cfg.notificationsHours,
        notificationsPagesMax: this._cfg.notificationsPagesMax,
      });
      this.log(res?.skipped ? 'Sync skipped (recent).' : 'Sync complete.', 'ok');
      await this.refreshStatus();
    } catch (e) {
      this.log(`Sync failed: ${isNotConnectedError(e) ? 'Not connected.' : (e?.message || e)}`, 'error');
    } finally {
      if (!internal) {
        this.setBusy(false);
        this.clearOp();
      }
    }
  }

  async runBackfillPosts(reset = false) {
    return this._runBackfillPosts(reset, { internal: false });
  }

  async _runBackfillPosts(reset = false, { internal }) {
    if (!internal && this._busy) return;
    if (!internal) {
      this.setBusy(true);
      this._cancelRequested = false;
    }
		const loopsMax = 250;
		this.setOp({
			...this._op,
			name: internal ? (this._op.name || 'Import') : 'Backfill',
			phase: internal ? 'Backfill ALL posts' : 'Posts',
			loopsMax,
			loops: 0,
			inserted: 0,
			updated: 0,
			startedAt: this._op.startedAt || Date.now(),
		});
    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) {
        this.log('Not connected. Use the Connect button.', 'error');
        return;
      }

      if (reset) this.log('Resetting posts backfill cursor…');
      let loops = 0;
      while (loops < loopsMax) {
        if (this._cancelRequested) break;
        let out;
        try {
          out = await call('cacheBackfillMyPosts', {
            pagesMax: this._cfg.postsPagesMax,
            filter: this._cfg.postsFilter || null,
            reset: !!reset,
          });
        } catch (e) {
          const waited = await this.backoffForRateLimit(e, 'Posts');
          if (waited) continue;
          throw e;
        }
        loops++;
        reset = false;
        const inserted = out?.inserted ?? 0;
        const updated = out?.updated ?? 0;
        const done = !!out?.done;
			this.setOp({
				...this._op,
				loops,
				inserted: (this._op.inserted || 0) + inserted,
				updated: (this._op.updated || 0) + updated,
			});
        this.log(`Posts backfill: +${inserted} / ~${updated} (pages ${out?.pages ?? '?'})${done ? ' DONE' : ''}`, done ? 'ok' : 'info');
        await this.refreshStatus();
        if (done || !out?.cursor) break;
        await new Promise((r) => setTimeout(r, 250));
      }
			if (this._cancelRequested) this.log('Posts backfill cancelled.', 'info');
    } catch (e) {
      this.log(`Posts backfill failed: ${isNotConnectedError(e) ? 'Not connected.' : (e?.message || e)}`, 'error');
    } finally {
      if (!internal) {
        this.setBusy(false);
        this.clearOp();
      }
    }
  }

  async runBackfillNotifications(reset = false) {
    return this._runBackfillNotifications(reset, { internal: false });
  }

  async _runBackfillNotifications(reset = false, { internal }) {
    if (!internal && this._busy) return;
    if (!internal) {
      this.setBusy(true);
      this._cancelRequested = false;
    }
		const loopsMax = 250;
		this.setOp({
			...this._op,
			name: internal ? (this._op.name || 'Import') : 'Backfill',
			phase: internal ? 'Backfill notifications' : 'Notifications',
			loopsMax,
			loops: 0,
			inserted: 0,
			updated: 0,
			startedAt: this._op.startedAt || Date.now(),
		});
    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) {
        this.log('Not connected. Use the Connect button.', 'error');
        return;
      }

      if (reset) this.log('Resetting notifications backfill cursor…');
      let loops = 0;
      while (loops < loopsMax) {
        if (this._cancelRequested) break;
        let out;
        try {
          out = await call('cacheBackfillNotifications', {
            hours: this._cfg.notificationsHours,
            pagesMax: this._cfg.notificationsPagesMax,
            reset: !!reset,
          });
        } catch (e) {
          const waited = await this.backoffForRateLimit(e, 'Notifications');
          if (waited) continue;
          throw e;
        }
        loops++;
        reset = false;
        const cursor = out?.cursor;
        const r = out?.result || {};
        const inserted = r?.inserted ?? 0;
        const updated = r?.updated ?? 0;
        const skipped = r?.skipped ?? 0;
        const pages = r?.pages ?? '?';
        const stoppedEarly = !!r?.stoppedEarly;
        const done = !!r?.done || !cursor;
      const cutoffIso = r?.cutoffIso;
      const retentionLimited = !!r?.retentionLimited;
      const oldestSeenIso = r?.oldestSeenIso;
			this.setOp({
				...this._op,
				loops,
				inserted: (this._op.inserted || 0) + inserted,
				updated: (this._op.updated || 0) + updated,
			});
        this.log(`Notifications backfill: +${inserted} / ~${updated} / skip ${skipped} (pages ${pages})${cutoffIso ? ` cutoff ${cutoffIso}` : ''}${retentionLimited ? ` RETENTION? (oldest ${oldestSeenIso || '?'})` : ''}${stoppedEarly ? ' REACHED' : ''}${done ? ' DONE' : ''}`, (stoppedEarly || done) ? 'ok' : 'info');
        await this.refreshStatus();
        if (stoppedEarly || done) break;
        await new Promise((r) => setTimeout(r, 250));
      }
			if (this._cancelRequested) this.log('Notifications backfill cancelled.', 'info');
    } catch (e) {
      this.log(`Notifications backfill failed: ${isNotConnectedError(e) ? 'Not connected.' : (e?.message || e)}`, 'error');
    } finally {
      if (!internal) {
        this.setBusy(false);
        this.clearOp();
      }
    }
  }

  async runImportAll() {
    if (this._busy) return;
    this._cancelRequested = false;
    this.setBusy(true);
    this.setOp({ name: 'Import', phase: 'All', steps: 3, step: 0, loopsMax: 0, loops: 0, inserted: 0, updated: 0, startedAt: Date.now() });
    try {
      this.log('Import ALL: starting…');

      this.setOp({ ...this._op, step: 1, phase: 'Sync followers/following + notifications window', loopsMax: 0, loops: 0 });
      await this._runSync('all', { internal: true });
      if (this._cancelRequested) return;

      this.setOp({ ...this._op, step: 2, phase: 'Backfill ALL posts', loopsMax: 0, loops: 0, inserted: 0, updated: 0 });
      await this._runBackfillPosts(false, { internal: true });
      if (this._cancelRequested) return;

      this.setOp({ ...this._op, step: 3, phase: 'Backfill notifications', loopsMax: 0, loops: 0 });
      await this._runBackfillNotifications(false, { internal: true });
      if (this._cancelRequested) return;

      this.log('Import ALL: finished.', 'ok');
    } finally {
      this.setBusy(false);
      this.clearOp();
    }
  }

  onChange(e) {
    const id = e.target?.id;
    if (id === 'pagesMax') this._cfg.pagesMax = clampInt(e.target.value, 1, 200, 200);
    if (id === 'postsPagesMax') this._cfg.postsPagesMax = clampInt(e.target.value, 1, 200, 50);
		if (id === 'postsFilter') this._cfg.postsFilter = (String(e.target.value || '') || null);
		if (id === 'notificationsHours') this._cfg.notificationsHours = clampInt(e.target.value, 1, 24 * 365 * 30, 24 * 90);
    if (id === 'notificationsPagesMax') this._cfg.notificationsPagesMax = clampInt(e.target.value, 1, 60, 60);
    if (id === 'postsStaleHours') this._cfg.postsStaleHours = clampInt(e.target.value, 1, 24 * 365 * 30, 24 * 7);
    if (id === 'notifsStaleHours') this._cfg.notifsStaleHours = clampInt(e.target.value, 1, 24 * 365 * 30, 24 * 7);

    if (id === 'keepDaysPosts') this._maint.keepDaysPosts = clampInt(e.target.value, 1, 3650, this._maint.keepDaysPosts);
    if (id === 'keepDaysNotifs') this._maint.keepDaysNotifs = clampInt(e.target.value, 1, 3650, this._maint.keepDaysNotifs);

    this.savePrefsDebounced();
    this.render();
  }

  downloadText(filename, text, mime = 'text/plain') {
    try {
      const blob = new Blob([String(text ?? '')], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      this.log(`Download failed: ${e?.message || e}`, 'error');
    }
  }

  downloadJson(filename, obj) {
    const txt = JSON.stringify(obj, null, 2);
    this.downloadText(filename, txt, 'application/json');
  }

  async runDbInspect() {
    if (this._busy) return;
    this._maint.inspectLoading = true;
    this._maint.inspectError = null;
    this.render();
    try {
      const res = await call('cacheDbInspect', {});
      this._maint.inspect = res;
      this._maint.inspectError = null;
      this.log('DB inspect: loaded.', 'ok');
    } catch (e) {
      this._maint.inspect = null;
      this._maint.inspectError = e?.message || String(e);
      this.log(`DB inspect failed: ${this._maint.inspectError}`, 'error');
    } finally {
      this._maint.inspectLoading = false;
      this.render();
    }
  }

  async runDbVacuum() {
    if (this._busy) return;
    this.setBusy(true);
    this._cancelRequested = false;
    this.setOp({ name: 'Maintenance', phase: 'VACUUM', steps: 0, step: 0, loopsMax: 0, loops: 0, inserted: 0, updated: 0, startedAt: Date.now() });
    try {
      const res = await call('cacheVacuum', {});
      this._maint.lastResult = res;
      this._maint.lastError = null;
      this.log(`VACUUM complete (${res?.vacuumedAt || 'ok'}).`, 'ok');
      await this.runDbInspect();
    } catch (e) {
      this._maint.lastError = e?.message || String(e);
      this.log(`VACUUM failed: ${this._maint.lastError}`, 'error');
    } finally {
      this.setBusy(false);
      this.clearOp();
    }
  }

  async runDbPrune() {
    if (this._busy) return;
    this.setBusy(true);
    this._cancelRequested = false;
    this.setOp({ name: 'Maintenance', phase: 'Prune', steps: 0, step: 0, loopsMax: 0, loops: 0, inserted: 0, updated: 0, startedAt: Date.now() });
    try {
      const res = await call('cachePrune', { keepDaysPosts: this._maint.keepDaysPosts, keepDaysNotifs: this._maint.keepDaysNotifs });
      this._maint.lastResult = res;
      this._maint.lastError = null;
      this.log(`Prune: posts -${res?.deleted?.posts ?? '?'} notifs -${res?.deleted?.notifications ?? '?'} (oauth_states -${res?.deleted?.oauth_states ?? '?'})`, 'ok');
      this.queueStatusRefresh();
      // Refresh current month view so rings update.
      if (this._cal.month) this._cal.cache.delete(this._cal.month);
      this.loadCalendarMonth(this._cal.month);
      await this.runDbInspect();
    } catch (e) {
      this._maint.lastError = e?.message || String(e);
      this.log(`Prune failed: ${this._maint.lastError}`, 'error');
    } finally {
      this.setBusy(false);
      this.clearOp();
    }
  }

  async exportKind(kind) {
    if (this._busy) return;
    this.setBusy(true);
    this._cancelRequested = false;
    this.setOp({ name: 'Export', phase: kind, steps: 0, step: 0, loopsMax: 0, loops: 0, inserted: 0, updated: 0, startedAt: Date.now() });
    try {
      const res = await call('cacheExport', { kind, format: 'json', limit: 5000, offset: 0 });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      this.downloadJson(`concretesky-${kind}-${ts}.json`, res);
      this.log(`Exported ${kind} (limit ${res?.limit ?? '?'})`, 'ok');
    } catch (e) {
      this.log(`Export failed: ${e?.message || e}`, 'error');
    } finally {
      this.setBusy(false);
      this.clearOp();
    }
  }

  onClick(e) {
    const act = e.target?.getAttribute?.('data-action') || e.target?.closest?.('[data-action]')?.getAttribute?.('data-action');
    if (!act) return;

    const calendarOnly = this.getAttribute('data-view') === 'calendar';

    if (act === 'refresh') { this.refreshStatus(); return; }
    if (act === 'sync-both') { this.runSync('both'); return; }
    if (act === 'sync-all') { this.runSync('all'); return; }
    if (act === 'backfill-posts') { this.runBackfillPosts(false); return; }
    if (act === 'backfill-posts-reset') { this.runBackfillPosts(true); return; }
    if (act === 'backfill-notifs') { this.runBackfillNotifications(false); return; }
    if (act === 'backfill-notifs-reset') { this.runBackfillNotifications(true); return; }
    if (act === 'import-all') { this.runImportAll(); return; }
		if (act === 'cancel') { this.requestCancel(); return; }
    if (act === 'preset-comments') {
      this._cfg.postsFilter = 'posts_with_replies';
      this.render();
      this.runBackfillPosts(false);
      return;
    }
    if (act === 'open-calendar') { this.openCalendar(); return; }
    if (act === 'close-calendar') { if (!calendarOnly) this.closeCalendar(); return; }
    if (act === 'cal-prev') { this.shiftCalendarMonth(-1); return; }
    if (act === 'cal-next') { this.shiftCalendarMonth(1); return; }
    if (act === 'cal-select-month') { this.selectAllInCurrentMonth({ missingOnly: false }); return; }
    if (act === 'cal-select-missing') { this.selectAllInCurrentMonth({ missingOnly: true }); return; }
    if (act === 'cal-select-missing-all') { this.selectMissingSinceJoin(); return; }
    if (act === 'cal-clear') { this.clearSelection(); return; }
    if (act === 'cal-backfill-posts') { this.backfillPostsToSelection(); return; }
    if (act === 'cal-refresh-posts') { this.refreshPostsSelection(); return; }
    if (act === 'cal-sync-notifs') { this.syncNotificationsToSelection(); return; }
    if (act === 'cal-refresh-notifs') { this.refreshNotificationsSelection(); return; }

    if (act === 'db-inspect') { this.runDbInspect(); return; }
    if (act === 'db-vacuum') { this.runDbVacuum(); return; }
    if (act === 'db-prune') { this.runDbPrune(); return; }
    if (act === 'export-posts') { this.exportKind('posts'); return; }
    if (act === 'export-notifications') { this.exportKind('notifications'); return; }
    if (act === 'export-followers') { this.exportKind('followers'); return; }
    if (act === 'export-following') { this.exportKind('following'); return; }

    if (act === 'cal-mode') {
      const m = e.target?.getAttribute?.('data-mode') || e.target?.closest?.('[data-mode]')?.getAttribute?.('data-mode');
      if (m === 'select' || m === 'inspect') {
        this._cal.mode = m;
        this.savePrefsDebounced();
        this.render();
      }
      return;
    }

    if (act === 'cal-clear-day') {
      this._cal.selectedDay = null;
      this._cal.dayError = null;
      this._cal.dayPosts = null;
      this._cal.dayNotifs = null;
      this.savePrefsDebounced();
      this.render();
      return;
    }

    if (act === 'cal-day') {
      const ymd = e.target?.getAttribute?.('data-ymd') || e.target?.closest?.('[data-ymd]')?.getAttribute?.('data-ymd');
      // Shift/meta/ctrl click always toggles selection (so you can select while in Inspect mode).
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        this.toggleSelectedDay(ymd);
        return;
      }

      if (this._cal.mode === 'inspect') {
        this.openCalendarDay(ymd);
        return;
      }

      this.toggleSelectedDay(ymd);
      return;
    }
  }

  render() {
    const d = this._status;
    const ok = !!d?.ok;

    const calendarOnly = this.getAttribute('data-view') === 'calendar';

    const op = this._op || {};
    const hasOp = !!op?.name;
    const stepPct = (op.steps && op.step) ? Math.max(0, Math.min(100, Math.round((op.step / op.steps) * 100))) : 0;
    const loopPct = (op.loopsMax && op.loops) ? Math.max(0, Math.min(100, Math.round((op.loops / op.loopsMax) * 100))) : 0;
    const elapsedSec = op.startedAt ? Math.max(0, Math.floor((Date.now() - op.startedAt) / 1000)) : 0;

    const postsTotal = ok ? d.posts?.cachedTotal : null;
    const posts30d = ok ? d.posts?.cachedLast30d : null;
    const notifsTotal = ok ? d.notifications?.cachedTotal : null;
    const notifs30d = ok ? d.notifications?.cachedLast30d : null;

    const snapFollowers = ok ? d.snapshots?.followers : null;
    const snapFollowing = ok ? d.snapshots?.following : null;

    const createdAt = this._profile?.createdAt || null;
    const accountAge = createdAt ? this.formatAge(createdAt) : '—';
    const lastPostsSyncAt = ok ? (d.lastPostsSyncAt || null) : null;
    const lastNotifsSyncAt = ok ? (d.lastNotificationsSyncAt || null) : null;
    const lastPostsSyncTs = lastPostsSyncAt ? Date.parse(String(lastPostsSyncAt)) : NaN;
    const lastNotifsSyncTs = lastNotifsSyncAt ? Date.parse(String(lastNotifsSyncAt)) : NaN;
    const postsStale = !Number.isFinite(lastPostsSyncTs) ? true : ((Date.now() - lastPostsSyncTs) > (this._cfg.postsStaleHours * 3600000));
    const notifsStale = !Number.isFinite(lastNotifsSyncTs) ? true : ((Date.now() - lastNotifsSyncTs) > (this._cfg.notifsStaleHours * 3600000));
    const postsSyncAge = lastPostsSyncAt ? this.formatAge(lastPostsSyncAt) : '—';
    const notifsSyncAge = lastNotifsSyncAt ? this.formatAge(lastNotifsSyncAt) : '—';

    const month = this._cal.month;
    const calRes = month ? this._cal.cache.get(month) : null;
    const calBounds = month ? this.monthBoundsUtc(month) : null;
    const joinTs = this.parseIso(createdAt);
    const todayTs = Date.now();
    const earliestSel = this.earliestSelectedIso();
    const earliestSelTs = earliestSel ? Date.parse(earliestSel + 'T00:00:00Z') : null;
    const earliestSelHours = (earliestSelTs && Number.isFinite(earliestSelTs)) ? Math.ceil((Date.now() - earliestSelTs) / 3600000) : null;
    const notifsRangeDays = (earliestSelHours !== null) ? Math.floor(earliestSelHours / 24) : null;
    const notifsBeyond90 = (notifsRangeDays !== null) ? (notifsRangeDays > 90) : false;

    const backfillStatusHtml = (() => {
      const bf = ok ? (d?.backfill || null) : null;
      if (!bf) return '';

      const n = bf.notifications || null;
      const p = bf.posts || null;

      const fmtIso = (iso) => {
        const s = String(iso || '').trim();
        return s ? s : '—';
      };

      const coversTarget = (oldestIso, targetIso) => {
        const o = this.parseIso(oldestIso);
        const t = this.parseIso(targetIso);
        if (!o || !t) return null;
        return o <= t;
      };

      const targetEarliest = earliestSel ? (earliestSel + 'T00:00:00Z') : null;

      const lines = [];
      if (n) {
        const cursor = String(n.cursor || '').trim();
        const done = !!n.done;
        const lastStop = String(n.lastStopBefore || '').trim();
        const oldestCached = String(n.oldestCachedIso || '').trim();
        const retentionHint = !!n.retentionHint || !!n.lastRetentionLimited;

        const cov = targetEarliest ? coversTarget(oldestCached, targetEarliest) : null;
        const covTxt = (cov === null) ? '' : (cov ? 'covers earliest selection' : 'does NOT reach earliest selection');

        lines.push([
          'Notifs backfill:',
          done ? 'DONE' : (cursor ? 'more…' : 'unknown'),
          lastStop ? `target ${fmtIso(lastStop)}` : null,
          oldestCached ? `oldest cached ${fmtIso(oldestCached)}` : null,
          retentionHint ? 'RETENTION?' : null,
          covTxt || null,
        ].filter(Boolean).join(' • '));
      }

      if (p) {
        const cursor = String(p.cursor || '').trim();
        const done = !!p.done;
        const lastStop = String(p.lastStopBefore || '').trim();
        const oldestCached = String(p.oldestCachedIso || '').trim();
        const cov = targetEarliest ? coversTarget(oldestCached, targetEarliest) : null;
        const covTxt = (cov === null) ? '' : (cov ? 'covers earliest selection' : 'does NOT reach earliest selection');

        lines.push([
          'Posts backfill:',
          done ? 'DONE' : (cursor ? 'more…' : 'unknown'),
          lastStop ? `target ${fmtIso(lastStop)}` : null,
          oldestCached ? `oldest cached ${fmtIso(oldestCached)}` : null,
          covTxt || null,
        ].filter(Boolean).join(' • '));
      }

      if (!lines.length) return '';
      return `<div class="muted" style="margin-top:6px">${lines.map(esc).join('<br>')}</div>`;
    })();

    let calGridHtml = '<div class="muted">Pick a month…</div>';
    if (calBounds) {
      const daysIn = this.daysInMonthUtc(calBounds.y, calBounds.mo);
      const startDow = new Date(Date.UTC(calBounds.y, calBounds.mo - 1, 1)).getUTCDay(); // 0=Sun
      const postsDays = new Set((calRes?.posts?.days || []).map(Number));
      const notifDays = new Set((calRes?.notifications?.days || []).map(Number));
      const postsCounts = calRes?.posts?.counts || {};
      const notifCounts = calRes?.notifications?.counts || {};
      const postsUpdatedAt = calRes?.posts?.updatedAt || {};
      const notifUpdatedAt = calRes?.notifications?.updatedAt || {};
      const hasData = (day) => postsDays.has(day) || notifDays.has(day);
      const cells = [];
      for (let i = 0; i < startDow; i++) cells.push('<div class="cal-cell blank"></div>');
      for (let day = 1; day <= daysIn; day++) {
        const iso = this.isoDay(calBounds.y, calBounds.mo, day);
        const t = Date.parse(iso + 'T00:00:00Z');
        const beforeJoin = (joinTs && Number.isFinite(joinTs)) ? (t < joinTs) : false;
        const future = t > todayTs;
        const disabled = beforeJoin || future;
        const sel = this._cal.selected.has(iso);

        const hasPosts = postsDays.has(day);
        const hasNotifs = notifDays.has(day);
        const pCount = Number(postsCounts?.[iso] ?? 0);
        const nCount = Number(notifCounts?.[iso] ?? 0);
        const pu = postsUpdatedAt?.[iso] ? Date.parse(String(postsUpdatedAt[iso])) : NaN;
        const nu = notifUpdatedAt?.[iso] ? Date.parse(String(notifUpdatedAt[iso])) : NaN;

        const needsPostsUpdate = disabled ? false : (!hasPosts ? true : (postsStale ? true : (Number.isFinite(pu) && pu > lastPostsSyncTs)));
        const needsNotifsUpdate = disabled ? false : (!hasNotifs ? true : (notifsStale ? true : (Number.isFinite(nu) && nu > lastNotifsSyncTs)));

        // Ring color heuristic:
        // - pre-join/future: grey
        // - missing both: red
        // - one missing: orange
        // - both present: green unless one/both needs update
        let ring = 'green';
        if (disabled) ring = 'pre';
        else if (!hasPosts && !hasNotifs) ring = 'red';
        else if (hasPosts && hasNotifs) ring = (needsPostsUpdate && needsNotifsUpdate) ? 'red' : ((needsPostsUpdate || needsNotifsUpdate) ? 'orange' : 'green');
        else ring = 'orange';

        const state = disabled ? 'disabled' : (hasData(day) ? 'has' : 'missing');
        const tip = [
          iso,
          (hasPosts && hasNotifs) ? 'full' : ((hasPosts || hasNotifs) ? 'partial' : 'missing'),
          `posts ${pCount || 0}`,
          `notifs ${nCount || 0}`,
          disabled ? 'disabled' : ((needsPostsUpdate || needsNotifsUpdate) ? 'needs refresh/backfill' : 'up to date'),
          (this._cal.mode === 'inspect') ? 'click to inspect (shift-click to select)' : 'click to select (shift-click to inspect)',
        ].filter(Boolean).join(' • ');

        cells.push(`
          <button class="cal-cell ${state} ${sel ? 'selected' : ''}" type="button" data-action="cal-day" data-ymd="${esc(iso)}" ${disabled ? 'disabled' : ''} title="${esc(tip)}">
            <span class="ring ${ring}">${esc(day)}</span>
            <span class="counts"><b>P</b>${esc(pCount || 0)} <b>N</b>${esc(nCount || 0)}</span>
          </button>
        `);
      }
      calGridHtml = `<div class="cal-grid">${cells.join('')}</div>`;
    }

    const dayPanel = (() => {
      const day = this._cal.selectedDay;
      if (!day) return '';
      const posts = Array.isArray(this._cal.dayPosts) ? this._cal.dayPosts : [];
      const notifs = Array.isArray(this._cal.dayNotifs) ? this._cal.dayNotifs : [];
      const busy = !!this._cal.dayLoading;
      const err = this._cal.dayError ? `<div class="muted" style="color:#ff9a9a">${esc(this._cal.dayError)}</div>` : '';

      const postRows = posts.slice(0, 200).map((it) => {
        const post = it?.post || {};
        const rec = post?.record || {};
        const uri = post?.uri || it?.uri || '';
        const text = String(rec?.text || '').trim().replace(/\s+/g, ' ').slice(0, 180);
        const when = fmtCompactTime(rec?.createdAt || post?.indexedAt || it?.indexedAt || '');
        const kind = rec?.reply ? 'reply' : (it?.reason?.$type && String(it.reason.$type).includes('Repost') ? 'repost' : 'post');
        const open = atUriToWebPost(uri);
        return `
          <div class="item">
            <div style="min-width:0">
              <div class="it">${esc(kind)}${when ? ` • ${esc(when)}` : ''}</div>
              <div class="is">${text ? esc(text) : '<span class="muted">(no text)</span>'}${open ? ` • <a href="${esc(open)}" target="_blank" rel="noopener">Open</a>` : ''}</div>
            </div>
          </div>
        `;
      }).join('') || '<div class="muted">No cached posts/replies for this day.</div>';

      const notifRows = notifs.slice(0, 250).map((raw) => {
        const n = normalizeCachedNotifRow(raw);
        const a = n.author || {};
        const who = (a.displayName || (a.handle ? '@' + a.handle : '') || a.did || '');
        const when = fmtCompactTime(n.indexedAt || n.createdAt || '');
        const reason = String(n.reason || '').toUpperCase();
        const open = atUriToWebPost(n.reasonSubject);
        return `
          <div class="item">
            <img class="av" src="${esc(a.avatar || '')}" alt="" onerror="this.style.display='none'">
            <div style="min-width:0">
              <div class="it">${esc(who)} <span class="chip">${esc(reason || 'EVENT')}</span>${when ? ` <span class="muted">• ${esc(when)}` : ''}</span></div>
              <div class="is">${esc(String(n.reasonSubject || ''))}${open ? ` • <a href="${esc(open)}" target="_blank" rel="noopener">Open</a>` : ''}</div>
            </div>
          </div>
        `;
      }).join('') || '<div class="muted">No cached notifications for this day.</div>';

      return `
        <div class="daypanel">
          <div class="dayhdr">
            <div class="dayt">${esc(day)} • day details</div>
            <span style="flex:1"></span>
            <button class="btn" type="button" data-action="cal-clear-day">Close day</button>
          </div>
          ${busy ? '<div class="muted">Loading day…</div>' : ''}
          ${err}
          <div class="daycols">
            <div class="daycard"><h4>My posts + replies (${esc(posts.length)})</h4><div class="list">${postRows}</div></div>
            <div class="daycard"><h4>Notifications (${esc(notifs.length)})</h4><div class="list">${notifRows}</div></div>
          </div>
        </div>
      `;
    })();

    const calInner = `
      <div class="dlg-head">
        <div class="dlg-title">Calendar</div>
        <div class="dlg-meta">Account age: ${esc(accountAge)} • Posts sync age: ${esc(postsSyncAge)} • Notifs sync age: ${esc(notifsSyncAge)}</div>
        <span style="flex:1"></span>
        ${calendarOnly ? '' : '<button class="btn" type="button" data-action="close-calendar">Close</button>'}
      </div>

      <div class="cal-toolbar">
        <button class="btn" type="button" data-action="cal-prev">◀</button>
        <div class="cal-month">${esc(month || '')}</div>
        <button class="btn" type="button" data-action="cal-next">▶</button>
        <span style="flex:1"></span>
        <div class="legend"><span class="dot green"></span> ok <span class="dot amber"></span> partial/needs work <span class="dot red"></span> missing</div>
      </div>

      ${this._cal.loading ? '<div class="muted">Loading month…</div>' : ''}
      ${this._cal.error ? `<div class="muted">Error: ${esc(this._cal.error)}</div>` : ''}

      <div class="dow">
        <div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div>
      </div>
      ${calGridHtml}

      <div class="cal-actions">
        <div class="muted">Mode: ${this._cal.mode === 'inspect' ? 'Inspect (click day → details)' : 'Select (click day → toggle)'} • Selected: ${esc(this._cal.selected.size)}${earliestSel ? ` • earliest ${esc(earliestSel)}` : ''}</div>
        <span style="flex:1"></span>
        <button class="btn" type="button" data-action="cal-mode" data-mode="inspect" ${this._cal.mode === 'inspect' ? 'disabled' : ''}>Inspect</button>
        <button class="btn" type="button" data-action="cal-mode" data-mode="select" ${this._cal.mode === 'select' ? 'disabled' : ''}>Select</button>
        <button class="btn" type="button" data-action="cal-select-month">Select month</button>
        <button class="btn" type="button" data-action="cal-select-missing">Select missing</button>
        <button class="btn" type="button" data-action="cal-select-missing-all" ${this._busy ? 'disabled' : ''} title="Scans from your join date through today and selects only missing days">Select missing (since join)</button>
        <button class="btn" type="button" data-action="cal-clear">Clear</button>
      </div>

      <div class="cal-actions">
        <button class="btn primary" type="button" data-action="cal-backfill-posts" ${earliestSel ? '' : 'disabled'}>Fetch posts (to earliest)</button>
        <button class="btn" type="button" data-action="cal-refresh-posts" ${earliestSel ? '' : 'disabled'} title="Rescans from newest down to earliest selected day">Refresh posts (rescan)</button>
        <button class="btn" type="button" data-action="cal-sync-notifs" ${earliestSel ? '' : 'disabled'} title="Backfills notifications until the earliest selected day">Fetch notifications (to earliest)</button>
        <button class="btn" type="button" data-action="cal-refresh-notifs" ${earliestSel ? '' : 'disabled'} title="Rescans notifications from newest down to earliest selected day">Refresh notifications (rescan)</button>
        <button class="btn" type="button" data-action="cancel" ${(!this._busy || this._cancelRequested) ? 'disabled' : ''}>${this._cancelRequested ? 'Cancelling…' : 'Stop'}</button>
      </div>

      ${notifsBeyond90 ? `<div class="muted">Note: selected range is ~${esc(notifsRangeDays)} days. This will attempt to backfill beyond 90d, but Bluesky server retention may limit very old notifications.</div>` : ''}
      ${dayPanel}
    `;

    const calInline = `
      <div class="calBox" role="region" aria-label="Data coverage calendar">
        ${calInner}
      </div>
    `;

    const calModal = `
      <div class="modal" ${this._cal.open ? '' : 'hidden'}>
        <div class="overlay" data-action="close-calendar"></div>
        <div class="dialog" role="dialog" aria-modal="true" aria-label="Data coverage calendar">
          ${calInner}
        </div>
      </div>
    `;

    this.shadowRoot.innerHTML = `
      <style>
        :host, *, *::before, *::after{box-sizing:border-box}
        :host{display:block;color:#fff;font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;}
        .wrap{border:1px solid #2b2b2b;border-radius: var(--bsky-radius, 0px);padding:10px;background:#0b0b0b}
        .row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:10px}
        .title{font-weight:900}
        .muted{color:#aaa}
        .btn{background:#111;border:1px solid #555;color:#fff;padding:8px 10px;border-radius: var(--bsky-radius, 0px);cursor:pointer}
        .btn.primary{background:#1d2a41;border-color:#2f4b7a}
        .btn:disabled{opacity:.6;cursor:not-allowed}
        .grid{display:grid;grid-template-columns:repeat(2, minmax(0,1fr));gap:8px}
        .card{border:1px solid #2b2b2b;border-radius: var(--bsky-radius, 0px);padding:10px;background:#0f0f0f}
        .k{color:#bbb;font-size:.85rem}
        .v{font-weight:900}
        label{display:flex;gap:8px;align-items:center;color:#ddd}
        input{background:#0f0f0f;color:#fff;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:8px 10px;max-width:120px}
        select{background:#0f0f0f;color:#fff;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:8px 10px}
        .log{margin-top:10px;border-top:1px solid #2b2b2b;padding-top:10px;max-height:220px;overflow:auto}
        .line{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;font-size:.85rem;color:#ddd;padding:4px 0;}
        .line[data-kind="error"]{color:#ff9a9a}
        .line[data-kind="ok"]{color:#89f0a2}

      .progress{margin-top:10px;border:1px solid #2b2b2b;border-radius: var(--bsky-radius, 0px);padding:10px;background:#0f0f0f}
      .progress .hdr{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      .progress .name{font-weight:900}
      .progress .meta{color:#aaa;font-size:.9rem}
      progress{width:100%;height:14px;margin-top:8px}
      .small{font-size:.85rem;color:#bbb;margin-top:6px}

        .iconBtn{background:#111;border:1px solid #555;color:#fff;padding:6px 8px;border-radius: var(--bsky-radius, 0px);cursor:pointer}
        .iconBtn:disabled{opacity:.6;cursor:not-allowed}

        .modal{position:fixed;inset:0;z-index:100002}
        .overlay{position:absolute;inset:0;background:rgba(0,0,0,.65)}
        .dialog{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(820px, calc(100vw - 24px));max-height:min(82vh, 820px);overflow:auto;background:#0b0b0b;border:1px solid #2b2b2b;border-radius: var(--bsky-radius, 0px);box-shadow:0 18px 60px rgba(0,0,0,.65);padding:12px}
        .dlg-head{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap}
        .dlg-title{font-weight:900}
        .dlg-meta{color:#aaa;font-size:.9rem}
        .cal-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}
        .cal-month{font-weight:900}
        .legend{display:flex;gap:10px;align-items:center;color:#bbb;font-size:.9rem}
        .dot{display:inline-block;width:10px;height:10px;border-radius:999px;border:2px solid rgba(255,255,255,.25)}
        .dot.green{border-color:#89f0a2}
        .dot.red{border-color:#ff9a9a}
        .dot.amber{border-color:#f3c66c}
        .dow{display:grid;grid-template-columns:repeat(7, minmax(0,1fr));gap:6px;margin-top:10px;color:#bbb;font-size:.85rem}
        .cal-grid{display:grid;grid-template-columns:repeat(7, minmax(0,1fr));gap:6px;margin-top:6px}
        .cal-cell{border:1px solid #2b2b2b;background:#0f0f0f;border-radius: var(--bsky-radius, 0px);min-height:54px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;cursor:pointer;position:relative}
        .cal-cell.blank{border:none;background:transparent;cursor:default}
        .cal-cell.disabled{opacity:.35;cursor:not-allowed}
        .cal-cell.selected{background:#1d2a41;border-color:#2f4b7a}
        .ring{width:28px;height:28px;border-radius:999px;border:3px solid #666;display:flex;align-items:center;justify-content:center;font-weight:900;color:#fff;background:rgba(0,0,0,.2)}
        .ring.green{border-color:#19b34a}
        .ring.orange{border-color:#f59e0b}
        .ring.red{border-color:#ef4444}
        .ring.pre{border-color:#333;color:#888;background:#000}
        .counts{font-size:.72rem;color:#bbb}
        .counts b{color:#eee}
        .cal-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}

        .daypanel{margin-top:12px;border-top:1px solid rgba(255,255,255,.10);padding-top:10px}
        .dayhdr{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
        .dayt{font-weight:900}
        .daycols{display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:10px;margin-top:10px}
        .daycard{border:1px solid #2b2b2b;border-radius: var(--bsky-radius, 0px);padding:10px;background:#0f0f0f}
        .daycard h4{margin:0 0 6px 0}
        .list{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow:auto;padding-right:4px}
        .item{display:flex;gap:8px;align-items:flex-start;border:1px solid #1f1f1f;border-radius: var(--bsky-radius, 0px);padding:6px;background:#101010}
        .it{font-weight:900;color:#ddd}
        .is{font-size:.85rem;color:#bbb;line-height:1.2}
        .av{width:28px;height:28px;border-radius: var(--bsky-radius, 0px);background:#222;object-fit:cover;flex:0 0 auto}
        .chip{background:#1d2a41;color:#cfe5ff;border:1px solid #2f4b7a;border-radius: var(--bsky-radius, 0px);padding:1px 6px;font-size:.72rem;font-weight:900;margin-left:6px}
        a{color:#9cd3ff;text-decoration:none}
        a:hover{text-decoration:underline}

        .calBox{border:1px solid #2b2b2b;border-radius: var(--bsky-radius, 0px);padding:12px;background:#0b0b0b}
      </style>
      ${calendarOnly ? `<div class="wrap">${calInline}</div>` : `
      <div class="wrap">
        <div class="row">
          <div class="title">Database Manager</div>
          <div class="muted">Import Bluesky → local SQLite</div>
          <span style="flex:1"></span>
        <button class="btn" type="button" data-action="refresh" ${this._busy ? 'disabled' : ''}>${this._busy ? 'Working…' : 'Refresh status'}</button>
        <button class="btn" type="button" data-action="cancel" ${(!this._busy || this._cancelRequested) ? 'disabled' : ''}>${this._cancelRequested ? 'Cancelling…' : 'Stop'}</button>
        <button class="btn primary" type="button" data-action="import-all" ${this._busy ? 'disabled' : ''}>Import ALL</button>
        </div>

        ${hasOp ? `
          <div class="progress">
            <div class="hdr">
              <div class="name">${esc(op.name)} ${op.phase ? `• ${esc(op.phase)}` : ''}</div>
              <div class="meta">${this._busy ? 'Running' : 'Idle'}${elapsedSec ? ` • ${esc(elapsedSec)}s` : ''}</div>
            </div>
            ${op.steps ? `<progress max="100" value="${esc(stepPct)}"></progress><div class="small">Step ${esc(op.step)} of ${esc(op.steps)} (${esc(stepPct)}%)</div>` : ''}
            ${(!op.steps && this._busy) ? `<progress></progress><div class="small">Working…</div>` : ''}
            ${op.loopsMax ? `<progress max="100" value="${esc(loopPct)}"></progress><div class="small">Best-effort: ${esc(op.loops)}/${esc(op.loopsMax)} chunks (${esc(loopPct)}%). Inserted +${esc(op.inserted)} • Updated ~${esc(op.updated)}</div>` : ''}
          </div>
        ` : ''}

        ${!ok && d?.error ? `<div class="muted">Error: ${esc(d.error)}</div>` : ''}

        <div class="grid">
          <div class="card">
            <div class="k">Posts cached</div>
            <div class="v">${esc(postsTotal ?? '—')}</div>
            <div class="k">Last 30d</div>
            <div class="v">${esc(posts30d ?? '—')}</div>
          </div>
          <div class="card">
            <div class="k">Notifications cached</div>
            <div class="v">${esc(notifsTotal ?? '—')}</div>
            <div class="k">Last 30d</div>
            <div class="v">${esc(notifs30d ?? '—')}</div>
          </div>
          <div class="card">
            <div class="k">Followers snapshot</div>
            <div class="v">${esc(snapFollowers?.count ?? '—')}</div>
            <div class="k">Synced at</div>
            <div class="v">${esc(snapFollowers?.createdAt ?? '—')}</div>
          </div>
          <div class="card">
            <div class="k">Following snapshot</div>
            <div class="v">${esc(snapFollowing?.count ?? '—')}</div>
            <div class="k">Synced at</div>
            <div class="v">${esc(snapFollowing?.createdAt ?? '—')}</div>
          </div>
        <div class="card">
          <div class="k">Account age</div>
          <div class="v" style="display:flex;gap:10px;align-items:center;justify-content:space-between">
            <span>${esc(accountAge)}</span>
            <button class="iconBtn" type="button" data-action="open-calendar" title="Open calendar">📅</button>
          </div>
          <div class="k">Joined</div>
          <div class="v">${esc(createdAt ?? '—')}</div>
        </div>
        <div class="card">
          <div class="k">Data freshness</div>
          <div class="v">Posts: ${esc(postsSyncAge)}</div>
          <div class="v">Notifs: ${esc(notifsSyncAge)}</div>
          <div class="k">(age since last sync)</div>
        </div>
        </div>

        <div class="row" style="margin-top:10px">
          <label>Followers/following pagesMax <input id="pagesMax" type="number" min="1" max="200" value="${esc(this._cfg.pagesMax)}" ${this._busy ? 'disabled' : ''}></label>
          <label>Posts pagesMax <input id="postsPagesMax" type="number" min="1" max="200" value="${esc(this._cfg.postsPagesMax)}" ${this._busy ? 'disabled' : ''}></label>
        <label>Posts include
          <select id="postsFilter" ${this._busy ? 'disabled' : ''}>
            <option value="" ${!this._cfg.postsFilter ? 'selected' : ''}>Default</option>
            <option value="posts_no_replies" ${this._cfg.postsFilter === 'posts_no_replies' ? 'selected' : ''}>Posts only (no replies)</option>
            <option value="posts_with_replies" ${this._cfg.postsFilter === 'posts_with_replies' ? 'selected' : ''}>Posts + replies (comments)</option>
            <option value="posts_and_author_threads" ${this._cfg.postsFilter === 'posts_and_author_threads' ? 'selected' : ''}>Threads (author posts)</option>
            <option value="posts_with_media" ${this._cfg.postsFilter === 'posts_with_media' ? 'selected' : ''}>Media posts</option>
          </select>
        </label>
          <label>Notifs hours <input id="notificationsHours" type="number" min="1" max="${24 * 365 * 30}" value="${esc(this._cfg.notificationsHours)}" ${this._busy ? 'disabled' : ''}></label>
          <label>Notifs pagesMax <input id="notificationsPagesMax" type="number" min="1" max="60" value="${esc(this._cfg.notificationsPagesMax)}" ${this._busy ? 'disabled' : ''}></label>
          <label>Posts stale hours <input id="postsStaleHours" type="number" min="1" max="${24 * 365 * 30}" value="${esc(this._cfg.postsStaleHours)}" ${this._busy ? 'disabled' : ''}></label>
          <label>Notifs stale hours <input id="notifsStaleHours" type="number" min="1" max="${24 * 365 * 30}" value="${esc(this._cfg.notifsStaleHours)}" ${this._busy ? 'disabled' : ''}></label>
        </div>

        <div class="row">
          <button class="btn primary" type="button" data-action="sync-both" ${this._busy ? 'disabled' : ''}>Sync followers/following</button>
          <button class="btn" type="button" data-action="sync-all" ${this._busy ? 'disabled' : ''}>Sync + notifications window</button>
          <button class="btn" type="button" data-action="backfill-posts" ${this._busy ? 'disabled' : ''}>Backfill ALL posts</button>
				<button class="btn" type="button" data-action="preset-comments" ${this._busy ? 'disabled' : ''}>Backfill comments/replies</button>
          <button class="btn" type="button" data-action="backfill-posts-reset" ${this._busy ? 'disabled' : ''}>Reset + backfill posts</button>
          <button class="btn" type="button" data-action="backfill-notifs" ${this._busy ? 'disabled' : ''}>Backfill notifications</button>
          <button class="btn" type="button" data-action="backfill-notifs-reset" ${this._busy ? 'disabled' : ''}>Reset + backfill notifs</button>
        </div>

        ${backfillStatusHtml}

        <div class="card" style="margin-top:10px">
          <div class="row" style="margin-bottom:8px">
            <div class="title">Maintenance</div>
            <div class="muted">Admin-only: inspect, prune, vacuum, export</div>
            <span style="flex:1"></span>
            <button class="btn" type="button" data-action="db-inspect" ${this._maint.inspectLoading ? 'disabled' : ''}>${this._maint.inspectLoading ? 'Inspecting…' : 'Inspect DB'}</button>
            <button class="btn" type="button" data-action="db-prune" ${this._busy ? 'disabled' : ''}>Prune</button>
            <button class="btn" type="button" data-action="db-vacuum" ${this._busy ? 'disabled' : ''}>VACUUM</button>
          </div>

          <div class="row" style="margin-bottom:8px">
            <label>Keep posts days <input id="keepDaysPosts" type="number" min="1" max="3650" value="${esc(this._maint.keepDaysPosts)}" ${this._busy ? 'disabled' : ''}></label>
            <label>Keep notifs days <input id="keepDaysNotifs" type="number" min="1" max="3650" value="${esc(this._maint.keepDaysNotifs)}" ${this._busy ? 'disabled' : ''}></label>
            <span style="flex:1"></span>
            <button class="btn" type="button" data-action="export-posts" ${this._busy ? 'disabled' : ''}>Export posts (JSON)</button>
            <button class="btn" type="button" data-action="export-notifications" ${this._busy ? 'disabled' : ''}>Export notifications (JSON)</button>
            <button class="btn" type="button" data-action="export-followers" ${this._busy ? 'disabled' : ''}>Export followers (JSON)</button>
            <button class="btn" type="button" data-action="export-following" ${this._busy ? 'disabled' : ''}>Export following (JSON)</button>
          </div>

          ${this._maint.inspectError ? `<div class="muted" style="color:#ff9a9a">Inspect error: ${esc(this._maint.inspectError)}</div>` : ''}
          ${this._maint.inspect ? `
            <div class="muted">DB: ${esc(this._maint.inspect.path || '')} • size ${(this._maint.inspect.sizeBytes ?? null) !== null ? esc(Math.round((this._maint.inspect.sizeBytes || 0) / 1024 / 1024) + ' MB') : '—'} • journal ${esc(this._maint.inspect.journalMode || '—')} • sqlite ${esc(this._maint.inspect.sqliteVersion || '—')}</div>
            <div class="muted">Schema: ${esc(this._maint.inspect.cacheSchemaVersion || '—')} (expected ${esc(this._maint.inspect.cacheSchemaExpected || '—')}) • last vacuum: ${esc(this._maint.inspect.lastVacuumAt || '—')}</div>
            <div class="muted">Table bytes: ${(() => {
              const ok = (typeof this._maint.inspect.dbstatAvailable === 'boolean') ? this._maint.inspect.dbstatAvailable : null;
              if (ok === false) return 'dbstat unavailable (size per table disabled)';
              const tot = (this._maint.inspect.tablesTotalBytesApprox ?? null);
              if (typeof tot === 'number') return Math.round(tot / 1024 / 1024) + ' MB (approx)';
              if (ok === true) return 'enabled';
              return 'unknown';
            })()}</div>
            <div class="muted">FTS: ${(() => {
              const f = this._maint.inspect.fts || {};
              const fts5 = (typeof f.fts5Enabled === 'boolean') ? f.fts5Enabled : null;
              const exists = (typeof f.postsFtsExists === 'boolean') ? f.postsFtsExists : null;
              const ok = (typeof f.postsFtsOperational === 'boolean') ? f.postsFtsOperational : null;
              if (ok === true) return 'posts_fts ON';
              if (ok === false) return 'posts_fts ERROR';
              if (exists === true) return 'posts_fts present';
              if (exists === false) return (fts5 === false) ? 'unavailable' : 'not enabled';
              if (fts5 === false) return 'unavailable';
              return 'unknown';
            })()}</div>

            <div class="muted" style="margin-top:8px">Tables:</div>
            <div class="muted" style="font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; white-space:pre; overflow:auto; max-height:220px; border:1px solid rgba(255,255,255,.08); padding:8px; border-radius:8px">
${(() => {
  const fmtBytes = (b) => {
    if (typeof b !== 'number' || !isFinite(b)) return '—';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
    return (b / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  };

  const rows = Array.isArray(this._maint.inspect.tables) ? this._maint.inspect.tables.slice() : [];
  rows.sort((a, b) => {
    const ab = (a?.approxBytes ?? null);
    const bb = (b?.approxBytes ?? null);
    if (typeof ab === 'number' && typeof bb === 'number') return bb - ab;
    if (typeof ab === 'number') return -1;
    if (typeof bb === 'number') return 1;
    const ar = (a?.rows ?? null);
    const br = (b?.rows ?? null);
    if (typeof ar === 'number' && typeof br === 'number') return br - ar;
    return String(a?.name || '').localeCompare(String(b?.name || ''));
  });

  if (!rows.length) return esc('—');

  const header = 'name                           rows        approx     oldest                      newest\n' +
                 '----------------------------------------------------------------------------------------';
  const lines = rows.map((t) => {
    const name = String(t?.name || '').padEnd(30, ' ');
    const r = (typeof t?.rows === 'number') ? String(t.rows).padStart(10, ' ') : '         —';
    const sz = fmtBytes(t?.approxBytes).padStart(10, ' ');
    const oldest = String(t?.oldest || '—').padEnd(26, ' ');
    const newest = String(t?.newest || '—');
    return `${name} ${r} ${sz} ${oldest} ${newest}`;
  });

  return esc([header].concat(lines).join('\n'));
})()}
            </div>

            <div class="muted" style="margin-top:8px">Indexes: ${(() => {
              const idx = Array.isArray(this._maint.inspect.indexes) ? this._maint.inspect.indexes : [];
              if (!idx.length) return '—';
              return idx.length;
            })()}</div>
          ` : ''}
        </div>

        <div class="log">
          ${this._log.length ? this._log.map((l) => `<div class="line" data-kind="${esc(l.kind)}">[${esc(l.ts)}] ${esc(l.msg)}</div>`).join('') : '<div class="muted">No activity yet.</div>'}
        </div>
      </div>
			${calModal}
      `}
    `;

		if (calendarOnly || this._cal.open) this.queueStatusRefresh();
  }
}

customElements.define('bsky-db-manager', BskyDbManager);
