import { call } from '../../../api.js';
import { syncRecent } from '../../../controllers/cache_sync_controller.js';
import { getAuthStatusCached } from '../../../auth_state.js';
import { dispatchToast, getTabsApi, openContentPanel } from '../../panel_api.js';
import { renderPostTextHtml } from '../../../components/interactions/utils.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));

const atUriToWebPost = (uri) => {
  const m = String(uri || '').match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)/);
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : '';
};

function pickText(post) {
  const rec = post?.record || {};
  return String(rec.text || '');
}

function pickAuthorParts(post) {
  const a = post?.author || {};
  return {
    displayName: String(a?.displayName || ''),
    handle: String(a?.handle || ''),
  };
}

function formatAuthor(parts) {
  const displayName = String(parts?.displayName || '');
  const handle = String(parts?.handle || '');
  const at = handle ? `@${handle}` : '';
  return displayName ? `${displayName} ${at}`.trim() : (at || '');
}

function pickTime(post) {
  const rec = post?.record || {};
  const iso = rec?.createdAt || post?.indexedAt || '';
  try {
    return iso ? new Date(iso).toLocaleString() : '';
  } catch {
    return '';
  }
}

function extractImagesFromEmbed(embed) {
  if (!embed) return null;
  const t = String(embed.$type || '');
  if (t.includes('embed.images') && Array.isArray(embed.images) && embed.images.length) {
    return embed.images.map((img) => ({
      src: img.fullsize || img.thumb || '',
      alt: img.alt || '',
      arW: Number(img?.aspectRatio?.width || 0),
      arH: Number(img?.aspectRatio?.height || 0),
    })).filter((i) => i.src);
  }
  return null;
}

function extractVideoFromEmbed(embed) {
  if (!embed) return null;
  const t = String(embed.$type || '');
  if (t.includes('embed.video')) {
    return {
      playlist: String(embed.playlist || ''),
      thumb: String(embed.thumbnail || embed.thumb || ''),
      alt: String(embed.alt || ''),
    };
  }
  return null;
}

function renderImagesGrid(images) {
  if (!images || !images.length) return '';
  return `
    <div class="images-grid">
      ${images.map((i) => `
        <figure class="img-wrap">
          <img src="${esc(i.src)}" alt="${esc(i.alt || '')}" loading="lazy" />
        </figure>
      `).join('')}
    </div>
  `;
}

function renderVideo(video, openUrl = '') {
  if (!video) return '';
  const src = String(video.playlist || '');
  if (!src) return '';
  const poster = video.thumb ? ` poster="${esc(video.thumb)}"` : '';
  // NOTE: Many Bluesky videos are HLS (m3u8). Some browsers can’t play HLS without hls.js.
  const type = src.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4';
  return `
    <div class="video-wrap">
      <video controls playsinline preload="metadata"${poster}>
        <source src="${esc(src)}" type="${esc(type)}" />
      </video>
      ${openUrl ? `<a class="open" href="${esc(openUrl)}" target="_blank" rel="noopener">Open on Bluesky</a>` : ''}
    </div>
  `;
}

