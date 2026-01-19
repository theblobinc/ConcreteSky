import { call } from './api.js';
import { identityHtml, bindCopyClicks } from './lib/identity.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));

function fmtWho(auth) {
  if (!auth?.connected) return 'Bluesky: not connected';
  const handle = auth.handle ? `@${auth.handle}` : '';
  const did = auth.did ? String(auth.did) : '';
  const displayName = auth.displayName ? String(auth.displayName) : '';
  return `Bluesky: connected ${displayName || handle || did}`.trim();
}

function fmtAge(iso) {
  if (!iso) return '';
  try {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '';
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 48) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
  } catch {
    return '';
  }
}

export function bindAuthControls(root) {
  if (!root) return;

  const statusEl = root.querySelector('[data-auth-status]');
  const btnConnect = root.querySelector('[data-auth-connect]');
  const btnDisconnect = root.querySelector('[data-auth-disconnect]');

  let busy = false;
  let canConnect = true;

  const setBusy = (v) => {
    busy = !!v;
    if (btnConnect) btnConnect.disabled = busy || !canConnect;
    if (btnDisconnect) btnDisconnect.disabled = busy;
  };

  const render = (auth) => {
    canConnect = auth?.c5?.registered !== false;
    if (statusEl) statusEl.textContent = fmtWho(auth);
    if (btnDisconnect) btnDisconnect.hidden = !auth?.connected;
    // Keep the primary button visible so it can act as an account manager.
    if (btnConnect) btnConnect.hidden = false;

    if (btnConnect) {
      btnConnect.textContent = auth?.connected ? 'Accounts' : 'Connect';
      btnConnect.title = canConnect
        ? (auth?.connected ? 'Manage Bluesky accounts' : 'Connect your Bluesky account')
        : 'Log into ConcreteCMS to connect';
      btnConnect.disabled = busy || !canConnect;
    }
  };

  const refresh = async () => {
    try {
      const auth = await call('authStatus', {});
      render(auth);
      return auth;
    } catch (e) {
      if (statusEl) statusEl.innerHTML = `Bluesky: <span style="color:#f88">${esc(e?.message || e)}</span>`;
      if (btnDisconnect) btnDisconnect.hidden = true;
      if (btnConnect) btnConnect.hidden = false;
      return null;
    }
  };

  const ensureModal = () => {
    let modal = document.getElementById('bsky-auth-modal');
    if (modal) return modal;

    if (!document.getElementById('bsky-auth-modal-style')) {
      const style = document.createElement('style');
      style.id = 'bsky-auth-modal-style';
      style.textContent = `
        #bsky-auth-modal{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center}
        #bsky-auth-modal[hidden]{display:none}
        #bsky-auth-modal .bsky-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.7)}
        #bsky-auth-modal .bsky-card{position:relative;max-width:520px;width:calc(100vw - 24px);background:#11161d;color:#fff;border:1px solid rgba(255,255,255,.12);border-radius: var(--bsky-radius, 0px);box-shadow:0 20px 60px rgba(0,0,0,.6)}
        #bsky-auth-modal .bsky-hd{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.10)}
        #bsky-auth-modal .bsky-hd .t{font-weight:700}
        #bsky-auth-modal .bsky-bd{padding:14px;display:flex;flex-direction:column;gap:10px}
        #bsky-auth-modal label{font-size:12px;color:rgba(255,255,255,.7)}
        #bsky-auth-modal input{width:100%;padding:10px 10px;border-radius: var(--bsky-radius, 0px);border:1px solid rgba(255,255,255,.16);background:#0b0d10;color:#fff}
        #bsky-auth-modal .row{display:flex;gap:10px;flex-wrap:wrap}
        #bsky-auth-modal .row>*{flex:1 1 auto}
        #bsky-auth-modal button{padding:10px 12px;border-radius: var(--bsky-radius, 0px);border:1px solid rgba(255,255,255,.18);background:#1d2733;color:#fff;cursor:pointer}
        #bsky-auth-modal button.primary{background:#2b6cb0;border-color:#2b6cb0}
        #bsky-auth-modal button.ghost{background:transparent}
        #bsky-auth-modal .muted{font-size:12px;color:rgba(255,255,255,.7)}
        #bsky-auth-modal details{border:1px solid rgba(255,255,255,.10);border-radius: var(--bsky-radius, 0px);padding:10px}
        #bsky-auth-modal details>summary{cursor:pointer}
      `;
      document.head.appendChild(style);
    }

    modal = document.createElement('div');
    modal.id = 'bsky-auth-modal';
    modal.hidden = true;
    modal.innerHTML = `
      <div class="bsky-backdrop" data-close></div>
      <div class="bsky-card" role="dialog" aria-modal="true" aria-label="Connect Bluesky">
        <div class="bsky-hd">
          <div class="t">Bluesky account manager</div>
          <button class="ghost" type="button" data-close>Close</button>
        </div>
        <div class="bsky-bd">
          <div class="muted" data-modal-status>Checking sign-in status…</div>
          <div data-accounts-wrap hidden>
            <div class="muted" style="margin-top:4px">Connected accounts</div>
            <div data-accounts style="display:flex;flex-direction:column;gap:8px;margin-top:8px"></div>
            <div class="row" style="margin-top:8px">
              <button type="button" class="ghost" data-logout-all>Disconnect all</button>
            </div>
            <div style="height:10px"></div>
          </div>
          <div class="muted">Recommended: OAuth sign-in (no app password).</div>
          <label>Handle or DID (optional)</label>
          <input data-login-hint placeholder="eg @theblobinc.com or did:plc:... (optional)" />
          <div class="row">
            <button type="button" class="primary" data-oauth>Sign in with Bluesky</button>
          </div>

          <details>
            <summary>Use app password (deprecated fallback)</summary>
            <form data-app-form autocomplete="on">
              <div style="height:10px"></div>
              <div class="muted">Deprecated: app passwords are less secure and tend to be more fragile. Prefer OAuth above.</div>
              <div style="height:8px"></div>
              <label>Identifier (handle/email)</label>
              <input data-identifier name="username" autocomplete="username" placeholder="handle or email" />
              <div style="height:8px"></div>
              <label>App password</label>
              <input data-app-password name="password" autocomplete="current-password" type="password" placeholder="xxxx-xxxx-xxxx-xxxx" />
              <div style="height:10px"></div>
              <div class="row">
                <button type="submit" data-app-login>Connect with app password</button>
              </div>
            </form>
          </details>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Enable copy-DID buttons inside the modal.
    bindCopyClicks(modal);

    const close = () => { modal.hidden = true; };
    modal.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', close));
    modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    const appForm = modal.querySelector('[data-app-form]');
    if (appForm) {
      appForm.addEventListener('submit', (e) => {
        e.preventDefault();
        modal.querySelector('[data-app-login]')?.click();
      });
    }

    return modal;
  };

  const openModal = () => {
    const modal = ensureModal();
    modal.hidden = false;
    const first = modal.querySelector('input');
    if (first) setTimeout(() => first.focus(), 0);
    return modal;
  };

  btnConnect?.addEventListener('click', async () => {
    if (busy) return;
    const modal = openModal();

    const renderAccounts = (auth) => {
      const wrap = modal.querySelector('[data-accounts-wrap]');
      const list = modal.querySelector('[data-accounts]');
      if (!wrap || !list) return;

      const accounts = Array.isArray(auth?.accounts) ? auth.accounts : [];
      const activeDid = auth?.activeDid || auth?.did || null;

      if (!accounts.length) {
        wrap.hidden = true;
        list.innerHTML = '';
        return;
      }

      wrap.hidden = false;
      list.innerHTML = accounts.map((a) => {
        const did = String(a?.did || '');
        const handle = a?.handle ? String(a.handle) : '';
        const displayName = a?.displayName ? String(a.displayName) : '';
        const isActive = activeDid && did && activeDid === did;
        const updated = a?.updatedAt ? `${fmtAge(a.updatedAt)} ago` : '';
        const createdIso = String(a?.accountCreatedAt || '').trim();
        const joined = createdIso ? createdIso.slice(0, 10) : '';
        const age = createdIso ? fmtAge(createdIso) : '';
        return `
          <div style="display:flex;align-items:center;gap:10px;justify-content:space-between;border:1px solid rgba(255,255,255,.10);border-radius:10px;padding:10px">
            <div style="min-width:0">
              <div style="font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${identityHtml({ did, handle, displayName }, { showHandle: true, showCopyDid: true })}</div>
              <div class="muted">${updated ? `Updated ${esc(updated)}` : ''}${a?.authType ? `${updated ? ' • ' : ''}${esc(String(a.authType))}` : ''}${joined ? `${(updated || a?.authType) ? ' • ' : ''}Joined ${esc(joined)}${age ? ` (${esc(age)})` : ''}` : ''}</div>
              ${isActive ? '<div class="muted" style="color:#89f0a2">Active</div>' : ''}
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
              ${isActive ? '' : `<button type="button" data-set-active="${esc(did)}">Switch</button>`}
              <button type="button" data-remove="${esc(did)}">Disconnect</button>
            </div>
          </div>`;
      }).join('');
    };

    // Show existing auth state inside the modal.
    try {
      const auth = await refresh();
      const st = modal.querySelector('[data-modal-status]');
      if (st) {
        st.textContent = auth?.connected
          ? `Active: ${auth?.handle ? '@' + auth.handle : (auth?.did || 'your account')}.`
          : 'Not signed in.';
      }
      renderAccounts(auth);
    } catch {}

    const loginHintEl = modal.querySelector('[data-login-hint]');
    const btnOauth = modal.querySelector('[data-oauth]');
    const btnAppLogin = modal.querySelector('[data-app-login]');
    const identEl = modal.querySelector('[data-identifier]');
    const pwEl = modal.querySelector('[data-app-password]');

    const close = () => { modal.hidden = true; };

    const onComplete = async (detail = {}) => {
      const auth = await refresh();
      renderAccounts(auth);
      const did = detail?.did || auth?.did;
      if (did) {
        window.BSKY = window.BSKY || {};
        window.BSKY.meDid = did;
      }
      try { await call('cacheSyncRecent', { minutes: 2, pagesMax: 5 }); } catch {}
      window.dispatchEvent(new CustomEvent('bsky-auth-changed', { detail: { connected: !!auth?.connected, auth } }));
    };

    const oauthHandler = async () => {
      if (busy) return;
      setBusy(true);
      try {
        const loginHint = (loginHintEl?.value || '').trim() || null;
        const res = await call('oauthStart', { loginHint });
        const url = res?.authorizeUrl;
        if (!url) throw new Error('OAuth start failed (missing authorizeUrl)');

        // Listen for completion from callback window.
        const onMsg = async (ev) => {
          // Some environments can flip between www/non-www during OAuth redirects.
          // Accept same-site variants so the UI updates without requiring a manual refresh.
          const origin = String(ev?.origin || '');
          const here = String(window.location.origin || '');
          const variants = new Set([
            here,
            here.replace('://www.', '://'),
            here.replace('://', '://www.'),
          ]);
          if (origin && !variants.has(origin)) return;
          const data = ev?.data;
          if (!data || data.type !== 'bsky-oauth-complete') return;
          window.removeEventListener('message', onMsg);
          if (!data.ok) {
            alert('OAuth connect failed: ' + (data.error || 'unknown error'));
            return;
          }
          close();
          await onComplete({ did: data.did });
        };
        window.addEventListener('message', onMsg);

        const w = window.open(url, 'bsky-oauth', 'popup=yes,width=520,height=720');
        if (!w) {
          window.removeEventListener('message', onMsg);
          throw new Error('Popup blocked. Please allow popups for this site.');
        }

        // Fallback: if postMessage is blocked/missed, poll authStatus until connected.
        const startedAt = Date.now();
        const poll = setInterval(async () => {
          try {
            if (w.closed) {
              clearInterval(poll);
              window.removeEventListener('message', onMsg);
              await onComplete({});
              return;
            }
            if (Date.now() - startedAt > 2 * 60 * 1000) {
              clearInterval(poll);
              return;
            }
            const auth = await call('authStatus', {});
            if (auth?.connected) {
              clearInterval(poll);
              window.removeEventListener('message', onMsg);
              close();
              await onComplete({ did: auth?.did });
            }
          } catch {
            // ignore polling errors
          }
        }, 1000);
      } catch (e) {
        alert('Connect failed: ' + (e?.message || e));
      } finally {
        setBusy(false);
      }
    };

    const appPasswordHandler = async () => {
      if (busy) return;
      const identifier = (identEl?.value || '').trim();
      const password = (pwEl?.value || '').trim();
      if (!identifier || !password) {
        alert('Please enter identifier + app password.');
        return;
      }
      setBusy(true);
      try {
        const res = await call('authLogin', { identifier, appPassword: password });
        close();
        await onComplete({ did: res?.profile?.did || res?.session?.did });
      } catch (e) {
        alert('Connect failed: ' + (e?.message || e));
      } finally {
        setBusy(false);
      }
    };

    if (btnOauth) btnOauth.onclick = oauthHandler;
    if (btnAppLogin) btnAppLogin.onclick = appPasswordHandler;

    if (!modal.dataset.boundAccounts) {
      modal.dataset.boundAccounts = '1';

      modal.querySelector('[data-logout-all]')?.addEventListener('click', async () => {
        if (busy) return;
        if (!window.confirm('Disconnect ALL Bluesky accounts for this Concrete user?')) return;
        setBusy(true);
        try {
          await call('authLogoutAll', {});
          const auth = await refresh();
          renderAccounts(auth);
          if (window.BSKY) delete window.BSKY.meDid;
          window.dispatchEvent(new CustomEvent('bsky-auth-changed', { detail: { connected: !!auth?.connected, auth } }));
        } catch (e) {
          alert('Disconnect all failed: ' + (e?.message || e));
        } finally {
          setBusy(false);
        }
      });

      modal.addEventListener('click', async (ev) => {
        const setBtn = ev.target?.closest?.('[data-set-active]');
        const rmBtn = ev.target?.closest?.('[data-remove]');
        if (!setBtn && !rmBtn) return;
        if (busy) return;

        const did = (setBtn?.getAttribute('data-set-active') || rmBtn?.getAttribute('data-remove') || '').trim();
        if (!did) return;

        setBusy(true);
        try {
          if (setBtn) {
            await call('accountsSetActive', { did });
            const auth = await refresh();
            renderAccounts(auth);
            window.dispatchEvent(new CustomEvent('bsky-auth-changed', { detail: { connected: !!auth?.connected, auth } }));
          }
          if (rmBtn) {
            if (!window.confirm('Disconnect this Bluesky account?')) return;
            await call('accountsRemove', { did });
            const auth = await refresh();
            renderAccounts(auth);
            window.dispatchEvent(new CustomEvent('bsky-auth-changed', { detail: { connected: !!auth?.connected, auth } }));
          }
        } catch (e) {
          alert('Account action failed: ' + (e?.message || e));
        } finally {
          setBusy(false);
        }
      });
    }
  });

  btnDisconnect?.addEventListener('click', async () => {
    if (busy) return;
    if (!window.confirm('Disconnect your Bluesky session for this Concrete user?')) return;

    setBusy(true);
    try {
      await call('authLogout', {});
      const auth = await refresh();
      if (window.BSKY) delete window.BSKY.meDid;
      window.dispatchEvent(new CustomEvent('bsky-auth-changed', { detail: { connected: false, auth } }));
    } catch (e) {
      alert('Disconnect failed: ' + (e?.message || e));
    } finally {
      setBusy(false);
    }
  });

  refresh();
}

// Backwards compatibility: if someone includes a legacy container with this ID.
export function bootAuthControls() {
  const root = document.getElementById('bsky-auth-controls');
  if (!root) return;
  bindAuthControls(root);
}
