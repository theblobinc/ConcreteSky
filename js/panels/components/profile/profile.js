import { call } from '../../../api.js';
import { getAuthStatusCached, isNotConnectedError } from '../../../auth_state.js';
import { bindAuthControls } from '../../../auth_controls.js';
import { identityCss, identityHtml, bindCopyClicks } from '../../../lib/identity.js';
import { createSearchSpec, dispatchSearchChanged } from '../../../search/search_bus.js';
import { SEARCH_TARGETS } from '../../../search/constants.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) =>
  ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[m])
);

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
}
customElements.define('bsky-profile', BskyProfile);
