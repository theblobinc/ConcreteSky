import { call } from '../../../api.js';
import { getAuthStatusCached, isNotConnectedError } from '../../../auth_state.js';

const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));

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
    };

    this._profile = null; // { did, handle, displayName, createdAt }

    this._cal = {
      open: false,
      month: null, // YYYY-MM
      cache: new Map(),
      loading: false,
      error: null,
      selected: new Set(), // YYYY-MM-DD
    };

    this._queued = new Map();
    this._queueTimer = null;
  }

  connectedCallback() {
    this.render();
    this.refreshStatus();
		this.refreshProfile();
    this.shadowRoot.addEventListener('click', (e) => this.onClick(e));
    this.shadowRoot.addEventListener('change', (e) => this.onChange(e));
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
    this.render();
  }

  closeCalendar() {
    this._cal.open = false;
    this.render();
  }

  shiftCalendarMonth(delta) {
    const b = this.monthBoundsUtc(this._cal.month);
    if (!b) return;
    const d = new Date(Date.UTC(b.y, b.mo - 1 + delta, 1));
    this._cal.month = this.monthKey(d);
    this.loadCalendarMonth(this._cal.month);
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
      this.setBusy(false);
      this.clearOp();
    }
  }

  toggleSelectedDay(ymd) {
    if (!ymd) return;
    if (this._cal.selected.has(ymd)) this._cal.selected.delete(ymd);
    else this._cal.selected.add(ymd);
    this.render();
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
    this.render();
  }

  clearSelection() {
    this._cal.selected.clear();
    this.render();
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
        loops++;
        const out = await call('cacheBackfillMyPosts', {
          pagesMax: this._cfg.postsPagesMax,
          filter: this._cfg.postsFilter || null,
          reset: false,
          stopBefore,
        });
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
        loops++;
        const out = await call('cacheBackfillMyPosts', {
          pagesMax: this._cfg.postsPagesMax,
          filter: this._cfg.postsFilter || null,
          reset: loops === 1,
          stopBefore,
        });
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
        loops++;
        const out = await call('cacheBackfillNotifications', {
          hours,
          pagesMax: this._cfg.notificationsPagesMax,
          reset: loops === 1,
          stopBefore,
        });
        const cursor = out?.cursor;
        this.setOp({ ...this._op, loops });
        const stoppedEarly = !!out?.result?.stoppedEarly;
        this.log(`Notifications → ${earliest}: pagesMax ${this._cfg.notificationsPagesMax}${stoppedEarly ? ' REACHED' : ''}${cursor ? ' (more…) ' : ' DONE'}`, (stoppedEarly || !cursor) ? 'ok' : 'info');
        this.queueStatusRefresh();
        if (this._cal.month) this._cal.cache.delete(this._cal.month);
        this.loadCalendarMonth(this._cal.month);
        if (stoppedEarly || !cursor) break;
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
        loops++;
        const out = await call('cacheBackfillMyPosts', {
          pagesMax: this._cfg.postsPagesMax,
          filter: this._cfg.postsFilter || null,
          reset: !!reset,
        });
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
        loops++;
        const out = await call('cacheBackfillNotifications', {
          hours: this._cfg.notificationsHours,
          pagesMax: this._cfg.notificationsPagesMax,
          reset: !!reset,
        });
        reset = false;
        const cursor = out?.cursor;
			this.setOp({
				...this._op,
				loops,
			});
        this.log(`Notifications backfill: pagesMax ${this._cfg.notificationsPagesMax}${cursor ? ' (more…)' : ' DONE'}`, cursor ? 'info' : 'ok');
        await this.refreshStatus();
        if (!cursor) break;
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
    this.render();
  }

  onClick(e) {
    const act = e.target?.getAttribute?.('data-action') || e.target?.closest?.('[data-action]')?.getAttribute?.('data-action');
    if (!act) return;

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
    if (act === 'close-calendar') { this.closeCalendar(); return; }
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

    if (act === 'cal-day') {
      const ymd = e.target?.getAttribute?.('data-ymd') || e.target?.closest?.('[data-ymd]')?.getAttribute?.('data-ymd');
      this.toggleSelectedDay(ymd);
      return;
    }
  }

  render() {
    const d = this._status;
    const ok = !!d?.ok;

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

    let calGridHtml = '<div class="muted">Pick a month…</div>';
    if (calBounds) {
      const daysIn = this.daysInMonthUtc(calBounds.y, calBounds.mo);
      const startDow = new Date(Date.UTC(calBounds.y, calBounds.mo - 1, 1)).getUTCDay(); // 0=Sun
      const postsDays = new Set((calRes?.posts?.days || []).map(Number));
      const notifDays = new Set((calRes?.notifications?.days || []).map(Number));
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
        const state = disabled ? 'disabled' : (hasData(day) ? 'has' : 'missing');

        const pu = postsUpdatedAt?.[iso] || null;
        const nu = notifUpdatedAt?.[iso] || null;
        const lastU = nu || pu || null;
        const ageH = lastU ? this.ageHours(lastU) : null;
        // Staleness policy (can be tuned): mark stale if last ingestion for the day is > 7 days old.
        const stale = (ageH !== null) ? (ageH > (24 * 7)) : false;
        const tip = [
          iso,
          hasData(day) ? 'have data' : 'missing',
          lastU ? `last ingested ${this.formatAge(lastU)} ago` : '',
          stale ? 'stale' : '',
        ].filter(Boolean).join(' • ');
        cells.push(`
          <button class="cal-cell ${state} ${stale ? 'stale' : ''} ${sel ? 'selected' : ''}" type="button" data-action="cal-day" data-ymd="${esc(iso)}" ${disabled ? 'disabled' : ''} title="${esc(tip)}">
            <span class="num">${esc(day)}</span>
          </button>
        `);
      }
      calGridHtml = `<div class="cal-grid">${cells.join('')}</div>`;
    }

    const calModal = `
      <div class="modal" ${this._cal.open ? '' : 'hidden'}>
        <div class="overlay" data-action="close-calendar"></div>
        <div class="dialog" role="dialog" aria-modal="true" aria-label="Data coverage calendar">
          <div class="dlg-head">
            <div class="dlg-title">Calendar</div>
            <div class="dlg-meta">Account age: ${esc(accountAge)} • Posts sync age: ${esc(postsSyncAge)} • Notifs sync age: ${esc(notifsSyncAge)}</div>
            <span style="flex:1"></span>
            <button class="btn" type="button" data-action="close-calendar">Close</button>
          </div>

          <div class="cal-toolbar">
            <button class="btn" type="button" data-action="cal-prev">◀</button>
            <div class="cal-month">${esc(month || '')}</div>
            <button class="btn" type="button" data-action="cal-next">▶</button>
            <span style="flex:1"></span>
            <div class="legend"><span class="dot green"></span> have data <span class="dot red"></span> missing <span class="dot amber"></span> stale</div>
          </div>

          ${this._cal.loading ? '<div class="muted">Loading month…</div>' : ''}
          ${this._cal.error ? `<div class="muted">Error: ${esc(this._cal.error)}</div>` : ''}

          <div class="dow">
            <div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div>
          </div>
          ${calGridHtml}

          <div class="cal-actions">
            <div class="muted">Selected: ${esc(this._cal.selected.size)}${earliestSel ? ` • earliest ${esc(earliestSel)}` : ''}</div>
            <span style="flex:1"></span>
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

        .modal{position:fixed;inset:0;z-index:100000}
        .overlay{position:absolute;inset:0;background:rgba(0,0,0,.65)}
        .dialog{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(820px, calc(100vw - 24px));max-height:min(82vh, 820px);overflow:auto;background:#0b0b0b;border:1px solid #2b2b2b;border-radius: var(--bsky-radius, 0px);box-shadow:0 18px 60px rgba(0,0,0,.65);padding:12px}
        .dlg-head{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap}
        .dlg-title{font-weight:900}
        .dlg-meta{color:#aaa;font-size:.9rem}
        .cal-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}
        .cal-month{font-weight:900}
        .legend{display:flex;gap:10px;align-items:center;color:#bbb;font-size:.9rem}
        .dot{display:inline-block;width:10px;height:10px;border-radius: var(--bsky-radius, 0px)}
        .dot.green{border:2px solid #89f0a2}
        .dot.red{border:2px solid #ff9a9a}
        .dot.amber{border:2px solid #f3c66c}
        .dow{display:grid;grid-template-columns:repeat(7, minmax(0,1fr));gap:6px;margin-top:10px;color:#bbb;font-size:.85rem}
        .cal-grid{display:grid;grid-template-columns:repeat(7, minmax(0,1fr));gap:6px;margin-top:6px}
        .cal-cell{border:1px solid #2b2b2b;background:#0f0f0f;border-radius: var(--bsky-radius, 0px);min-height:44px;display:flex;align-items:center;justify-content:center;cursor:pointer;position:relative}
        .cal-cell.blank{border:none;background:transparent;cursor:default}
        .cal-cell.disabled{opacity:.35;cursor:not-allowed}
        .cal-cell.has::after{content:'';position:absolute;inset:6px;border-radius: var(--bsky-radius, 0px);border:2px solid #89f0a2;pointer-events:none}
        .cal-cell.missing::after{content:'';position:absolute;inset:6px;border-radius: var(--bsky-radius, 0px);border:2px solid #ff9a9a;pointer-events:none}
        .cal-cell.stale::before{content:'';position:absolute;right:8px;top:8px;width:8px;height:8px;border-radius: var(--bsky-radius, 0px);background:#f3c66c;}
        .cal-cell.selected{background:#1d2a41;border-color:#2f4b7a}
        .num{font-weight:900;color:#fff}
        .cal-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}
      </style>
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

        <div class="log">
          ${this._log.length ? this._log.map((l) => `<div class="line" data-kind="${esc(l.kind)}">[${esc(l.ts)}] ${esc(l.msg)}</div>`).join('') : '<div class="muted">No activity yet.</div>'}
        </div>
      </div>
			${calModal}
    `;

		if (this._cal.open) this.queueStatusRefresh();
  }
}

customElements.define('bsky-db-manager', BskyDbManager);
