import { call } from '../../../api.js';

export class BskyPeoplePanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this.loading = false;
    this.checking = false;
    this.error = '';

    this.watchlist = [];
    this.profilesByDid = new Map();

    this.lastCheck = null; // { checkedAt, results }
  }

  connectedCallback() {
    this.render();
    this.load();

    this.shadowRoot.addEventListener('submit', (e) => {
      const form = e.target.closest('form[data-add]');
      if (!form) return;
      e.preventDefault();
      this.addFromForm(form);
    });

    this.shadowRoot.addEventListener('click', (e) => {
      const btnAdd = e.target.closest('button[data-action="add"]');
      if (btnAdd) {
        e.preventDefault();
        const form = this.shadowRoot.querySelector('form[data-add]');
        if (form) this.addFromForm(form);
        return;
      }

      const btnRemove = e.target.closest('button[data-action="remove"]');
      if (btnRemove) {
        e.preventDefault();
        const did = btnRemove.getAttribute('data-did') || '';
        if (did) this.remove(did);
        return;
      }

      const btnRefresh = e.target.closest('button[data-action="refresh"]');
      if (btnRefresh) {
        e.preventDefault();
        this.load();
        return;
      }

      const btnCheck = e.target.closest('button[data-action="check"]');
      if (btnCheck) {
        e.preventDefault();
        this.checkNow();
        return;
      }

      const btnOpen = e.target.closest('button[data-action="open"]');
      if (btnOpen) {
        e.preventDefault();
        const uri = btnOpen.getAttribute('data-uri') || '';
        const cid = btnOpen.getAttribute('data-cid') || '';
        if (!uri) return;
        this.dispatchEvent(new CustomEvent('bsky-open-content', {
          detail: { uri, cid, spawnAfter: 'people' },
          bubbles: true,
          composed: true,
        }));
      }
    });
  }

  setError(msg) {
    this.error = String(msg || '');
    this.render();
  }

  async load() {
    this.loading = true;
    this.setError('');
    this.render();

    try {
      const res = await call('watchListList', { includeStats: true });
      const list = Array.isArray(res?.watchlist) ? res.watchlist : [];
      const profiles = Array.isArray(res?.profiles) ? res.profiles : [];

      this.watchlist = list;
      this.profilesByDid = new Map(profiles.map((p) => [p.did, p]));
    } catch (e) {
      this.setError(e?.message || String(e));
    } finally {
      this.loading = false;
      this.render();
    }
  }

  async addFromForm(form) {
    const input = form.querySelector('input[name="actor"]');
    const actor = (input?.value || '').trim();
    if (!actor) return;

    try {
      input?.setAttribute('disabled', '');
      this.setError('');
      await call('watchListAdd', { actor, prime: true });
      try { input.value = ''; } catch {}
      await this.load();
    } catch (e) {
      this.setError(e?.message || String(e));
    } finally {
      try { input?.removeAttribute('disabled'); } catch {}
    }
  }

  async remove(did) {
    if (!did) return;
    if (!confirm('Remove from watchlist?')) return;

    try {
      this.setError('');
      await call('watchListRemove', { did });
      await this.load();
    } catch (e) {
      this.setError(e?.message || String(e));
    }
  }

  async checkNow() {
    if (this.checking) return;
    this.checking = true;
    this.setError('');
    this.render();

    try {
      const res = await call('watchCheck', {
        hours: 72,
        pagesMax: 2,
        perUserMaxReturn: 15,
        scanLimit: 200,
        storeEvents: true,
      });
      this.lastCheck = {
        checkedAt: res?.checkedAt || null,
        results: Array.isArray(res?.results) ? res.results : [],
      };

      // Refresh list so lastChecked/lastSeen updates show up.
      await this.load();
    } catch (e) {
      this.setError(e?.message || String(e));
    } finally {
      this.checking = false;
      this.render();
    }
  }

  fmtProfile(did) {
    const p = this.profilesByDid.get(did);
    if (!p) return { title: did, sub: '' };
    const title = p.displayName ? `${p.displayName}` : (p.handle || did);
    const sub = p.displayName && p.handle ? `@${p.handle}` : (p.handle ? `@${p.handle}` : did);
    return { title, sub, avatar: p.avatar || '' };
  }

  snippetFromFeedItem(item) {
    try {
      const text = item?.post?.record?.text || '';
      return String(text).trim().replace(/\s+/g, ' ').slice(0, 240);
    } catch {
      return '';
    }
  }

  uriFromFeedItem(item) {
    try { return String(item?.post?.uri || ''); } catch { return ''; }
  }

  cidFromFeedItem(item) {
    try { return String(item?.post?.cid || ''); } catch { return ''; }
  }

  render() {
    const list = Array.isArray(this.watchlist) ? this.watchlist : [];
    const last = this.lastCheck;

    const renderRow = (w) => {
      const did = String(w?.watchedDid || '');
      const { title, sub, avatar } = this.fmtProfile(did);
      const stats = w?.stats || null;

      return `
        <div class="row">
          <div class="who">
            ${avatar ? `<img class="av" src="${avatar}" alt="" loading="lazy" />` : `<div class="av ph"></div>`}
            <div class="meta">
              <div class="title">${escapeHtml(title)}</div>
              <div class="sub">${escapeHtml(sub || did)}</div>
              <div class="tiny">
                ${stats ? `${stats.cachedPosts24h} posts/24h • ${stats.cachedPosts7d} posts/7d • ${stats.cachedTotalPosts} cached` : ''}
              </div>
              <div class="tiny">
                Last checked: ${escapeHtml(w?.lastCheckedAt || '—')} • Last seen post: ${escapeHtml(w?.lastSeenPostCreatedAt || '—')}
              </div>
            </div>
          </div>
          <div class="actions">
            <button data-action="remove" data-did="${escapeAttr(did)}" ${this.loading || this.checking ? 'disabled' : ''}>Remove</button>
          </div>
        </div>
      `;
    };

    const renderNewPosts = () => {
      if (!last || !Array.isArray(last.results) || !last.results.length) return '';

      const blocks = last.results
        .filter((r) => r && r.ok)
        .map((r) => {
          const did = String(r.watchedDid || '');
          const { title, sub } = this.fmtProfile(did);
          const newCount = Number.isFinite(r.newCount) ? r.newCount : (Array.isArray(r.newPosts) ? r.newPosts.length : 0);
          const items = Array.isArray(r.newPosts) ? r.newPosts : [];

          const lines = items.map((it) => {
            const uri = this.uriFromFeedItem(it);
            const cid = this.cidFromFeedItem(it);
            const snip = this.snippetFromFeedItem(it) || '(no text)';
            const createdAt = it?.post?.record?.createdAt || '';
            return `
              <div class="post">
                <div class="postline">
                  <div class="postmeta">${escapeHtml(createdAt)}</div>
                  <button data-action="open" data-uri="${escapeAttr(uri)}" data-cid="${escapeAttr(cid)}">Open</button>
                </div>
                <div class="posttext">${escapeHtml(snip)}</div>
              </div>
            `;
          }).join('');

          return `
            <div class="block">
              <div class="blockhdr">
                <div>
                  <div class="title">${escapeHtml(title)}</div>
                  <div class="sub">${escapeHtml(sub || did)}</div>
                </div>
                <div class="count">${newCount} new</div>
              </div>
              ${lines || `<div class="tiny">No new posts (or initialized).</div>`}
            </div>
          `;
        }).join('');

      return `
        <div class="section">
          <div class="sechdr">Last check: ${escapeHtml(last.checkedAt || '—')}</div>
          ${blocks || `<div class="tiny">No results.</div>`}
        </div>
      `;
    };

    this.shadowRoot.innerHTML = `
      <style>
        :host, *, *::before, *::after{box-sizing:border-box}
        :host{display:block}
        .wrap{display:flex;flex-direction:column;gap:10px}
        .controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
        input{appearance:none;background:#111;border:1px solid #333;color:#fff;border-radius:var(--bsky-radius, 0px);padding:8px 10px;min-width:240px}
        button{appearance:none;background:#111;border:1px solid #333;color:#fff;border-radius:var(--bsky-radius, 0px);padding:8px 10px;cursor:pointer;font-weight:900}
        button:hover{background:#1b1b1b}
        button:disabled{opacity:.6;cursor:not-allowed}
        .err{color:#ffb4b4;background:rgba(255,0,0,.12);border:1px solid rgba(255,0,0,.25);padding:8px 10px}
        .tiny{opacity:.75;font-size:12px}
        .list{display:flex;flex-direction:column;gap:8px}
        .row{display:flex;justify-content:space-between;gap:10px;border:1px solid rgba(255,255,255,.10);padding:8px 10px;background:rgba(255,255,255,.03)}
        .who{display:flex;gap:10px;align-items:flex-start}
        .av{width:36px;height:36px;border-radius:999px;object-fit:cover;border:1px solid rgba(255,255,255,.15)}
        .av.ph{background:rgba(255,255,255,.08)}
        .meta{display:flex;flex-direction:column;gap:2px}
        .title{font-weight:900}
        .sub{opacity:.75;font-size:12px}
        .actions{display:flex;gap:8px;align-items:flex-start}
        .section{margin-top:6px;border-top:1px solid rgba(255,255,255,.10);padding-top:10px}
        .sechdr{font-weight:900;margin-bottom:8px}
        .block{border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);padding:10px;margin-bottom:10px}
        .blockhdr{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px}
        .count{font-weight:900;opacity:.85}
        .post{border-top:1px solid rgba(255,255,255,.08);padding-top:8px;margin-top:8px}
        .postline{display:flex;justify-content:space-between;gap:10px;align-items:center}
        .postmeta{opacity:.75;font-size:12px}
        .posttext{margin-top:6px;white-space:pre-wrap;word-break:break-word}
      </style>

      <bsky-panel-shell dense title="People">
        <div class="wrap">
          <div class="controls">
            <form data-add>
              <input name="actor" placeholder="handle (eg alice.bsky.social) or did:..." ${this.loading || this.checking ? 'disabled' : ''} />
            </form>
            <button data-action="add" ${this.loading || this.checking ? 'disabled' : ''}>Add</button>
            <button data-action="check" ${this.checking ? 'disabled' : ''}>${this.checking ? 'Checking…' : 'Check now'}</button>
            <button data-action="refresh" ${this.loading ? 'disabled' : ''}>${this.loading ? 'Loading…' : 'Refresh'}</button>
            <div class="tiny">Watchlist is tied to your current Bluesky account.</div>
          </div>

          ${this.error ? `<div class="err">${escapeHtml(this.error)}</div>` : ''}

          <div class="list">
            ${list.length ? list.map(renderRow).join('') : `<div class="tiny">No watched people yet.</div>`}
          </div>

          ${renderNewPosts()}
        </div>
      </bsky-panel-shell>
    `;
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/\n/g, ' ');
}

customElements.define('bsky-people-panel', BskyPeoplePanel);
