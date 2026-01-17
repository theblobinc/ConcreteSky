import { call } from '../../../api.js';
import { getAuthStatusCached, isNotConnectedError } from '../../../auth_state.js';
import { bindAuthControls } from '../../../auth_controls.js';
import { identityCss, identityHtml, bindCopyClicks } from '../../../lib/identity.js';
import { createSearchSpec, dispatchSearchChanged } from '../../../search/search_bus.js';
import { SEARCH_TARGETS } from '../../../search/constants.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) =>
  ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[m])
);

function monthKeyUtc(d = new Date()) {
  try {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

function monthBoundsUtc(month) {
  const m = String(month || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return null;
  const start = new Date(Date.UTC(y, mo - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(y, mo, 1, 0, 0, 0));
  return { start, end, y, mo };
}

function daysInMonthUtc(y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function isoDay(y, mo, day) {
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shiftMonthKey(month, delta) {
  const b = monthBoundsUtc(month);
  if (!b) return monthKeyUtc();
  const d = new Date(Date.UTC(b.y, b.mo - 1 + Number(delta || 0), 1, 0, 0, 0));
  return monthKeyUtc(d);
}

// Convert at://did/app.bsky.feed.post/rkey → https://bsky.app/profile/did/post/rkey
function atUriToWebPost(uri) {
  const m = String(uri || '').match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)/);
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : '';
}

function dayStartIso(ymd) {
  return `${String(ymd)}T00:00:00Z`;
}

function dayEndIso(ymd) {
  return `${String(ymd)}T23:59:59Z`;
}

function normalizeCachedNotifRow(n) {
  const base = (n && typeof n === 'object') ? n : {};
  const a = (base.author && typeof base.author === 'object') ? base.author : {};
  const did = a.did || base.authorDid || base.author_did || '';
  const handle = a.handle || base.authorHandle || base.author_handle || '';
  const displayName = a.displayName || base.authorDisplayName || base.author_display_name || '';
  const avatar = a.avatar || base.authorAvatar || base.author_avatar || '';
  return {
    ...base,
    author: { ...a, did, handle, displayName, avatar },
  };
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

function ensureHudCacheCalendarModal() {
  let modal = document.getElementById('bsky-hud-cache-calendar');
  if (modal) return modal;

  if (!document.getElementById('bsky-hud-cache-calendar-style')) {
    const style = document.createElement('style');
    style.id = 'bsky-hud-cache-calendar-style';
    style.textContent = `
      #bsky-hud-cache-calendar{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center}
      #bsky-hud-cache-calendar[hidden]{display:none}
      #bsky-hud-cache-calendar .backdrop{position:absolute;inset:0;background:rgba(0,0,0,.7)}
      #bsky-hud-cache-calendar .card{position:relative;max-width:720px;width:calc(100vw - 24px);background:#0b0b0b;color:#fff;border:1px solid #333;border-radius: var(--bsky-radius, 0px);box-shadow:0 20px 60px rgba(0,0,0,.6)}
      #bsky-hud-cache-calendar .hd{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.10);gap:10px}
      #bsky-hud-cache-calendar .hd .t{font-weight:800}
      #bsky-hud-cache-calendar .hd .close{appearance:none;background:transparent;border:1px solid #333;color:#fff;border-radius: var(--bsky-radius, 0px);padding:6px 10px;cursor:pointer}
      #bsky-hud-cache-calendar .hd .close:hover{background:#1b1b1b}
      #bsky-hud-cache-calendar .bd{padding:12px 14px;display:flex;flex-direction:column;gap:10px}
      #bsky-hud-cache-calendar .row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
      #bsky-hud-cache-calendar .nav{display:flex;align-items:center;gap:8px}
      #bsky-hud-cache-calendar .nav button{appearance:none;background:#111;border:1px solid #333;color:#fff;border-radius: var(--bsky-radius, 0px);padding:6px 10px;cursor:pointer;font-weight:800}
      #bsky-hud-cache-calendar .nav button:hover{background:#1b1b1b}
      #bsky-hud-cache-calendar .month{font-weight:800}
      #bsky-hud-cache-calendar .legend{display:flex;gap:10px;flex-wrap:wrap;color:#bbb;font-size:.9rem}
      #bsky-hud-cache-calendar .legend .item{display:flex;gap:6px;align-items:center}
      #bsky-hud-cache-calendar .dot{display:inline-block;width:10px;height:10px;border-radius:999px;border:1px solid rgba(255,255,255,.22)}
      #bsky-hud-cache-calendar .dot.full{background:#19b34a}
      #bsky-hud-cache-calendar .dot.partial{background:#f59e0b}
      #bsky-hud-cache-calendar .dot.empty{background:#ef4444}
      #bsky-hud-cache-calendar .dot.pre{background:#444;opacity:.65}
      #bsky-hud-cache-calendar .grid{display:grid;grid-template-columns:repeat(7, 1fr);gap:8px}
      #bsky-hud-cache-calendar .dow{color:#aaa;font-size:.8rem;text-align:center}
      #bsky-hud-cache-calendar .day{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:6px;padding:6px 4px;border:1px solid #333;border-radius: var(--bsky-radius, 0px);background:#0f0f0f;min-height:64px;cursor:pointer;user-select:none}
      #bsky-hud-cache-calendar .day:hover{border-color:#555;background:#121212}
      #bsky-hud-cache-calendar .day.pre{opacity:.45;background:#050505;cursor:default}
      #bsky-hud-cache-calendar .day.future{opacity:.6}
      #bsky-hud-cache-calendar .ring{width:28px;height:28px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-weight:900;color:#ddd;border:3px solid #666;background:rgba(0,0,0,.15)}
      #bsky-hud-cache-calendar .ring.green{border-color:#19b34a}
      #bsky-hud-cache-calendar .ring.orange{border-color:#f59e0b}
      #bsky-hud-cache-calendar .ring.red{border-color:#ef4444}
      #bsky-hud-cache-calendar .ring.pre{border-color:#222;color:#777;background:#000}
      #bsky-hud-cache-calendar .counts{color:#aaa;font-size:.75rem;line-height:1.05;text-align:center}
      #bsky-hud-cache-calendar .counts b{color:#ddd}
      #bsky-hud-cache-calendar .msg{color:#bbb;font-size:.9rem}
      #bsky-hud-cache-calendar .err{color:#f88}

      #bsky-hud-cache-calendar .daypanel{border-top:1px solid rgba(255,255,255,.10);padding-top:10px;margin-top:2px}
      #bsky-hud-cache-calendar .daypanel[hidden]{display:none}
      #bsky-hud-cache-calendar .daypanel .hdr{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
      #bsky-hud-cache-calendar .daypanel .hdr .dt{font-weight:900}
      #bsky-hud-cache-calendar .daypanel .btns{display:flex;gap:8px;flex-wrap:wrap}
      #bsky-hud-cache-calendar .daypanel button{appearance:none;background:#111;border:1px solid #333;color:#fff;border-radius: var(--bsky-radius, 0px);padding:8px 10px;cursor:pointer;font-weight:900}
      #bsky-hud-cache-calendar .daypanel button:hover{background:#1b1b1b}
      #bsky-hud-cache-calendar .daypanel button:disabled{opacity:.6;cursor:not-allowed}
      #bsky-hud-cache-calendar .cols{display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:10px;margin-top:10px}
      #bsky-hud-cache-calendar .card2{border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:10px;background:#0f0f0f}
      #bsky-hud-cache-calendar .card2 h4{margin:0 0 6px 0;font-size:1rem}
      #bsky-hud-cache-calendar .list{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow:auto;padding-right:4px}
      #bsky-hud-cache-calendar .item{display:flex;gap:8px;align-items:flex-start;border:1px solid #2b2b2b;border-radius: var(--bsky-radius, 0px);padding:6px;background:#101010}
      #bsky-hud-cache-calendar .item .t{color:#ddd;font-weight:900}
      #bsky-hud-cache-calendar .item .s{color:#bbb;font-size:.85rem;line-height:1.2}
      #bsky-hud-cache-calendar .item a{color:#9cd3ff;text-decoration:none}
      #bsky-hud-cache-calendar .item a:hover{text-decoration:underline}
      #bsky-hud-cache-calendar .av{width:28px;height:28px;border-radius: var(--bsky-radius, 0px);background:#222;object-fit:cover;flex:0 0 auto}
      #bsky-hud-cache-calendar .muted{color:#aaa}
      #bsky-hud-cache-calendar .chip{background:#1d2a41;color:#cfe5ff;border:1px solid #2f4b7a;border-radius: var(--bsky-radius, 0px);padding:1px 6px;font-size:.72rem;font-weight:900;margin-left:6px}
    `;
    document.head.appendChild(style);
  }

  modal = document.createElement('div');
  modal.id = 'bsky-hud-cache-calendar';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="backdrop" data-close></div>
    <div class="card" role="dialog" aria-modal="true" aria-label="Cache coverage calendar">
      <div class="hd">
        <div class="t">Cache coverage</div>
        <button class="close" type="button" data-close>Close</button>
      </div>
      <div class="bd">
        <div class="row">
          <div class="nav">
            <button type="button" data-prev title="Previous month">←</button>
            <span class="month" data-month></span>
            <button type="button" data-next title="Next month">→</button>
          </div>
          <div class="legend" aria-label="Legend">
            <span class="item"><span class="dot full"></span> full</span>
            <span class="item"><span class="dot partial"></span> partial</span>
            <span class="item"><span class="dot empty"></span> none</span>
            <span class="item"><span class="dot pre"></span> pre-join</span>
          </div>
        </div>
        <div class="msg" data-status></div>
        <div class="grid" data-grid></div>
        <div class="daypanel" data-day-panel hidden></div>
      </div>
    </div>
  `;

  const close = () => {
    modal.hidden = true;
    try { modal.__onShift = null; } catch {}
  };
  modal.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', close));

  const prevBtn = modal.querySelector('[data-prev]');
  const nextBtn = modal.querySelector('[data-next]');
  prevBtn?.addEventListener('click', () => { try { modal.__onShift && modal.__onShift(-1); } catch {} });
  nextBtn?.addEventListener('click', () => { try { modal.__onShift && modal.__onShift(1); } catch {} });

  modal.addEventListener('click', (e) => {
    const cell = e?.target?.closest?.('[data-day]');
    if (!cell) return;
    const ymd = cell.getAttribute('data-day') || '';
    if (!ymd) return;
    try { modal.__onPickDay && modal.__onPickDay(ymd); } catch {}
  });

  document.body.appendChild(modal);
  return modal;
}

class BskyProfile extends HTMLElement {
  constructor(){
    super();
    this.attachShadow({mode:'open'});
    this._hudQ = '';
    this._hudMode = 'cache';
    this._hudTargets = new Set([SEARCH_TARGETS.PEOPLE, SEARCH_TARGETS.POSTS, SEARCH_TARGETS.NOTIFICATIONS]);
    this._hudFilters = {
      people: { list: 'all', sort: 'followers', mutual: false },
      posts: { types: new Set(['post','reply','repost']) },
      notifications: { reasons: new Set(['follow','like','reply','repost','mention','quote','subscribed-post','subscribed']) },
    };
    this._hudTimer = null;

    this._hudCal = {
      open: false,
      month: null,
      loading: false,
      error: null,
      joinTs: null,
      cache: new Map(),
      sync: null,
      syncLoading: false,
      selectedDay: null,
      dayLoading: false,
      dayError: null,
      dayPosts: null,
      dayNotifs: null,
      backfillRunning: false,
      backfillCancel: false,
    };
  }
  connectedCallback(){
    this._authHandler = () => this.render();
    window.addEventListener('bsky-auth-changed', this._authHandler);
    bindCopyClicks(this.shadowRoot);
    this.render();
  }

  disconnectedCallback(){
    if (this._authHandler) window.removeEventListener('bsky-auth-changed', this._authHandler);
  }

  _scheduleHudSearch(nextQ) {
    this._hudQ = String(nextQ || '');
    if (this._hudTimer) { try { clearTimeout(this._hudTimer); } catch {} this._hudTimer = null; }
    this._hudTimer = setTimeout(() => {
      this._hudTimer = null;
      this._dispatchHudSearch();
    }, 250);
  }

  _dispatchHudSearch() {
    const q = String(this._hudQ || '').trim();
    const mode = (this._hudMode === 'network' || this._hudMode === 'cache') ? this._hudMode : 'cache';
    const targets = Array.from(this._hudTargets || []);

    const filters = {
      people: {
        list: String(this._hudFilters?.people?.list || 'all'),
        sort: String(this._hudFilters?.people?.sort || 'followers'),
        mutual: !!this._hudFilters?.people?.mutual,
      },
      posts: { types: Array.from(this._hudFilters?.posts?.types || []) },
      notifications: { reasons: Array.from(this._hudFilters?.notifications?.reasons || []) },
    };

    const spec = createSearchSpec({ query: q, targets, mode, filters });
    dispatchSearchChanged(spec);
  }

  _clearHudSearch(qEl) {
    try {
      if (this._hudTimer) { try { clearTimeout(this._hudTimer); } catch {} this._hudTimer = null; }
    } catch {}
    try { this._hudQ = ''; } catch {}
    try { if (qEl) qEl.value = ''; } catch {}
    try { this._dispatchHudSearch(); } catch {}
  }

  async render() {
    const c5 = (window.BSKY && window.BSKY.c5User) ? window.BSKY.c5User : null;
    const c5Name = c5?.name ? String(c5.name) : 'Guest';
    const c5Registered = !!c5?.registered;

    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block;margin-bottom:16px}
        .social-hud{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:#0b0b0b;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:10px;color:#fff}
        .avatar{width:48px;height:48px;border-radius: var(--bsky-radius, 0px);background:#222;object-fit:cover}
        .taskbar{flex:0 0 100%;width:100%;margin-top:10px}
        .name{font-weight:700}
        .handle a{color:#bbb;text-decoration:none}
        .meta{color:#bbb;font-size:.9rem;margin-top:2px;display:flex;gap:10px}
        .muted{color:#bbb}
      </style>
      <div class="social-hud">Loading profile…</div>
    `;
    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) {
        this.shadowRoot.innerHTML = `
          <style>
            :host{display:block;margin-bottom:16px}
            .social-hud{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:#0b0b0b;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:10px;color:#fff}
            .muted{color:#bbb}
            .name{font-weight:700}
            .auth{margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
            .auth-status{color:#bbb;font-size:.9rem}
            .auth-btn{appearance:none;background:#111;color:#fff;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:8px 12px;cursor:pointer;font-weight:700}
            .auth-btn:hover{background:#1b1b1b}
            .taskbar{flex:0 0 100%;width:100%;margin-top:10px}
          </style>
          <div class="social-hud">
            <div>
              <div class="name">Concrete: ${esc(c5Name)}${c5Registered ? '' : ' (Guest)'}</div>
              <div class="muted">Bluesky: not connected.</div>
              <div class="muted">${c5Registered ? 'Use the Connect button to sign in.' : 'Log into ConcreteCMS to connect.'}</div>
              <div class="auth" data-auth-controls-root>
                <span class="auth-status" data-auth-status>Bluesky: not connected</span>
                <button class="auth-btn" type="button" data-auth-connect>Connect</button>
                <button class="auth-btn" type="button" data-auth-disconnect hidden>Disconnect</button>
                <button class="auth-btn" type="button" data-hud-cache-calendar title="Connect to view cache coverage" disabled>📅</button>
              </div>
            </div>
            <div class="taskbar"><slot name="taskbar"></slot></div>
          </div>
        `;
        bindAuthControls(this.shadowRoot.querySelector('[data-auth-controls-root]'));
        return;
      }

      const prof = await call('getProfile', {});
      window.BSKY = window.BSKY || {};
      window.BSKY.meDid = prof.did;

      try {
        const ts = Date.parse(String(prof?.createdAt || ''));
        this._hudCal.joinTs = Number.isFinite(ts) ? ts : null;
      } catch {
        this._hudCal.joinTs = null;
      }

      const asCount = (v) => {
        if (v === null || v === undefined) return null;
        if (typeof v === 'number') return Number.isFinite(v) ? v : null;
        if (typeof v === 'string') {
          const s = v.trim();
          if (!s) return null;
          const n = Number(s);
          return Number.isFinite(n) ? n : null;
        }
        return null;
      };

      const counts = [];
      const followersCount = asCount(prof.followersCount);
      const followsCount = asCount(prof.followsCount);
      const postsCount = asCount(prof.postsCount);
      if (followersCount !== null) counts.push(`${followersCount} followers`);
      if (followsCount !== null) counts.push(`${followsCount} following`);
      if (postsCount !== null) counts.push(`${postsCount} posts`);

      const hudQ = String(this._hudQ || '');

      this.shadowRoot.innerHTML = `
        <style>
          :host{display:block;margin-bottom:16px}
          .social-hud{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:#0b0b0b;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:10px;color:#fff}
          .avatar{width:48px;height:48px;border-radius: var(--bsky-radius, 0px);background:#222;object-fit:cover}
          .left{min-width:0;flex:1 1 260px}
          .name{font-weight:700}
          .handle a{color:#bbb;text-decoration:none}
          .meta{color:#bbb;font-size:.9rem;margin-top:2px;display:flex;gap:10px;flex-wrap:wrap}
          .muted{color:#bbb;font-size:.9rem;margin-top:2px}
          .auth{margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
          .auth-status{color:#bbb;font-size:.9rem}
          .auth-btn{appearance:none;background:#111;color:#fff;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:8px 12px;cursor:pointer;font-weight:700}
          .auth-btn:hover{background:#1b1b1b}

          .right{margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;gap:8px;min-width:min(440px, 100%)}
          .hud-search{width:min(440px, 100%)}
          .hud-form{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
          .hud-form input{flex:1 1 auto;min-width:0;background:#0f0f0f;color:#fff;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:8px 10px}
          .hud-form button{appearance:none;background:#111;border:1px solid #555;color:#fff;padding:8px 10px;border-radius: var(--bsky-radius, 0px);cursor:pointer;font-weight:700}
          .hud-form button:hover{background:#1b1b1b}
          .hud-form select{background:#0f0f0f;color:#fff;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:8px 10px}
          .hud-filter-menu{position:relative;align-self:flex-end;z-index:9999}
          .hud-filter-menu[open]{z-index:9999}
          details.hud-filter-menu > summary{list-style:none}
          .hud-filter-summary{appearance:none;background:#111;border:1px solid #555;color:#fff;padding:8px 10px;border-radius: var(--bsky-radius, 0px);cursor:pointer;font-weight:700;user-select:none}
          .hud-filter-summary:hover{background:#1b1b1b}
          .hud-filter-summary::-webkit-details-marker{display:none}
          .hud-filter-menu[open] .hud-filter-summary{background:#1b1b1b}
          .hud-filter-pop{position:absolute;right:0;top:calc(100% + 6px);z-index:10000;min-width:min(440px, 92vw);max-width:min(440px, 92vw);background:#0b0b0b;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:10px;box-shadow:0 10px 30px rgba(0,0,0,.55)}
          .hud-targets{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end;margin-top:6px;color:#bbb;font-size:.85rem}
          .hud-targets label{display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none}
          .hud-targets input{transform:translateY(0.5px)}
          .hud-filters{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;margin-top:6px;color:#bbb;font-size:.82rem}
          .hud-filters .group{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:flex-end}
          .hud-filters .label{color:#999}
          .hud-meta{color:#aaa;font-size:.85rem;margin-top:4px}

          .gear{appearance:none;background:transparent;border:1px solid #333;color:#fff;border-radius: var(--bsky-radius, 0px);padding:6px 8px;cursor:pointer}
          .gear:hover{background:#1b1b1b}
          .taskbar{flex:0 0 100%;width:100%;margin-top:10px}
          ${identityCss}
        </style>
        <div class="social-hud">
          <img class="avatar" src="${esc(prof.avatar || '')}" alt="" onerror="this.style.display='none'">
          <div class="left">
            <div class="muted">Concrete: ${esc(c5Name)}${c5Registered ? '' : ' (Guest)'}</div>
            <div class="name">${identityHtml({ did: prof.did, handle: prof.handle, displayName: prof.displayName }, { showHandle: true, showCopyDid: true })}</div>
            <div class="meta">${counts.map(esc).join(' · ')}</div>
            <div class="auth" data-auth-controls-root>
              <span class="auth-status" data-auth-status>Bluesky: connected</span>
              <button class="auth-btn" type="button" data-auth-connect>Connect</button>
              <button class="auth-btn" type="button" data-auth-disconnect hidden>Disconnect</button>
              <button class="auth-btn" type="button" data-hud-cache-calendar title="Show which days are stored in the local cache">📅</button>
            </div>
          </div>
          <div class="right">
            <div class="hud-search">
              <form class="hud-form" data-hud-search>
                <input type="search" placeholder="Search (supports OR, -term, field:value, /regex/i)…" value="${esc(hudQ)}" data-hud-q />
                <select data-hud-mode title="Search source">
                  <option value="cache" ${this._hudMode === 'cache' ? 'selected' : ''}>Cache</option>
                  <option value="network" ${this._hudMode === 'network' ? 'selected' : ''}>Bluesky</option>
                </select>
                <button type="submit">Search</button>
                <button type="button" data-hud-clear>Clear</button>
              </form>
              <details class="hud-filter-menu" data-hud-filter-menu>
                <summary class="hud-filter-summary" title="Targets + filters">Filters</summary>
                <div class="hud-filter-pop">
                  <div class="hud-targets" data-hud-targets>
                    <label><input type="checkbox" data-target="${esc(SEARCH_TARGETS.PEOPLE)}" ${this._hudTargets.has(SEARCH_TARGETS.PEOPLE) ? 'checked' : ''}> People</label>
                    <label><input type="checkbox" data-target="${esc(SEARCH_TARGETS.POSTS)}" ${this._hudTargets.has(SEARCH_TARGETS.POSTS) ? 'checked' : ''}> Posts</label>
                    <label><input type="checkbox" data-target="${esc(SEARCH_TARGETS.NOTIFICATIONS)}" ${this._hudTargets.has(SEARCH_TARGETS.NOTIFICATIONS) ? 'checked' : ''}> Notifs</label>
                  </div>
                  <div class="hud-filters">
                    <div class="group" data-hud-people>
                      <span class="label">People:</span>
                      <select data-hud-people-list title="People list">
                        <option value="all" ${this._hudFilters.people.list === 'all' ? 'selected' : ''}>all</option>
                        <option value="followers" ${this._hudFilters.people.list === 'followers' ? 'selected' : ''}>followers</option>
                        <option value="following" ${this._hudFilters.people.list === 'following' ? 'selected' : ''}>following</option>
                      </select>
                      <select data-hud-people-sort title="People sort">
                        <option value="followers" ${this._hudFilters.people.sort === 'followers' ? 'selected' : ''}>followers</option>
                        <option value="following" ${this._hudFilters.people.sort === 'following' ? 'selected' : ''}>following</option>
                        <option value="posts" ${this._hudFilters.people.sort === 'posts' ? 'selected' : ''}>posts</option>
                        <option value="age" ${this._hudFilters.people.sort === 'age' ? 'selected' : ''}>age</option>
                        <option value="name" ${this._hudFilters.people.sort === 'name' ? 'selected' : ''}>name</option>
                        <option value="handle" ${this._hudFilters.people.sort === 'handle' ? 'selected' : ''}>handle</option>
                      </select>
                      <label><input type="checkbox" data-hud-people-mutual ${this._hudFilters.people.mutual ? 'checked' : ''}> mutual</label>
                    </div>
                    <div class="group" data-hud-post-types>
                      <span class="label">Post types:</span>
                      <label><input type="checkbox" data-post-type="post" ${this._hudFilters.posts.types.has('post') ? 'checked' : ''}> post</label>
                      <label><input type="checkbox" data-post-type="reply" ${this._hudFilters.posts.types.has('reply') ? 'checked' : ''}> reply</label>
                      <label><input type="checkbox" data-post-type="repost" ${this._hudFilters.posts.types.has('repost') ? 'checked' : ''}> repost</label>
                    </div>
                    <div class="group" data-hud-notif-reasons>
                      <span class="label">Notifs:</span>
                      ${['follow','like','reply','repost','mention','quote','subscribed-post','subscribed'].map((r) => `
                        <label><input type="checkbox" data-notif-reason="${esc(r)}" ${this._hudFilters.notifications.reasons.has(r) ? 'checked' : ''}> ${esc(r)}</label>
                      `).join('')}
                    </div>
                  </div>
                  <div class="hud-meta">Targets update live while typing. Use Clear to reset.</div>
                </div>
              </details>
            </div>
            <button class="gear" type="button" title="Settings" data-open-settings>⚙</button>
          </div>
          <div class="taskbar"><slot name="taskbar"></slot></div>
        </div>
      `;
      bindAuthControls(this.shadowRoot.querySelector('[data-auth-controls-root]'));

      const calBtn = this.shadowRoot.querySelector('[data-hud-cache-calendar]');
      if (calBtn) {
        calBtn.addEventListener('click', () => {
          try { this.openHudCacheCalendar(); } catch {}
        });
      }

      const form = this.shadowRoot.querySelector('[data-hud-search]');
      const qEl = this.shadowRoot.querySelector('[data-hud-q]');
      const modeEl = this.shadowRoot.querySelector('[data-hud-mode]');
      const clearEl = this.shadowRoot.querySelector('[data-hud-clear]');
      const targetsEl = this.shadowRoot.querySelector('[data-hud-targets]');
      const peopleEl = this.shadowRoot.querySelector('[data-hud-people]');
      const peopleListEl = this.shadowRoot.querySelector('[data-hud-people-list]');
      const peopleSortEl = this.shadowRoot.querySelector('[data-hud-people-sort]');
      const peopleMutualEl = this.shadowRoot.querySelector('[data-hud-people-mutual]');
      const postTypesEl = this.shadowRoot.querySelector('[data-hud-post-types]');
      const notifReasonsEl = this.shadowRoot.querySelector('[data-hud-notif-reasons]');
      if (qEl) {
        qEl.addEventListener('input', () => {
          try { this._scheduleHudSearch(qEl.value); } catch {}
        });
      }
      if (modeEl) {
        modeEl.addEventListener('change', () => {
          try { this._hudMode = modeEl.value === 'network' ? 'network' : 'cache'; } catch {}
          try { this._dispatchHudSearch(); } catch {}
        });
      }
      if (form && qEl) {
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          try { this._hudQ = String(qEl.value || ''); } catch {}
          if (modeEl) {
            try { this._hudMode = modeEl.value === 'network' ? 'network' : 'cache'; } catch {}
          }
          this._dispatchHudSearch();
        });
      }

      if (targetsEl) {
        targetsEl.addEventListener('change', (e) => {
          const el = e?.target;
          const t = el?.getAttribute?.('data-target');
          if (!t) return;
          if (el.checked) this._hudTargets.add(String(t));
          else this._hudTargets.delete(String(t));
          this._dispatchHudSearch();
        });
      }

      if (postTypesEl) {
        postTypesEl.addEventListener('change', (e) => {
          const el = e?.target;
          const t = el?.getAttribute?.('data-post-type');
          if (!t) return;
          if (el.checked) this._hudFilters.posts.types.add(String(t));
          else this._hudFilters.posts.types.delete(String(t));
          this._dispatchHudSearch();
        });
      }

      if (notifReasonsEl) {
        notifReasonsEl.addEventListener('change', (e) => {
          const el = e?.target;
          const r = el?.getAttribute?.('data-notif-reason');
          if (!r) return;
          if (el.checked) this._hudFilters.notifications.reasons.add(String(r));
          else this._hudFilters.notifications.reasons.delete(String(r));
          this._dispatchHudSearch();
        });
      }

      if (peopleEl) {
        const onPeopleChanged = () => {
          try { this._hudFilters.people.list = String(peopleListEl?.value || 'all'); } catch {}
          try { this._hudFilters.people.sort = String(peopleSortEl?.value || 'followers'); } catch {}
          try { this._hudFilters.people.mutual = !!peopleMutualEl?.checked; } catch {}
          this._dispatchHudSearch();
        };
        peopleEl.addEventListener('change', onPeopleChanged);
      }

      if (clearEl) {
        clearEl.addEventListener('click', () => {
          this._clearHudSearch(qEl);
        });
      }

      const btn = this.shadowRoot.querySelector('[data-open-settings]');
      if (btn) {
        btn.addEventListener('click', () => {
          try {
            window.dispatchEvent(new CustomEvent('bsky-open-settings', { detail: { source: 'profile' } }));
          } catch {}
        });
      }
    } catch(e) {
      if (isNotConnectedError(e)) {
        this.shadowRoot.innerHTML = `
          <div style="color:#bbb">Concrete: ${esc(c5Name)}${c5Registered ? '' : ' (Guest)'} • Bluesky not connected.</div>
        `;
        return;
      }
      this.shadowRoot.innerHTML = `<div style="color:#f88">Profile error: ${esc(e.message)}</div>`;
    }
  }

  async openHudCacheCalendar() {
    this._hudCal.open = true;
    if (!this._hudCal.month) this._hudCal.month = monthKeyUtc();

    const modal = ensureHudCacheCalendarModal();
    modal.hidden = false;

    try {
      modal.__onShift = (delta) => {
        try { this.shiftHudCacheCalendarMonth(delta); } catch {}
      };
    } catch {}

    try {
      modal.__onPickDay = (ymd) => {
        try { this.openHudCacheCalendarDay(ymd); } catch {}
      };
    } catch {}

    await this.loadHudCacheCalendarMonth(this._hudCal.month);
    this.renderHudCacheCalendarModal();
  }

  closeHudCacheCalendar() {
    this._hudCal.open = false;
    const modal = document.getElementById('bsky-hud-cache-calendar');
    if (modal) modal.hidden = true;
  }

  shiftHudCacheCalendarMonth(delta) {
    this._hudCal.month = shiftMonthKey(this._hudCal.month, delta);
    this.loadHudCacheCalendarMonth(this._hudCal.month);
    this.renderHudCacheCalendarModal();
  }

  async loadHudCacheCalendarMonth(month) {
    try {
      window.dispatchEvent(new CustomEvent('bsky-open-cache-settings', { detail: { tab: 'calendar' } }));
    } catch {
      // ignore
    }
    if (monthEl) monthEl.textContent = String(this._hudCal.month || '');

    if (statusEl) {
      if (this._hudCal.loading) statusEl.textContent = 'Scanning cache coverage…';
      else if (this._hudCal.error) statusEl.innerHTML = `<span class="err">${esc(this._hudCal.error)}</span>`;
      else statusEl.textContent = 'Ring shows whether the day is up-to-date (based on per-day DB updates vs last sync). Click a day for details + backfill.';
    }

    if (!gridEl) return;
    const b = monthBoundsUtc(this._hudCal.month);
    if (!b) {
      gridEl.innerHTML = '<div class="msg err">Invalid month.</div>';
      return;
    }

    const monthRes = this._hudCal.cache.get(this._hudCal.month);
    const postsCounts = monthRes?.posts?.counts || {};
    const notifCounts = monthRes?.notifications?.counts || {};
    const postsUpdatedAt = monthRes?.posts?.updatedAt || {};
    const notifUpdatedAt = monthRes?.notifications?.updatedAt || {};

    const lastPostsSyncAt = this._hudCal.sync?.lastPostsSyncAt ? Date.parse(String(this._hudCal.sync.lastPostsSyncAt)) : NaN;
    const lastNotifsSyncAt = this._hudCal.sync?.lastNotificationsSyncAt ? Date.parse(String(this._hudCal.sync.lastNotificationsSyncAt)) : NaN;

    const joinTs = this._hudCal.joinTs;
    const todayTs = Date.now();

    const startDow = b.start.getUTCDay();
    const daysIn = daysInMonthUtc(b.y, b.mo);

    const dows = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const cells = [];
    for (const d of dows) cells.push(`<div class="dow">${esc(d)}</div>`);
    for (let i = 0; i < startDow; i++) cells.push('<div></div>');

    for (let day = 1; day <= daysIn; day++) {
      const iso = isoDay(b.y, b.mo, day);
      const t = Date.parse(iso + 'T00:00:00Z');

      const pre = Number.isFinite(joinTs) && Number.isFinite(t) ? (t < joinTs) : false;
      const future = Number.isFinite(t) ? (t > todayTs) : false;

      const pCount = Number(postsCounts?.[iso] ?? 0);
      const nCount = Number(notifCounts?.[iso] ?? 0);
      const pUpd = postsUpdatedAt?.[iso] ? Date.parse(String(postsUpdatedAt[iso])) : NaN;
      const nUpd = notifUpdatedAt?.[iso] ? Date.parse(String(notifUpdatedAt[iso])) : NaN;

      // "Needs update" heuristic:
      // If last sync is unknown, treat as needing update.
      // If rows for that day changed after the last sync, treat as needing update.
      const needsPostsUpdate = pre ? false : (!Number.isFinite(lastPostsSyncAt) ? true : (Number.isFinite(pUpd) && pUpd > lastPostsSyncAt));
      const needsNotifsUpdate = pre ? false : (!Number.isFinite(lastNotifsSyncAt) ? true : (Number.isFinite(nUpd) && nUpd > lastNotifsSyncAt));

      const ring = pre ? 'pre' : ((needsPostsUpdate && needsNotifsUpdate) ? 'red' : ((needsPostsUpdate || needsNotifsUpdate) ? 'orange' : 'green'));

      const title = `${iso} • posts: ${Number.isFinite(pCount) ? pCount : 0} • notifs: ${Number.isFinite(nCount) ? nCount : 0}`
        + (pre ? ' • pre-join' : '')
        + (needsPostsUpdate || needsNotifsUpdate ? ' • needs refresh/backfill' : ' • up to date');

      const cls = ['day', pre ? 'pre' : '', future ? 'future' : ''].filter(Boolean).join(' ');
      cells.push(`
        <div class="${cls}" data-day="${esc(iso)}" title="${esc(title)}">
          <div class="ring ${ring}">${day}</div>
          <div class="counts"><b>P</b> ${esc(pCount)} <b>N</b> ${esc(nCount)}</div>
        </div>
      `);
    }

    gridEl.innerHTML = cells.join('');

    // Render selected day panel (if any)
    const panel = modal.querySelector('[data-day-panel]');
    if (!panel) return;
    if (!this._hudCal.selectedDay) {
      panel.hidden = true;
      panel.innerHTML = '';
      return;
    }

    const day = String(this._hudCal.selectedDay);
    const busy = !!this._hudCal.dayLoading || !!this._hudCal.backfillRunning;
    const err = this._hudCal.dayError ? `<div class="muted" style="color:#f88">${esc(this._hudCal.dayError)}</div>` : '';

    const posts = Array.isArray(this._hudCal.dayPosts) ? this._hudCal.dayPosts : [];
    const notifs = Array.isArray(this._hudCal.dayNotifs) ? this._hudCal.dayNotifs : [];

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
            <div class="t">${esc(kind)}${when ? ` • ${esc(when)}` : ''}</div>
            <div class="s">${text ? esc(text) : '<span class="muted">(no text)</span>'} ${open ? ` • <a href="${esc(open)}" target="_blank" rel="noopener">Open</a>` : ''}</div>
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
            <div class="t">${esc(who)} <span class="chip">${esc(reason || 'EVENT')}</span>${when ? ` <span class="muted">• ${esc(when)}</span>` : ''}</div>
            <div class="s">${esc(String(n.reasonSubject || ''))}${open ? ` • <a href="${esc(open)}" target="_blank" rel="noopener">Open</a>` : ''}</div>
          </div>
        </div>
      `;
    }).join('') || '<div class="muted">No cached notifications for this day.</div>';

    panel.hidden = false;
    panel.innerHTML = `
      <div class="hdr">
        <div class="dt">${esc(day)}</div>
        <div class="btns">
          <button type="button" data-action="backfill-day" ${busy ? 'disabled' : ''}>Backfill up to this day</button>
          <button type="button" data-action="backfill-since-join" ${busy ? 'disabled' : ''}>Backfill up to join day</button>
          ${this._hudCal.backfillRunning ? '<button type="button" data-action="cancel" >Cancel</button>' : ''}
          <button type="button" data-action="close-day" ${busy ? 'disabled' : ''}>Close</button>
        </div>
      </div>
      ${busy ? '<div class="muted">Working…</div>' : ''}
      ${err}
      <div class="cols">
        <div class="card2">
          <h4>My posts + replies (${posts.length})</h4>
          <div class="list">${postRows}</div>
        </div>
        <div class="card2">
          <h4>Notifications (${notifs.length})</h4>
          <div class="list">${notifRows}</div>
        </div>
      </div>
    `;

    panel.querySelector('[data-action="close-day"]')?.addEventListener('click', () => {
      this._hudCal.selectedDay = null;
      this._hudCal.dayPosts = null;
      this._hudCal.dayNotifs = null;
      this._hudCal.dayError = null;
      this.renderHudCacheCalendarModal();
    });
    panel.querySelector('[data-action="backfill-day"]')?.addEventListener('click', () => {
      this.backfillHudCacheTo(dayStartIso(day));
    });
    panel.querySelector('[data-action="backfill-since-join"]')?.addEventListener('click', () => {
      const jt = this._hudCal.joinTs;
      if (!Number.isFinite(jt)) {
        this._hudCal.dayError = 'Join date unavailable; connect and try again.';
        this.renderHudCacheCalendarModal();
        return;
      }
      const joinDay = new Date(jt);
      const y = joinDay.getUTCFullYear();
      const m = joinDay.getUTCMonth() + 1;
      const d = joinDay.getUTCDate();
      const joinIso = `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      this.backfillHudCacheTo(dayStartIso(joinIso));
    });

    panel.querySelector('[data-action="cancel"]')?.addEventListener('click', () => {
      this._hudCal.backfillCancel = true;
      this.renderHudCacheCalendarModal();
    });
  }

  async openHudCacheCalendarDay(ymd) {
    const day = String(ymd || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    this._hudCal.selectedDay = day;
    this._hudCal.dayLoading = true;
    this._hudCal.dayError = null;
    this._hudCal.dayPosts = null;
    this._hudCal.dayNotifs = null;
    this.renderHudCacheCalendarModal();

    try {
      const [postsRes, notifRes] = await Promise.all([
        call('cacheQueryMyPosts', { since: dayStartIso(day), until: dayEndIso(day), hours: 0, limit: 200, offset: 0, newestFirst: true }),
        call('cacheQueryNotifications', { since: dayStartIso(day), until: dayEndIso(day), hours: 0, limit: 200, offset: 0, newestFirst: true }),
      ]);

      this._hudCal.dayPosts = Array.isArray(postsRes?.items) ? postsRes.items : [];
      this._hudCal.dayNotifs = Array.isArray(notifRes?.items) ? notifRes.items : [];
    } catch (e) {
      this._hudCal.dayError = e?.message || String(e);
    } finally {
      this._hudCal.dayLoading = false;
      this.renderHudCacheCalendarModal();
    }
  }

  async backfillHudCacheTo(stopBeforeIso) {
    if (this._hudCal.backfillRunning) return;
    this._hudCal.backfillRunning = true;
    this._hudCal.backfillCancel = false;
    this._hudCal.dayError = null;
    this.renderHudCacheCalendarModal();

    const stopIso = String(stopBeforeIso || '').trim();
    const month = this._hudCal.month;

    const runLoop = async (method, payload, isDone) => {
      for (let i = 0; i < 25; i++) {
        if (this._hudCal.backfillCancel) break;
        const res = await call(method, payload);
        if (isDone(res)) break;
      }
    };

    try {
      // Notifications backfill until we reach stopBefore.
      await runLoop(
        'cacheBackfillNotifications',
        { hours: 24 * 365 * 30, pagesMax: 80, stopBefore: stopIso },
        (res) => !!res?.done || !!res?.stoppedEarly || !String(res?.cursor || ''),
      );

      // Posts backfill until we reach stopBefore.
      await runLoop(
        'cacheBackfillMyPosts',
        { pagesMax: 80, stopBefore: stopIso },
        (res) => !!res?.done || !!res?.stoppedEarly || !String(res?.cursor || ''),
      );

      // Refresh sync timestamps and month cache.
      try { this._hudCal.sync = await call('cacheStatus', {}); } catch {}
      await this.reloadHudCacheCalendarMonth(month);
      if (this._hudCal.selectedDay) {
        await this.openHudCacheCalendarDay(this._hudCal.selectedDay);
      }
    } catch (e) {
      this._hudCal.dayError = e?.message || String(e);
    } finally {
      this._hudCal.backfillRunning = false;
      this.renderHudCacheCalendarModal();
    }
  }
}
customElements.define('bsky-profile', BskyProfile);
