import { call } from '../../../api.js';
import { identityCss, identityHtml, bindCopyClicks } from '../../../lib/identity.js';
import { renderPostCard } from '../../../components/interactions/utils.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));

// Convert at://did/app.bsky.feed.post/rkey → https://bsky.app/profile/did/post/rkey
const atUriToWebPost = (uri) => {
  const m = String(uri || '').match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)/);
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : '';
};

export class BskyContentPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this._selection = null; // { uri, cid }
    this._loading = false;
    this._error = null;
    this._thread = null; // getPostThread().thread
    this._replyTo = null; // { uri, cid, author }
    this._posting = false;

    this._view = 'replies'; // replies|reposts|quotes|likes
    this._eng = {
      loading: false,
      error: null,
      likes: null,
      reposts: null,
      quotes: null,
      followMap: {},
    };

    this._replyPostedHandler = null;
  }

  pickThreadRootRef(thread) {
    try {
      let cur = thread;
      while (cur?.parent?.post) cur = cur.parent;
      const p = cur?.post || null;
      const uri = String(p?.uri || '');
      const cid = String(p?.cid || '');
      return (uri && cid) ? { uri, cid } : null;
    } catch {
      return null;
    }
  }

  setSelection(sel) {
    const uri = String(sel?.uri || '');
    const cid = String(sel?.cid || '');
    const view = String(sel?.view || sel?.tab || '');
    this._selection = uri ? { uri, cid } : null;
    this._replyTo = null;
    this._thread = null;
    this._error = null;
    this._view = (view === 'reposts' || view === 'quotes' || view === 'likes' || view === 'replies') ? view : 'replies';
    this._eng = { ...this._eng, loading: false, error: null, likes: null, reposts: null, quotes: null, followMap: {} };
    this.render();
    if (this._selection) this.load();
  }

  setView(view) {
    const v = String(view || '');
    const next = (v === 'reposts' || v === 'quotes' || v === 'likes' || v === 'replies') ? v : 'replies';
    if (this._view === next) return;
    this._view = next;
    this.render();
    this._maybeLoadEngagement();
  }

  connectedCallback() {
    this.render();
    this.shadowRoot.addEventListener('click', (e) => this.onClick(e));
    bindCopyClicks(this.shadowRoot);
    this.shadowRoot.addEventListener('bsky-reply-to', (e) => {
      const d = e?.detail || null;
      this._replyTo = d?.uri ? { uri: String(d.uri), cid: String(d.cid || ''), author: String(d.author || '') } : null;
      const composer = this.shadowRoot.querySelector('bsky-comment-composer');
      composer?.setReplyTo?.(this._replyTo);
    });
    this.shadowRoot.addEventListener('bsky-submit-comment', (e) => {
      this.submitComment(e?.detail || null);
    });

    // If a reply is posted elsewhere into the currently open thread, refresh this view.
    if (!this._replyPostedHandler) {
      this._replyPostedHandler = (e) => {
        if (this._loading || this._posting) return;
        const d = e?.detail || {};
        const rootUri = String(d?.rootUri || '');
        if (!rootUri || !this._thread) return;
        const currentRoot = this.pickThreadRootRef(this._thread);
        if (!currentRoot?.uri) return;
        if (String(currentRoot.uri) !== rootUri) return;
        this.load();
      };
    }
    window.addEventListener('bsky-reply-posted', this._replyPostedHandler);
  }

  disconnectedCallback() {
    if (this._replyPostedHandler) window.removeEventListener('bsky-reply-posted', this._replyPostedHandler);
  }

  async submitComment(detail) {
    if (this._posting) return;
    const text = String(detail?.text || '').trim();
    if (!text) return;

    const replyTo = detail?.replyTo || null;
    const parentUri = String(replyTo?.uri || '');
    const parentCid = String(replyTo?.cid || '');
    if (!parentUri || !parentCid) {
      this._error = 'Missing reply target (uri/cid). Click Reply on a post first.';
      this.render();
      return;
    }

    const rootRef = this.pickThreadRootRef(this._thread) || { uri: parentUri, cid: parentCid };

    const images = Array.isArray(detail?.media?.images) ? detail.media.images : [];
    const uploaded = [];

    this._posting = true;
    this._error = null;
    this.render();

    try {
      for (const img of images) {
        const mime = String(img?.mime || '');
        const dataBase64 = String(img?.dataBase64 || '');
        if (!mime || !dataBase64) continue;
        const res = await call('uploadBlob', { mime, dataBase64 });
        const blob = res?.blob || res?.data?.blob || res?.data || null;
        if (blob) {
          uploaded.push({
            alt: String(img?.alt || ''),
            image: blob,
          });
        }
      }

      const embed = uploaded.length ? {
        $type: 'app.bsky.embed.images',
        images: uploaded,
      } : null;

      await call('createPost', {
        text,
        reply: {
          root: { uri: rootRef.uri, cid: rootRef.cid },
          parent: { uri: parentUri, cid: parentCid },
        },
        ...(embed ? { embed } : {}),
      });

      // Ensure cached feeds can see the new reply.
      // Prefer the throttled global sync (handled centrally), but fall back to a direct sync if the
      // notification bar isn't present/connected.
      try {
        if (window.BSKY?.cacheAvailable !== false) {
          const notifBar = document.querySelector('bsky-notification-bar');
          const canUseThrottledSync = !!(notifBar && notifBar.isConnected);

          if (canUseThrottledSync) {
            window.dispatchEvent(new CustomEvent('bsky-sync-recent', { detail: { minutes: 10 } }));
          } else {
            await call('cacheSyncRecent', { minutes: 10 });
            window.dispatchEvent(new CustomEvent('bsky-refresh-recent', { detail: { minutes: 30 } }));
          }
        }
      } catch {}

      // Notify other panels (Posts) to update reply counts / refresh.
      try {
        window.dispatchEvent(new CustomEvent('bsky-reply-posted', {
          detail: { uri: parentUri, rootUri: rootRef.uri },
        }));
      } catch {}

      // Clear reply target and refresh thread.
      this._replyTo = null;
      await this.load();
    } catch (e) {
      this._error = e?.message || String(e || 'Failed to post reply');
      this.render();
    } finally {
      this._posting = false;
      this.render();
    }
  }

  onClick(e) {
    if (e.target?.closest?.('[data-close]')) {
      this.dispatchEvent(new CustomEvent('bsky-close-content', { bubbles: true, composed: true }));
      return;
    }

    const tab = e.target?.closest?.('[data-tab]')?.getAttribute?.('data-tab');
    if (tab) {
      this.setView(tab);
      return;
    }

    const followDid = e.target?.closest?.('[data-follow-did]')?.getAttribute?.('data-follow-did');
    if (followDid) {
      this.followOne(followDid);
      return;
    }
    if (e.target?.closest?.('[data-follow-all]')) {
      this.followAll();
      return;
    }
  }

  async load() {
    if (!this._selection?.uri || this._loading) return;
    this._loading = true;
    this._error = null;
    this.render();

    try {
      const out = await call('getPostThread', { uri: this._selection.uri, depth: 10, parentHeight: 6 });
      this._thread = out?.thread || null;
    } catch (e) {
      this._error = e?.message || String(e || 'Failed to load thread');
      this._thread = null;
    } finally {
      this._loading = false;
      this.render();
      this._maybeLoadEngagement();
    }
  }

  async _maybeLoadEngagement() {
    if (!this._selection?.uri) return;
    if (this._eng.loading) return;

    const uri = String(this._selection.uri || '');
    const view = String(this._view || 'replies');
    if (view === 'replies') return;

    if (view === 'likes' && Array.isArray(this._eng.likes)) return;
    if (view === 'reposts' && Array.isArray(this._eng.reposts)) return;
    if (view === 'quotes' && Array.isArray(this._eng.quotes)) return;

    this._eng = { ...this._eng, loading: true, error: null };
    this.render();

    try {
      if (view === 'likes') {
        const res = await call('getLikes', { uri, limit: 100 });
        const items = (res?.likes || []).map((l) => ({
          did: l.actor?.did,
          handle: l.actor?.handle,
          displayName: l.actor?.displayName,
          avatar: l.actor?.avatar,
          when: l.indexedAt || l.createdAt,
        }));
        const followMap = await this._loadFollowMap(items.map((i) => i.did));
        this._eng = { ...this._eng, likes: items, followMap };
      } else if (view === 'reposts') {
        const res = await call('getRepostedBy', { uri, limit: 100 });
        const items = (res?.repostedBy || []).map((a) => ({
          did: a?.did,
          handle: a?.handle,
          displayName: a?.displayName,
          avatar: a?.avatar,
          when: a.indexedAt,
        }));
        const followMap = await this._loadFollowMap(items.map((i) => i.did));
        this._eng = { ...this._eng, reposts: items, followMap };
      } else if (view === 'quotes') {
        const res = await call('getQuotes', { uri, limit: 50 });
        const posts = Array.isArray(res?.posts) ? res.posts : [];
        // Follow-map for quote authors (best-effort).
        const dids = posts.map((p) => p?.author?.did).filter(Boolean);
        const followMap = await this._loadFollowMap(dids);
        this._eng = { ...this._eng, quotes: posts, followMap };
      }
    } catch (e) {
      this._eng = { ...this._eng, error: e?.message || String(e || 'Failed to load engagement') };
    } finally {
      this._eng = { ...this._eng, loading: false };
      this.render();
    }
  }

  async _loadFollowMap(dids = []) {
    const uniq = Array.from(new Set((dids || []).filter(Boolean)));
    if (!uniq.length) return {};
    try {
      const rel = await call('getRelationships', { actors: uniq });
      const map = {};
      (rel?.relationships || []).forEach((r) => { if (r?.did) map[r.did] = { following: !!r.following }; });
      return map;
    } catch {
      return {};
    }
  }

  async followOne(did) {
    const d = String(did || '');
    if (!d) return;
    try {
      await call('follow', { did: d });
      this._eng.followMap = { ...(this._eng.followMap || {}), [d]: { following: true } };
      this.render();
    } catch (e) {
      // Keep it simple; Content panel isn't a modal.
      this._eng.error = 'Follow failed: ' + (e?.message || String(e || 'unknown'));
      this.render();
    }
  }

  async followAll() {
    const view = String(this._view || 'replies');
    const followMap = this._eng.followMap || {};
    let dids = [];
    if (view === 'likes') dids = (this._eng.likes || []).map((i) => i.did);
    else if (view === 'reposts') dids = (this._eng.reposts || []).map((i) => i.did);
    else if (view === 'quotes') dids = (this._eng.quotes || []).map((p) => p?.author?.did);
    dids = Array.from(new Set(dids.filter(Boolean))).filter((d) => !followMap[d]?.following);
    if (!dids.length) return;
    try {
      await call('followMany', { dids });
      const next = { ...(followMap || {}) };
      dids.forEach((d) => { next[d] = { following: true }; });
      this._eng.followMap = next;
      this.render();
    } catch (e) {
      this._eng.error = 'Bulk follow failed: ' + (e?.message || String(e || 'unknown'));
      this.render();
    }
  }

  render() {
    const uri = this._selection?.uri || '';
    const open = uri ? atUriToWebPost(uri) : '';
    const view = String(this._view || 'replies');

    const tabs = [
      { id: 'replies', label: 'Replies', icon: '💬' },
      { id: 'reposts', label: 'Reposts', icon: '🔁' },
      { id: 'quotes', label: 'Quotes', icon: '❝❞' },
      { id: 'likes', label: 'Likes', icon: '♥' },
    ];

    const followAllDisabled = (() => {
      const m = this._eng.followMap || {};
      if (view === 'likes') return (this._eng.likes || []).every((i) => !i?.did || m[i.did]?.following);
      if (view === 'reposts') return (this._eng.reposts || []).every((i) => !i?.did || m[i.did]?.following);
      if (view === 'quotes') return (this._eng.quotes || []).every((p) => !p?.author?.did || m[p.author.did]?.following);
      return true;
    })();

    const renderActorRows = (items = []) => {
      const m = this._eng.followMap || {};
      return (items || []).map((i) => {
        const did = String(i?.did || '');
        const following = !!m?.[did]?.following;
        return `
          <div class="row">
            ${i?.avatar ? `<img class="avatar" src="${esc(i.avatar)}" alt="">` : ''}
            <div class="who">
              <div class="name">${identityHtml({ did, handle: i?.handle, displayName: i?.displayName }, { showHandle: true, showCopyDid: true })}</div>
              <div class="sub">@${esc(i?.handle || '')}</div>
            </div>
            ${following ? `<span class="sub">Following</span>` : `<button class="btn" type="button" data-follow-did="${esc(did)}" title="Follow" aria-label="Follow">➕</button>`}
          </div>
        `;
      }).join('') || '<div class="muted">No entries.</div>';
    };

    const renderQuotes = (posts = []) => {
      if (!posts || !posts.length) return '<div class="muted">No quotes.</div>';
      return posts.map((p) => `<div class="quote">${renderPostCard(p)}</div>`).join('');
    };

    const engagementBody = (() => {
      if (this._eng.loading) return '<div class="muted">Loading…</div>';
      if (this._eng.error) return `<div class="err">${esc(this._eng.error)}</div>`;
      if (view === 'likes') return `<div class="list">${renderActorRows(this._eng.likes || [])}</div>`;
      if (view === 'reposts') return `<div class="list">${renderActorRows(this._eng.reposts || [])}</div>`;
      if (view === 'quotes') return `<div class="quotes">${renderQuotes(this._eng.quotes || [])}</div>`;
      return '';
    })();

    this.shadowRoot.innerHTML = `
      <style>
        :host, *, *::before, *::after{box-sizing:border-box}
        :host{display:block}
        .topRight{display:flex; gap:6px; align-items:center}
        .btn{appearance:none; border:1px solid #333; background:#111; color:#fff; border-radius: var(--bsky-radius, 0px); padding:6px 10px; cursor:pointer}
        .btn:hover{border-color:#3b5a8f}
        .btn.link{color:#9cd3ff; text-decoration:none}
        .muted{color:#aaa}
        .err{color:#f88}
        .section{margin-bottom:10px}

        .tabs{display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-bottom:10px}
        .tab{appearance:none; border:1px solid #333; background:#111; color:#fff; border-radius: var(--bsky-radius, 0px); padding:6px 10px; cursor:pointer}
        .tab[aria-selected="true"]{border-color:#3b5a8f}

        .actionsRow{display:flex; gap:8px; align-items:center; justify-content:flex-end; margin:10px 0}

        .list{display:grid; gap:6px}
        .row{display:flex; align-items:center; gap:10px; border:1px solid #222; background:#0b0b0b; padding:6px}
        .avatar{width:40px; height:40px; object-fit:cover; flex:0 0 auto; border-radius: var(--bsky-radius, 0px)}
        .who{flex:1 1 auto; min-width:0}
        .name{font-weight:700}
        .sub{color:#bbb; font-size:.9rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}

        .quotes{display:grid; gap:8px}
        .quote{border:1px solid #222; padding:6px; background:#0a0a0a}

        ${identityCss}
      </style>

      <bsky-panel-shell dense title="Content">
        <div slot="head-right" class="topRight">
          ${open ? `<a class="btn link" href="${esc(open)}" target="_blank" rel="noopener" title="Open on Bluesky" aria-label="Open on Bluesky">↗</a>` : ''}
          <button class="btn" type="button" data-close title="Close" aria-label="Close">✕</button>
        </div>

        <div class="tabs" role="tablist" aria-label="Content tabs">
          ${tabs.map((t) => `
            <button class="tab" type="button" role="tab" data-tab="${esc(t.id)}" aria-selected="${t.id === view ? 'true' : 'false'}" title="${esc(t.label)}">
              ${esc(t.icon)}
            </button>
          `).join('')}
        </div>

        <div class="section">
          ${this._loading ? '<div class="muted">Loading thread…</div>' : ''}
          ${this._posting ? '<div class="muted">Posting…</div>' : ''}
          ${this._error ? `<div class="err">Error: ${esc(this._error)}</div>` : ''}
        </div>

        <div class="section">
          ${view === 'replies'
            ? '<bsky-thread-tree></bsky-thread-tree>'
            : `
              <div class="actionsRow">
                <button class="btn" type="button" data-follow-all ${followAllDisabled ? 'disabled' : ''} title="Follow all" aria-label="Follow all">➕</button>
              </div>
              ${engagementBody}
            `
          }
        </div>

        ${view === 'replies' ? `
          <div class="section">
            <bsky-comment-composer></bsky-comment-composer>
          </div>
        ` : ''}
      </bsky-panel-shell>
    `;

    const tree = this.shadowRoot.querySelector('bsky-thread-tree');
    tree?.setThread?.(this._thread);

    const composer = this.shadowRoot.querySelector('bsky-comment-composer');
    composer?.setReplyTo?.(this._replyTo);
  }
}

customElements.define('bsky-content-panel', BskyContentPanel);
