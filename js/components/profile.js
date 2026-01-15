import { call } from '../api.js';
import { getAuthStatusCached, isNotConnectedError } from '../auth_state.js';
import { bindAuthControls } from '../auth_controls.js';
import { identityCss, identityHtml, bindCopyClicks } from '../lib/identity.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) =>
  ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[m])
);

class BskyProfile extends HTMLElement {
  constructor(){ super(); this.attachShadow({mode:'open'}); }
  connectedCallback(){
    this._authHandler = () => this.render();
    window.addEventListener('bsky-auth-changed', this._authHandler);
    bindCopyClicks(this.shadowRoot);
    this.render();
  }

  disconnectedCallback(){
    if (this._authHandler) window.removeEventListener('bsky-auth-changed', this._authHandler);
  }

  async render() {
    const c5 = (window.BSKY && window.BSKY.c5User) ? window.BSKY.c5User : null;
    const c5Name = c5?.name ? String(c5.name) : 'Guest';
    const c5Registered = !!c5?.registered;

    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block;margin-bottom:16px}
          .card{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:#0b0b0b;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:10px;color:#fff}
        .avatar{width:48px;height:48px;border-radius: var(--bsky-radius, 0px);background:#222;object-fit:cover}
          .taskbar{flex:0 0 100%;width:100%;margin-top:10px}
        .name{font-weight:700}
        .handle a{color:#bbb;text-decoration:none}
        .meta{color:#bbb;font-size:.9rem;margin-top:2px;display:flex;gap:10px}
        .muted{color:#bbb}
      </style>
      <div class="card">Loading profile…</div>
    `;
    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) {
        this.shadowRoot.innerHTML = `
          <style>
            :host{display:block;margin-bottom:16px}
            .card{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:#0b0b0b;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:10px;color:#fff}
            .muted{color:#bbb}
            .name{font-weight:700}
            .auth{margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
            .auth-status{color:#bbb;font-size:.9rem}
            .auth-btn{appearance:none;background:#111;color:#fff;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:8px 12px;cursor:pointer;font-weight:700}
            .auth-btn:hover{background:#1b1b1b}
            .taskbar{flex:0 0 100%;width:100%;margin-top:10px}
          </style>
          <div class="card">
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

      const counts = [];
      if (typeof prof.followersCount === 'number') counts.push(`${prof.followersCount} followers`);
      if (typeof prof.followsCount === 'number') counts.push(`${prof.followsCount} following`);
      if (typeof prof.postsCount === 'number') counts.push(`${prof.postsCount} posts`);

      this.shadowRoot.innerHTML = `
        <style>
          :host{display:block;margin-bottom:16px}
          .card{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:#0b0b0b;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:10px;color:#fff}
          .avatar{width:48px;height:48px;border-radius: var(--bsky-radius, 0px);background:#222;object-fit:cover}
          .left{min-width:0;flex:1 1 auto}
          .name{font-weight:700}
          .handle a{color:#bbb;text-decoration:none}
          .meta{color:#bbb;font-size:.9rem;margin-top:2px;display:flex;gap:10px;flex-wrap:wrap}
          .muted{color:#bbb;font-size:.9rem;margin-top:2px}
          .auth{margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
          .auth-status{color:#bbb;font-size:.9rem}
          .auth-btn{appearance:none;background:#111;color:#fff;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:8px 12px;cursor:pointer;font-weight:700}
          .auth-btn:hover{background:#1b1b1b}
          .right{margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;gap:8px}
          .gear{appearance:none;background:transparent;border:1px solid #333;color:#fff;border-radius: var(--bsky-radius, 0px);padding:6px 8px;cursor:pointer}
          .gear:hover{background:#1b1b1b}
          .taskbar{flex:0 0 100%;width:100%;margin-top:10px}
          ${identityCss}
        </style>
        <div class="card">
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
            <button class="gear" type="button" title="Settings" data-open-settings>⚙</button>
          </div>
          <div class="taskbar"><slot name="taskbar"></slot></div>
        </div>
      `;
      bindAuthControls(this.shadowRoot.querySelector('[data-auth-controls-root]'));

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
