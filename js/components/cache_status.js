import { call } from '../api.js';
import { getAuthStatusCached, isNotConnectedError } from '../auth_state.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString();
  } catch {
    return String(iso);
  }
}

function fmtAge(iso) {
  if (!iso) return '';
  try {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '';
    const mins = Math.floor(ms / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 48) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 14) return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 10) return `${weeks}w ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  } catch {
    return '';
  }
}

class BskyCacheStatus extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._busy = false;
    this._data = null;

    this._autoEnabled = true;
    this._autoPeriodSec = 60;
    this._lookbackMinutes = 2;
    this._nextRefreshAt = Date.now() + (this._autoPeriodSec * 1000);
    this._timer = null;
  }

  connectedCallback() {
    this.render();
    this.refresh();
    this.startTimer();

    this._authChangedHandler = () => {
      this.refresh();
    };
    window.addEventListener('bsky-auth-changed', this._authChangedHandler);
  }

  disconnectedCallback() {
    this.stopTimer();
    if (this._authChangedHandler) window.removeEventListener('bsky-auth-changed', this._authChangedHandler);
  }

  startTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => this.tickTimer(), 1000);
    this.tickTimer();
  }

  stopTimer() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  formatCountdown(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  tickTimer() {
    const el = this.shadowRoot?.querySelector('[data-countdown]');
    const ms = this._nextRefreshAt - Date.now();
    if (el) el.textContent = this.formatCountdown(ms);

    if (!this._autoEnabled) return;
    if (ms > 0) return;

    // Fire and reset.
    this.syncRecentThenDispatch(this._lookbackMinutes);
    this._nextRefreshAt = Date.now() + (this._autoPeriodSec * 1000);
  }

  async syncRecentThenDispatch(minutes) {
    if (this._busy) return;
    const mins = Math.max(1, Number(minutes || 2));

    try {
      const auth = await getAuthStatusCached();
      if (auth && !auth.connected) {
        // Not connected; don't attempt server sync.
        return;
      }
      await call('cacheSyncRecent', { minutes: mins });
    } catch (e) {
      // If not connected/logged in yet, or endpoint not available,
      // still dispatch so panels can decide what to do.
      console.warn('cacheSyncRecent failed', e);
    }

    try {
      window.dispatchEvent(new CustomEvent('bsky-refresh-recent', {
        detail: { minutes: mins }
      }));
      this.flash(`Refreshing last ${mins} minutes…`);
    } catch (e) {
      this.flash(`Auto refresh failed: ${e?.message || e}`, true);
    }
  }

  setBusy(v) {
    this._busy = !!v;
    this.render();
  }

  async refresh() {
    if (this._busy) return;
    this.setBusy(true);
    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) {
        this._data = { ok: false, error: 'Not connected. Use the Connect button.' };
        return;
      }
      this._data = await call('cacheStatus', {});
    } catch (e) {
      this._data = { ok: false, error: isNotConnectedError(e) ? 'Not connected. Use the Connect button.' : (e?.message || String(e)) };
    } finally {
      this.setBusy(false);
    }
  }

  async sync(kind) {
    if (this._busy) return;
    this.setBusy(true);
    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) {
        this.flash('Not connected. Use the Connect button.', true);
        return;
      }
      const res = await call('cacheSync', { kind, mode: 'force', pagesMax: 50, notificationsHours: 720, notificationsPagesMax: 30 });
      this._data = await call('cacheStatus', {});
      this.flash(res?.skipped ? 'Sync skipped (recent).' : 'Sync complete.');
    } catch (e) {
      this.flash(`Sync failed: ${isNotConnectedError(e) ? 'Not connected. Use the Connect button.' : (e?.message || e)}`, true);
    } finally {
      this.setBusy(false);
    }
  }

  flash(msg, isError = false) {
    const el = this.shadowRoot?.querySelector('.flash');
    if (!el) return;
    el.textContent = msg;
    el.dataset.kind = isError ? 'error' : 'ok';
    el.hidden = false;
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => {
      el.hidden = true;
    }, 3500);
  }

  render() {
    const compact = this.hasAttribute('data-compact') || this.hasAttribute('compact');
    const summary = this.hasAttribute('data-summary') || this.hasAttribute('summary');

    const d = this._data;
    const ok = d && d.ok;

    const lastSyncAt = ok ? d.lastSyncAt : null;
    const lastNotifAt = ok ? d.lastNotificationsSyncAt : null;
    const lastNotifSeenAt = ok ? d.lastNotificationsSeenAt : null;

    const lastPostsAt = ok ? d.lastPostsSyncAt : null;
    const lastPostsSeenAt = ok ? d.lastPostsSeenAt : null;

    const followers = ok ? d.snapshots?.followers : null;
    const following = ok ? d.snapshots?.following : null;

    const diffFollowers = ok ? d.diff?.followers : null;
    const diffFollowing = ok ? d.diff?.following : null;

    const nCounts = ok ? d.notifications : null;
    const pCounts = ok ? d.posts : null;

    const header = summary ? '' : (compact ? `
      <div class="row compact">
        <div class="title">Cache</div>
        <div class="muted">${ok ? 'SQLite status + diffs' : 'Loading…'}</div>

        <span class="pill">Auto: <strong data-countdown>—</strong></span>
        <button class="btn" type="button" data-action="toggle-auto" ${this._busy ? 'disabled' : ''}>
          ${this._autoEnabled ? 'Pause' : 'Resume'}
        </button>

        <button class="btn" type="button" data-action="refresh-recent" ${this._busy ? 'disabled' : ''}>
          Refresh ${esc(this._lookbackMinutes)}m
        </button>
        <button class="btn" type="button" data-action="refresh" ${this._busy ? 'disabled' : ''}>
          ${this._busy ? '<span class="spinner" aria-hidden="true"></span>' : ''}
          Refresh status
        </button>

        <button class="btn primary" type="button" data-action="sync-both" ${this._busy ? 'disabled' : ''}>Sync followers/following</button>
        <button class="btn" type="button" data-action="sync-all" ${this._busy ? 'disabled' : ''}>Sync + notifications</button>

        <button class="btn" type="button" data-action="backfill-notifs" ${this._busy ? 'disabled' : ''}>Backfill notifs 30d</button>
      </div>
    ` : `
      <div class="row">
        <div class="title">Cache</div>
        <div class="muted">${ok ? 'SQLite status + diffs' : 'Loading…'}</div>
        <div class="countdown">
          <span class="pill">Auto refresh: <strong data-countdown>—</strong></span>
          <button class="btn" type="button" data-action="toggle-auto" ${this._busy ? 'disabled' : ''}>
            ${this._autoEnabled ? 'Pause' : 'Resume'}
          </button>
          <button class="btn" type="button" data-action="refresh-recent" ${this._busy ? 'disabled' : ''}>
            Refresh last ${esc(this._lookbackMinutes)}m
          </button>
        </div>
        <span style="flex:1"></span>
        <button class="btn" type="button" data-action="refresh" ${this._busy ? 'disabled' : ''}>
          ${this._busy ? '<span class="spinner" aria-hidden="true"></span>' : ''}
          Refresh
        </button>
        <button class="btn primary" type="button" data-action="sync-both" ${this._busy ? 'disabled' : ''}>Sync followers/following</button>
        <button class="btn" type="button" data-action="sync-all" ${this._busy ? 'disabled' : ''}>Sync + notifications</button>
        <button class="btn" type="button" data-action="backfill-notifs" ${this._busy ? 'disabled' : ''}>Backfill notifs 30d</button>
      </div>
    `);

    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block;margin-bottom:${(compact || summary) ? '0' : '16px'}}
        .card{background:#0b0b0b;border:1px solid #333;border-radius:10px;padding:${compact ? '8px' : '10px'};color:#fff}
        .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
        .row.compact{display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:8px;align-items:stretch}
        .row.compact .title{grid-column:1/-1}
        .row.compact .muted{grid-column:1/-1}
        .row.compact .pill{grid-column:1/2}
        .row.compact .btn{width:100%}
        .title{font-weight:800}
        .muted{color:#bbb}
        .countdown{display:inline-flex;gap:8px;align-items:center}
        /* Always 2 columns (fits 350px mobile) */
        .grid{display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:10px;margin-top:10px}
        .box{border:1px solid #222;border-radius:10px;padding:10px;background:#090909}
        .k{font-size:.85rem;color:#aaa}
        .v{font-weight:700;margin-top:2px}
        .pill{display:inline-flex;gap:6px;align-items:center;border:1px solid #222;border-radius:999px;padding:4px 10px;background:#111;color:#ddd;font-size:.9rem}
        .btn{appearance:none;border:1px solid #333;background:#111;color:#fff;border-radius:999px;padding:8px 12px;font-weight:700;cursor:pointer}
        .btn[disabled]{opacity:.6;cursor:not-allowed}
        .btn.primary{background:#1d2a41;border-color:#2f4b7a}
        .flash{margin-top:10px;border-radius:10px;padding:8px 10px;font-weight:700}
        .flash[data-kind="ok"]{background:#0f1d12;border:1px solid #2a6b3a;color:#bff2c8}
        .flash[data-kind="error"]{background:#2a0f10;border:1px solid #6b2a2a;color:#ffc7c7}
        .spinner{display:inline-block;width:12px;height:12px;border:2px solid #555;border-top-color:#fff;border-radius:50%;animation:spin .9s linear infinite}
        @keyframes spin{to{transform:rotate(360deg)}}
      </style>
      <div class="card">
        ${header}

        ${!d ? '' : (!ok ? `<div class="flash" data-kind="error">${esc(d.error || 'Failed to load cache status')}</div>` : '')}

        <div class="grid">
          <div class="box">
            <div class="k">Last sync</div>
            <div class="v">${esc(fmtDate(lastSyncAt))}</div>
            <div class="muted">${esc(fmtAge(lastSyncAt))}</div>
          </div>
          <div class="box">
            <div class="k">Followers snapshot</div>
            <div class="v">${followers ? `${esc(followers.count)} people` : '—'}</div>
            <div class="muted">${followers ? `#${esc(followers.id)} · ${esc(fmtAge(followers.takenAt))}` : ''}</div>
            <div style="margin-top:6px" class="pill">Δ +${esc(diffFollowers?.counts?.added ?? 0)} / -${esc(diffFollowers?.counts?.removed ?? 0)}</div>
          </div>
          <div class="box">
            <div class="k">Following snapshot</div>
            <div class="v">${following ? `${esc(following.count)} people` : '—'}</div>
            <div class="muted">${following ? `#${esc(following.id)} · ${esc(fmtAge(following.takenAt))}` : ''}</div>
            <div style="margin-top:6px" class="pill">Δ +${esc(diffFollowing?.counts?.added ?? 0)} / -${esc(diffFollowing?.counts?.removed ?? 0)}</div>
          </div>
          <div class="box">
            <div class="k">Notifications cached</div>
            <div class="v">${nCounts ? esc(nCounts.cachedTotal) : '—'}</div>
            <div class="muted">${lastNotifAt ? `Last notif sync: ${esc(fmtAge(lastNotifAt))}` : 'Not synced yet'}</div>
            <div class="muted">${lastNotifSeenAt ? `Last notif seen: ${esc(fmtAge(lastNotifSeenAt))}` : ''}</div>
            <div style="margin-top:6px" class="pill">Last 30d: ${esc(nCounts?.cachedLast30d ?? 0)}</div>
          </div>

          <div class="box">
            <div class="k">Posts cached</div>
            <div class="v">${pCounts ? esc(pCounts.cachedTotal) : '—'}</div>
            <div class="muted">${lastPostsAt ? `Last posts sync: ${esc(fmtAge(lastPostsAt))}` : 'Not synced yet'}</div>
            <div class="muted">${lastPostsSeenAt ? `Last post seen: ${esc(fmtAge(lastPostsSeenAt))}` : ''}</div>
            <div style="margin-top:6px" class="pill">Last 30d: ${esc(pCounts?.cachedLast30d ?? 0)}</div>
          </div>
        </div>

        <div class="flash" hidden></div>
      </div>
    `;

    const btnRefresh = this.shadowRoot.querySelector('[data-action="refresh"]');
    if (btnRefresh) btnRefresh.addEventListener('click', () => this.refresh());
    const btnSyncBoth = this.shadowRoot.querySelector('[data-action="sync-both"]');
    if (btnSyncBoth) btnSyncBoth.addEventListener('click', () => this.sync('both'));
    const btnSyncAll = this.shadowRoot.querySelector('[data-action="sync-all"]');
    if (btnSyncAll) btnSyncAll.addEventListener('click', () => this.sync('all'));

    const btnBackfill = this.shadowRoot.querySelector('[data-action="backfill-notifs"]');
    if (btnBackfill) btnBackfill.addEventListener('click', () => this.backfillNotifications());

    const btnToggleAuto = this.shadowRoot.querySelector('[data-action="toggle-auto"]');
    if (btnToggleAuto) btnToggleAuto.addEventListener('click', () => {
      this._autoEnabled = !this._autoEnabled;
      if (this._autoEnabled) {
        this._nextRefreshAt = Date.now() + (this._autoPeriodSec * 1000);
      }
      this.render();
    });

    const btnRefreshRecent = this.shadowRoot.querySelector('[data-action="refresh-recent"]');
    if (btnRefreshRecent) btnRefreshRecent.addEventListener('click', () => {
      this.syncRecentThenDispatch(this._lookbackMinutes);
      this._nextRefreshAt = Date.now() + (this._autoPeriodSec * 1000);
      this.tickTimer();
    });

    this.tickTimer();
  }

  async backfillNotifications(){
    if (this._busy) return;
    this.setBusy(true);
    try {
      const res = await call('cacheBackfillNotifications', { hours: 24 * 30, pagesMax: 30 });
      this._data = await call('cacheStatus', {});
      const cur = (res && typeof res.cursor === 'string' && res.cursor.length) ? ' (more remaining)' : '';
      this.flash('Notifications backfill synced' + cur + '.');
    } catch (e) {
      this.flash(`Backfill failed: ${e?.message || e}`, true);
    } finally {
      this.setBusy(false);
    }
  }
}

customElements.define('bsky-cache-status', BskyCacheStatus);