export class BskyThreadTree extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._thread = null; // getPostThread().thread
    this._replyTo = null; // { uri, author }
    this._toggleBusy = new Set(); // uri

    this._hideRoot = false;

    this._meDid = '';

    // Hide nodes that have been optimistically deleted.
    this._hiddenUris = new Set();

    // uri -> { open, loading, error, to, text }
    this._translateByUri = new Map();

    // Pending optimistic deletion (undo window).
    // { uri, timerId, startedAt, state, error }
    this._pendingDelete = null;

    // Collapse state for threads with replies.
    this._collapsedUris = new Set();

    this._likeChangedHandler = null;
    this._repostChangedHandler = null;
  }

  _walkThread(node, cb) {
    try {
      const n = node || null;
      if (!n) return;
      cb?.(n);
      const kids = Array.isArray(n?.replies) ? n.replies : [];
      for (const r of kids) this._walkThread(r, cb);
    } catch {
      // ignore
    }
  }

  _collectCollapsibleUris() {
    const out = new Set();
    try {
      const root = this._thread;
      if (!root) return out;

      const ancestors = this.collectAncestors(root);
      for (const n of (ancestors || [])) {
        const p = n?.post || null;
        const uri = String(p?.uri || '').trim();
        const replies = Array.isArray(n?.replies) ? n.replies : [];
        if (uri && replies.length) out.add(uri);
      }

      this._walkThread(root, (n) => {
        const p = n?.post || null;
        const uri = String(p?.uri || '').trim();
        const replies = Array.isArray(n?.replies) ? n.replies : [];
        if (uri && replies.length) out.add(uri);
      });
    } catch {
      // ignore
    }
    return out;
  }

  _collapseAll() {
    this._collapsedUris = this._collectCollapsibleUris();
    this.render();
  }

  _expandAll() {
    try { this._collapsedUris?.clear?.(); } catch {}
    this.render();
  }

  _toggleCollapseUri(uri) {
    const u = String(uri || '').trim();
    if (!u) return;
    if (this._collapsedUris.has(u)) this._collapsedUris.delete(u);
    else this._collapsedUris.add(u);
    this.render();
  }

  _openUriInPanel({ uri, cid } = {}) {
    const u = String(uri || '').trim();
    if (!u) return;
    const c = String(cid || '').trim();

    const api = getTabsApi(this);
    const active = Array.isArray(api?.getActive?.()) ? api.getActive() : [];
    const base = active.find((n) => n && n !== 'content') || 'posts';

    openContentPanel({
      uri: u,
      cid: c,
      spawnAfter: base,
      splitFrom: (base === 'posts') ? 'posts' : '',
      pinOthers: (base === 'posts'),
    }, this);
  }

  async _copyToClipboard(text) {
    const s = String(text || '');
    if (!s) return false;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(s);
        return true;
      }
    } catch {}

    try {
      const ta = document.createElement('textarea');
      ta.value = s;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch {
      return false;
    }
  }

  async _shareOrCopyUrl(url, title = '') {
    const u = String(url || '').trim();
    if (!u) return;
    try {
      if (navigator?.share) {
        await navigator.share({ title: String(title || ''), url: u });
        dispatchToast(this, { kind: 'success', message: 'Share opened.', timeoutMs: 1800 });
        return;
      }
    } catch {
      // fall back to copy
    }

    const ok = await this._copyToClipboard(u);
    dispatchToast(this, {
      kind: ok ? 'success' : 'error',
      message: ok ? 'Link copied.' : 'Could not copy link.',
      timeoutMs: 2200,
    });
  }

  _clearPendingDelete() {
    const pd = this._pendingDelete;
    if (pd?.timerId) {
      try { clearTimeout(pd.timerId); } catch {}
    }
    this._pendingDelete = null;
  }

  _renderDeleteToast() {
    const pd = this._pendingDelete;
    if (!pd?.uri) return '';
    const label = (pd.state === 'deleting')
      ? 'Deleting…'
      : (pd.state === 'failed')
        ? `Delete failed: ${esc(pd.error || 'Unknown error')}`
        : 'Post removed.';
    const canUndo = (pd.state === 'pending');
    const canDismiss = (pd.state === 'failed');
    return `
      <div class="toast" role="status" aria-live="polite">
        <div class="toast-msg">${esc(label)}</div>
        <div class="toast-actions">
          ${canUndo ? `<button class="toast-btn" type="button" data-undo-delete>Undo</button>` : ''}
          ${canDismiss ? `<button class="toast-btn" type="button" data-dismiss-toast>Dismiss</button>` : ''}
        </div>
      </div>
    `;
  }

  _startOptimisticDelete(uri) {
    const target = String(uri || '').trim();
    if (!target) return;

    // If a previous delete is pending, undo it before starting another.
    if (this._pendingDelete?.state === 'pending') {
      try { this._hiddenUris.delete(String(this._pendingDelete.uri || '')); } catch {}
      this._clearPendingDelete();
    } else {
      this._clearPendingDelete();
    }

    this._hiddenUris.add(target);

    const pd = {
      uri: target,
      timerId: null,
      startedAt: Date.now(),
      state: 'pending',
      error: null,
    };
    pd.timerId = setTimeout(() => this._finalizePendingDelete(), 6000);
    this._pendingDelete = pd;
    this.render();
  }

  _undoOptimisticDelete() {
    const pd = this._pendingDelete;
    if (!pd?.uri || pd.state !== 'pending') return;
    try { this._hiddenUris.delete(String(pd.uri)); } catch {}
    this._clearPendingDelete();
    this.render();
  }

  async _finalizePendingDelete() {
    const pd = this._pendingDelete;
    if (!pd?.uri || pd.state !== 'pending') return;
    pd.state = 'deleting';
    this.render();

    try {
      await call('deletePost', { uri: pd.uri });

      try {
        window.dispatchEvent(new CustomEvent('bsky-post-deleted', { detail: { uri: pd.uri } }));
      } catch {}

      try {
        await syncRecent({ minutes: 10, refreshMinutes: 30, allowDirectFallback: false });
      } catch {}

      this._clearPendingDelete();
      this.render();
    } catch (e) {
      // Restore on failure.
      try { this._hiddenUris.delete(String(pd.uri)); } catch {}
      pd.state = 'failed';
      pd.error = e?.message || String(e || 'Delete failed');
      this.render();
    }
  }

  applyEngagementPatch(patch) {
    const uri = String(patch?.uri || '');
    if (!uri) return;

    const post = this._findPostByUriInThread(uri);
    if (!post) return;

    post.viewer = post.viewer || {};

    if (typeof patch?.liked === 'boolean') {
      if (patch.liked) post.viewer.like = post.viewer.like || { uri: 'local' };
      else {
        try { delete post.viewer.like; } catch { post.viewer.like = null; }
      }
    }
    if (typeof patch?.reposted === 'boolean') {
      if (patch.reposted) post.viewer.repost = post.viewer.repost || { uri: 'local' };
      else {
        try { delete post.viewer.repost; } catch { post.viewer.repost = null; }
      }
    }
    if (typeof patch?.likeCount === 'number') post.likeCount = Math.max(0, patch.likeCount);
    if (typeof patch?.repostCount === 'number') post.repostCount = Math.max(0, patch.repostCount);

    this.render();
  }

  _findPostByUriInThread(uri) {
    const target = String(uri || '');
    if (!target) return null;

    const visit = (node) => {
      if (!node) return null;
      const p = node?.post || null;
      if (p && String(p.uri || '') === target) return p;

      const replies = Array.isArray(node?.replies) ? node.replies : [];
      for (const r of replies) {
        const hit = visit(r);
        if (hit) return hit;
      }
      return null;
    };

    // Root + replies
    let hit = visit(this._thread);
    if (hit) return hit;

    // Ancestors (via parent chain)
    try {
      let cur = this._thread?.parent || null;
      while (cur) {
        const p = cur?.post || null;
        if (p && String(p.uri || '') === target) return p;
        cur = cur.parent || null;
      }
    } catch {}

    return null;
  }

  collectAncestors(node) {
    const out = [];
    try {
      let cur = node?.parent || null;
      while (cur && cur.post) {
        out.push(cur);
        cur = cur.parent || null;
      }
    } catch {}
    return out.reverse();
  }

  setThread(thread, opts = null) {
    this._thread = thread || null;
    try {
      const o = (opts && typeof opts === 'object') ? opts : null;
      if (o && typeof o.hideRoot === 'boolean') this._hideRoot = o.hideRoot;
      // Attribute can override as well.
      if (this.hasAttribute('hide-root') || this.hasAttribute('data-hide-root')) this._hideRoot = true;
    } catch {
      // ignore
    }
    this.render();
  }

  setReplyTo(replyTo) {
    this._replyTo = replyTo || null;
    this.render();
  }

  connectedCallback() {
    this.render();
    this.shadowRoot.addEventListener('click', (e) => this.onClick(e));

    // Best-effort: load current DID so we can show Delete on your own posts.
    try {
      getAuthStatusCached(1500)
        .then((auth) => {
          this._meDid = String(auth?.activeDid || auth?.did || '');
          this.render();
        })
        .catch(() => {});
    } catch {}

    // Keep this thread view in sync with actions taken elsewhere (Posts panel, modals, etc).
    if (!this._likeChangedHandler) {
      this._likeChangedHandler = (e) => {
        const d = e?.detail || {};
        const uri = String(d?.uri || '');
        if (!uri) return;
        const liked = (typeof d?.liked === 'boolean') ? d.liked : undefined;
        const likeCount = (typeof d?.likeCount === 'number') ? d.likeCount : undefined;
        this.applyEngagementPatch({ uri, liked, likeCount });
      };
    }
    if (!this._repostChangedHandler) {
      this._repostChangedHandler = (e) => {
        const d = e?.detail || {};
        const uri = String(d?.uri || '');
        if (!uri) return;
        const reposted = (typeof d?.reposted === 'boolean') ? d.reposted : undefined;
        const repostCount = (typeof d?.repostCount === 'number') ? d.repostCount : undefined;
        this.applyEngagementPatch({ uri, reposted, repostCount });
      };
    }

    window.addEventListener('bsky-like-changed', this._likeChangedHandler);
    window.addEventListener('bsky-repost-changed', this._repostChangedHandler);
  }

  disconnectedCallback() {
    if (this._likeChangedHandler) window.removeEventListener('bsky-like-changed', this._likeChangedHandler);
    if (this._repostChangedHandler) window.removeEventListener('bsky-repost-changed', this._repostChangedHandler);
    this._clearPendingDelete();
  }

  async onClick(e) {
    if (e.target?.closest?.('[data-collapse-all]')) {
      this._collapseAll();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.target?.closest?.('[data-expand-all]')) {
      this._expandAll();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const toggleBtn = e.target?.closest?.('[data-toggle-collapse-uri]');
    if (toggleBtn) {
      const uri = String(toggleBtn.getAttribute('data-toggle-collapse-uri') || '').trim();
      this._toggleCollapseUri(uri);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const openBtn = e.target?.closest?.('[data-open-panel-uri]');
    if (openBtn) {
      const uri = String(openBtn.getAttribute('data-open-panel-uri') || '').trim();
      const cid = String(openBtn.getAttribute('data-open-panel-cid') || '').trim();
      this._openUriInPanel({ uri, cid });
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const copyBtn = e.target?.closest?.('[data-copy-url]');
    if (copyBtn) {
      const url = String(copyBtn.getAttribute('data-copy-url') || '').trim();
      const ok = await this._copyToClipboard(url);
      dispatchToast(this, {
        kind: ok ? 'success' : 'error',
        message: ok ? 'Link copied.' : 'Could not copy link.',
        timeoutMs: 2200,
      });
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const copyTextBtn = e.target?.closest?.('[data-copy-post-text-uri]');
    if (copyTextBtn) {
      const uri = String(copyTextBtn.getAttribute('data-copy-post-text-uri') || '').trim();
      const post = this._findPostByUriInThread(uri);
      const text = post ? pickText(post) : '';
      const ok = await this._copyToClipboard(text);
      dispatchToast(this, {
        kind: ok ? 'success' : 'error',
        message: ok ? 'Post text copied.' : 'Could not copy post text.',
        timeoutMs: 2200,
      });
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const copyTrBtn = e.target?.closest?.('[data-copy-translation-uri]');
    if (copyTrBtn) {
      const uri = String(copyTrBtn.getAttribute('data-copy-translation-uri') || '').trim();
      const tr = uri ? (this._translateByUri.get(uri) || null) : null;
      const ok = await this._copyToClipboard(String(tr?.text || ''));
      dispatchToast(this, {
        kind: ok ? 'success' : 'error',
        message: ok ? 'Translation copied.' : 'Could not copy translation.',
        timeoutMs: 2200,
      });
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const trBtn = e.target?.closest?.('[data-translate-uri]');
    if (trBtn) {
      const uri = String(trBtn.getAttribute('data-translate-uri') || '').trim();
      if (!uri) return;

      const cur = this._translateByUri.get(uri) || null;
      if (cur && cur.open && !cur.loading) {
        this._translateByUri.set(uri, { ...cur, open: false });
        this.render();
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      const post = this._findPostByUriInThread(uri);
      const text = post ? pickText(post) : '';
      if (!text.trim()) return;

      const to = String((navigator?.language || 'en').split('-')[0] || 'en').toLowerCase();
      this._translateByUri.set(uri, { open: true, loading: true, error: null, to, text: '' });
      this.render();

      try {
        const out = await call('translateText', { text, to, from: 'auto' });
        const translatedText = String(out?.translatedText || out?.data?.translatedText || '');
        this._translateByUri.set(uri, { open: true, loading: false, error: null, to, text: translatedText });
      } catch (err) {
        this._translateByUri.set(uri, { open: true, loading: false, error: String(err?.message || err || 'Translate failed'), to, text: '' });
      }
      this.render();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const shareBtn = e.target?.closest?.('[data-share-url]');
    if (shareBtn) {
      const url = String(shareBtn.getAttribute('data-share-url') || '').trim();
      const title = String(shareBtn.getAttribute('data-share-title') || '').trim();
      await this._shareOrCopyUrl(url, title);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (e.target?.closest?.('[data-undo-delete]')) {
      this._undoOptimisticDelete();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.target?.closest?.('[data-dismiss-toast]')) {
      this._clearPendingDelete();
      this.render();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const delBtn = e.target?.closest?.('[data-delete-uri]');
    if (delBtn) {
      const uri = String(delBtn.getAttribute('data-delete-uri') || '').trim();
      if (!uri) return;
      if (this._pendingDelete?.state === 'pending' && String(this._pendingDelete.uri) === uri) return;

      const ok = confirm('Delete this post? It will be removed immediately, with a short undo window.');
      if (!ok) return;

      this._startOptimisticDelete(uri);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const btn = e.target?.closest?.('[data-reply-uri]');
    if (btn) {
      const uri = btn.getAttribute('data-reply-uri') || '';
      const author = btn.getAttribute('data-reply-author') || '';
      const cid = btn.getAttribute('data-reply-cid') || '';
      this.dispatchEvent(new CustomEvent('bsky-reply-to', {
        detail: { uri, cid, author },
        bubbles: true,
        composed: true,
      }));
      return;
    }

    const rep = e.target?.closest?.('[data-repost-uri]');
    if (rep) {
      const uri = rep.getAttribute('data-repost-uri') || '';
      const cid = rep.getAttribute('data-repost-cid') || '';
      const reposted = rep.getAttribute('data-reposted') === '1';
      if (!uri || !cid) return;
      if (this._toggleBusy.has(uri)) return;

      this._toggleBusy.add(uri);
      try {
        rep.setAttribute('disabled', '');
        await call(reposted ? 'unrepost' : 'repost', { uri, cid });

        const post = this._findPostByUriInThread(uri);
        if (post) {
          post.viewer = post.viewer || {};
          if (reposted) {
            try { delete post.viewer.repost; } catch { post.viewer.repost = null; }
            if (typeof post.repostCount === 'number') post.repostCount = Math.max(0, post.repostCount - 1);
          } else {
            post.viewer.repost = post.viewer.repost || { uri: 'local' };
            if (typeof post.repostCount === 'number') post.repostCount = post.repostCount + 1;
          }
        }

        this.dispatchEvent(new CustomEvent('bsky-repost-changed', {
          detail: {
            uri,
            cid,
            reposted: !reposted,
            repostCount: (typeof post?.repostCount === 'number') ? post.repostCount : null,
          },
          bubbles: true,
          composed: true,
        }));

        try {
          await syncRecent({ minutes: 5, refreshMinutes: 30, allowDirectFallback: false });
        } catch {}

        this.render();
      } catch (err) {
        console.warn('repost toggle failed', err);
      } finally {
        this._toggleBusy.delete(uri);
        try { rep.removeAttribute('disabled'); } catch {}
      }
      return;
    }

    const likeBtn = e.target?.closest?.('[data-like-uri]');
    if (likeBtn) {
      const uri = likeBtn.getAttribute('data-like-uri') || '';
      const cid = likeBtn.getAttribute('data-like-cid') || '';
      const liked = likeBtn.getAttribute('data-liked') === '1';
      if (!uri || !cid) return;
      if (this._toggleBusy.has(uri)) return;

      this._toggleBusy.add(uri);
      try {
        likeBtn.setAttribute('disabled', '');
        await call(liked ? 'unlike' : 'like', { uri, cid });

        const post = this._findPostByUriInThread(uri);
        if (post) {
          post.viewer = post.viewer || {};
          if (liked) {
            try { delete post.viewer.like; } catch { post.viewer.like = null; }
            if (typeof post.likeCount === 'number') post.likeCount = Math.max(0, post.likeCount - 1);
          } else {
            post.viewer.like = post.viewer.like || { uri: 'local' };
            if (typeof post.likeCount === 'number') post.likeCount = post.likeCount + 1;
          }
        }

        this.dispatchEvent(new CustomEvent('bsky-like-changed', {
          detail: {
            uri,
            cid,
            liked: !liked,
            likeCount: (typeof post?.likeCount === 'number') ? post.likeCount : null,
          },
          bubbles: true,
          composed: true,
        }));

        try {
          await syncRecent({ minutes: 5, refreshMinutes: 30, allowDirectFallback: false });
        } catch {}

        this.render();
      } catch (err) {
        console.warn('like toggle failed', err);
      } finally {
        this._toggleBusy.delete(uri);
        try { likeBtn.removeAttribute('disabled'); } catch {}
      }
      return;
    }
  }

  renderNode(node, depth, opts = {}) {
    const post = node?.post || null;
    const uri = post?.uri || '';
    const cid = post?.cid || '';

    if (uri && this._hiddenUris.has(String(uri))) return '';

    const author = pickAuthorParts(post);
    const who = formatAuthor(author);
    const when = pickTime(post);
    const text = pickText(post);
    const textHtml = renderPostTextHtml(text);

    const tr = uri ? (this._translateByUri.get(String(uri)) || null) : null;
    const trBlock = (tr && tr.open) ? (() => {
      if (tr.loading) return `<div class="translate muted">Translating…</div>`;
      if (tr.error) return `<div class="translate err">Translate error: ${esc(tr.error)}</div>`;
      const t = String(tr.text || '');
      if (!t.trim()) return `<div class="translate muted">No translation returned.</div>`;
      return `
        <div class="translate">
          <div class="translate-top">
            <div class="muted">Translation (${esc(String(tr.to || ''))})</div>
            <button class="copy" type="button" data-copy-translation-uri="${esc(uri)}">Copy translation</button>
          </div>
          <div class="translate-text">${renderPostTextHtml(t)}</div>
        </div>
      `;
    })() : '';

    const open = atUriToWebPost(uri);
    const reposted = !!(post?.viewer && post.viewer.repost);
    const liked = !!(post?.viewer && post.viewer.like);

    const embed = post?.embed || null;
    const images = extractImagesFromEmbed(embed);
    const video = extractVideoFromEmbed(embed);
    const embedsHtml = (images?.length ? renderImagesGrid(images) : '') + (video ? renderVideo(video, open) : '');

    const variant = String(opts?.variant || '');

    const meDid = String(this._meDid || '');
    const authorDid = String(post?.author?.did || '');
    const isMine = !!(meDid && authorDid && authorDid === meDid);
    const canDelete = isMine && (variant !== 'ancestor') && uri;
    const deletingThis = !!(this._pendingDelete?.uri && String(this._pendingDelete.uri) === String(uri || ''));

    const replies = Array.isArray(node?.replies) ? node.replies : [];
    const hasReplies = replies.length > 0;

    const isCollapsed = !!(hasReplies && uri && this._collapsedUris.has(String(uri)));
    const repliesLabel = hasReplies ? `${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}` : '';

    return `
      <div class="node ${esc(variant)}" style="--depth:${depth}">
        <div class="card">
          <div class="meta">
            <div class="meta-top">
              <div class="who">
                ${author.displayName ? `<span class="name">${esc(author.displayName)}</span>` : ''}
                ${author.handle ? `<span class="handle">@${esc(author.handle)}</span>` : ''}
                ${(!author.displayName && !author.handle) ? '<span class="name muted">(unknown)</span>' : ''}
              </div>
            </div>
            <div class="meta-bottom">
              <div class="when">${esc(when)}</div>
              ${(open) ? `<a class="open" href="${esc(open)}" target="_blank" rel="noopener">Open</a>` : ''}
              ${(uri) ? `<button class="openpanel" type="button" data-open-panel-uri="${esc(uri)}" data-open-panel-cid="${esc(cid)}">Open in panel</button>` : ''}
              ${(open) ? `<button class="copy" type="button" data-copy-url="${esc(open)}">Copy link</button>` : ''}
              ${(uri) ? `<button class="copy" type="button" data-copy-post-text-uri="${esc(uri)}">Copy text</button>` : ''}
              ${(open) ? `<button class="share" type="button" data-share-url="${esc(open)}" data-share-title="${esc(who)}">Share</button>` : ''}
              ${(variant !== 'ancestor' && uri) ? `<button class="share" type="button" data-translate-uri="${esc(uri)}">${(tr && tr.open) ? 'Hide translation' : 'Translate'}</button>` : ''}
              ${hasReplies && uri ? `<button class="collapse" type="button" data-toggle-collapse-uri="${esc(uri)}">${isCollapsed ? `Expand (${esc(repliesLabel)})` : `Collapse (${esc(repliesLabel)})`}</button>` : ''}
              ${(variant !== 'ancestor' && uri) ? `<button class="reply" type="button" data-reply-uri="${esc(uri)}" data-reply-cid="${esc(cid)}" data-reply-author="${esc(who)}">Reply</button>` : ''}
              ${(variant !== 'ancestor' && uri) ? `<button class="repost" type="button" data-repost-uri="${esc(uri)}" data-repost-cid="${esc(cid)}" data-reposted="${reposted ? '1' : '0'}">${reposted ? 'Undo repost' : 'Repost'}</button>` : ''}
              ${(variant !== 'ancestor' && uri) ? `<button class="like" type="button" data-like-uri="${esc(uri)}" data-like-cid="${esc(cid)}" data-liked="${liked ? '1' : '0'}">${liked ? 'Unlike' : 'Like'}</button>` : ''}
              ${canDelete ? `<button class="delete" type="button" data-delete-uri="${esc(uri)}" ${deletingThis ? 'disabled' : ''}>Delete</button>` : ''}
            </div>
          </div>
          ${text ? `<div class="text">${textHtml}</div>` : '<div class="text muted">(no text)</div>'}
          ${trBlock}
          ${embedsHtml ? `<div class="embeds">${embedsHtml}</div>` : ''}
        </div>
        ${hasReplies
          ? (isCollapsed
            ? `<div class="replies-collapsed muted">Replies hidden (${esc(repliesLabel)}).</div>`
            : `<div class="replies">${replies.map((r) => this.renderNode(r, depth + 1)).join('')}</div>`)
          : ''}
      </div>
    `;
  }

  render() {
    const root = this._thread;
    const ancestors = root ? this.collectAncestors(root) : [];
    const ancestorsHtml = ancestors.length
      ? `<div class="ancestors">${ancestors.map((n) => this.renderNode(n, 0, { variant: 'ancestor' })).join('')}</div>`
      : '';

    const hideRoot = !!this._hideRoot;
    const replies = Array.isArray(root?.replies) ? root.replies : [];
    const repliesHtml = replies.length
      ? `<div class="replies">${replies.map((r) => this.renderNode(r, 0)).join('')}</div>`
      : '<div class="muted">No replies yet.</div>';

    const toast = this._renderDeleteToast();

    const actions = root ? `
      <div class="thread-actions" role="toolbar" aria-label="Thread actions">
        <button type="button" class="act" data-collapse-all>Collapse all</button>
        <button type="button" class="act" data-expand-all>Expand all</button>
      </div>
    ` : '';

    this.shadowRoot.innerHTML = `
      <style>
        :host, *, *::before, *::after{box-sizing:border-box}
        :host{display:block}
        .muted{color:#aaa}
        .err{color:#f0a2a2}

        .translate{margin:10px 0 0 0; padding:10px; border:1px solid #2b2b2b; background:#0f0f0f; border-radius:10px}
        .translate-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
        .translate-text{white-space:normal}

        .thread-actions{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
        .act{appearance:none;border:1px solid #333;background:#111;color:#fff;border-radius: var(--bsky-radius, 0px);padding:6px 10px;cursor:pointer}
        .act:hover{border-color:#3b5a8f}

        .toast{display:flex;gap:10px;align-items:center;justify-content:space-between;margin:10px 0;padding:8px 10px;border:1px solid #333;background:#0f0f0f}
        .toast-msg{color:#ddd;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .toast-actions{display:flex;gap:8px;flex:0 0 auto}
        .toast-btn{background:#111;border:1px solid #555;color:#fff;padding:6px 10px;border-radius: var(--bsky-radius, 0px);cursor:pointer}

        .node{margin: 0 0 8px 0; padding-left: calc(var(--depth, 0) * 12px); border-left: 2px solid rgba(255,255,255,0.06)}
        .card{border:2px dotted rgba(255,255,255,0.9); border-radius: var(--bsky-radius, 0px); background:#0b0b0b; padding:10px 8px}
        .meta{display:flex; flex-direction:column; gap:6px; color:#bbb; font-size:0.9rem; margin-bottom:6px}
        .meta-top{display:flex; align-items:center; min-width:0}
        .who{display:flex; align-items:baseline; gap:8px; min-width:0}
        .name{font-weight:700; color:#eaeaea; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
        .handle{color:#bbb; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
        .meta-bottom{display:flex; align-items:center; gap:10px; flex-wrap:wrap}
        .when{margin-right:auto; white-space:nowrap}
        .text{white-space:pre-wrap; line-height:1.25}

        .open{color:#9cd3ff; text-decoration:none}
        .open:hover{text-decoration:underline}

        .embeds{margin-top:8px}
        .images-grid{display:grid;grid-template-columns:1fr;gap:6px;margin-top:6px}
        .img-wrap{margin:0;background:#111;overflow:hidden}
        .img-wrap img{width:100%;height:auto;display:block}
        .video-wrap video{width:100%;height:auto;display:block;background:#111}
        .video-wrap .open{display:inline-block;margin-top:6px}
        .video-wrap .hint{margin-top:6px;color:#aaa;font-size:0.9rem}

        .ancestors{margin:0 0 10px 0}
        .node.ancestor{border-left: 2px solid rgba(255,255,255,0.12)}
        .node.ancestor .card{background:#090909}

        .reply,.repost,.like,.delete,.copy,.share,.collapse,.openpanel{appearance:none; border:1px solid #333; background:#111; color:#fff; border-radius: var(--bsky-radius, 0px); padding:4px 10px; cursor:pointer}
        .reply:hover,.repost:hover,.like:hover,.copy:hover,.share:hover,.collapse:hover,.openpanel:hover{border-color:#3b5a8f}
        .delete{border-color:#7a2b2b}
        .delete:hover{border-color:#b13a3a}
        .reply:disabled,.repost:disabled,.like:disabled,.delete:disabled,.copy:disabled,.share:disabled,.collapse:disabled,.openpanel:disabled{opacity:.6; cursor:not-allowed}

        .replies-collapsed{margin-top:8px}

        .replies{margin-top:8px}
      </style>
      ${toast || ''}
      ${actions || ''}
      ${root ? (hideRoot ? repliesHtml : `${ancestorsHtml}${this.renderNode(root, 0)}`) : '<div class="muted">Select a post to view its thread.</div>'}
    `;
  }
}

if (!customElements.get('bsky-thread-tree')) {
  customElements.define('bsky-thread-tree', BskyThreadTree);
}
