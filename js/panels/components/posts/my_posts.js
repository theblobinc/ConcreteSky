// application/single_pages/bluesky_feed/js/components/my_posts.js
import { call } from '../../../api.js';
import { getAuthStatusCached, isNotConnectedError } from '../../../auth_state.js';
import { resolvePanelScroller, captureScrollAnchor, applyScrollAnchor, renderListEndcap } from '../../panel_api.js';
import { PanelListController } from '../../../controllers/panel_list_controller.js';
import { ListWindowingController } from '../../../controllers/list_windowing_controller.js';
import { BSKY_SEARCH_EVENT } from '../../../search/search_bus.js';
import { SEARCH_TARGETS } from '../../../search/constants.js';
import { compileSearchMatcher } from '../../../search/query.js';
import { renderPostTextHtml } from '../../../components/interactions/utils.js';
import { copyToClipboard } from '../../../lib/identity.js';

import '../../../components/thread_tree.js';
import '../../../comment/comment_composer.js';
import { resolveMentionDidsFromTexts, buildFacetsSafe, defaultLangs, uploadImagesToEmbed, unfurlEmbedFromText, selectEmbed, applyInteractionGates } from '../../../controllers/compose_controller.js';
import { bindListsRequest } from '../../../controllers/lists_controller.js';
import { syncRecent } from '../../../controllers/cache_sync_controller.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) =>
  ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[m])
);
const fmtTime = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return ''; } };
const atUriToWebPost = (uri) => {
  const m = String(uri || '').match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)/);
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : '';
};

const TYPES = ['post','reply','repost'];

/* ---------- link + embed helpers ---------- */

// Extract external links from facets
function linksFromFacets(rec) {
  const out = [];
  const facets = Array.isArray(rec?.facets) ? rec.facets : [];
  for (const f of facets) {
    const feats = Array.isArray(f?.features) ? f.features : [];
    for (const feat of feats) {
      const t = String(feat?.$type || '');
      if (t.includes('#link') && feat?.uri) out.push(String(feat.uri));
    }
  }
  return Array.from(new Set(out));
}

// Images (Bluesky view)
function extractImagesFromEmbed(embed) {
  if (!embed) return null;
  const t = String(embed.$type || '');
  if (t.includes('embed.images') && Array.isArray(embed.images) && embed.images.length) {
    // items look like { thumb, fullsize, alt }
    return embed.images.map(img => ({
      src: img.fullsize || img.thumb || '',
      alt: img.alt || '',
      arW: Number(img?.aspectRatio?.width || 0),
      arH: Number(img?.aspectRatio?.height || 0),
    })).filter(i => i.src);
  }
  return null;
}

// Video (Bluesky view)
function extractVideoFromEmbed(embed) {
  if (!embed) return null;
  const t = String(embed.$type || '');
  if (t.includes('embed.video')) {
    return {
      playlist: embed.playlist || '', // HLS (m3u8) etc - open in Bluesky
      thumb: embed.thumbnail || embed.thumb || '',
      alt: embed.alt || ''
    };
  }
  return null;
}

// YouTube helpers
function getYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1);
    if (u.hostname.endsWith('youtube.com')) {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      if (u.pathname.startsWith('/embed/')) return u.pathname.split('/')[2];
      if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2];
    }
  } catch {}
  return null;
}
function renderYouTubeCard(id) {
  const thumb = `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
  return `
    <div class="ext-card yt" data-yt-id="${esc(id)}" role="button" tabindex="0" aria-label="Play YouTube video">
      <div class="thumb">
        <bsky-lazy-img class="lazy-media" src="${esc(thumb)}" alt="" aspect="16/9"></bsky-lazy-img>
        <div class="play">▶</div>
      </div>
    </div>
  `;
}

// External embed (Bluesky view)
function extractExternalFromEmbed(embed) {
  if (!embed) return null;
  const type = String(embed.$type || '');
  if (type.includes('embed.external') && embed.external) return embed.external;
  if (embed.external && (embed.external.uri || embed.external.title || embed.external.thumb)) return embed.external;
  return null;
}
function renderExternalCard(external) {
  const u = String(external?.uri || '');
  const title = external?.title ? esc(external.title) : esc(u);
  const desc  = external?.description ? esc(external.description) : '';
  const thumb = external?.thumb ? `<bsky-lazy-img class="thumb-img" src="${esc(external.thumb)}" alt="" aspect="1/1"></bsky-lazy-img>` : '';
  return `
    <a class="ext-card link" href="${esc(u)}" target="_blank" rel="noopener">
      ${thumb ? `<div class="thumb">${thumb}</div>` : ''}
      <div class="meta">
        <div class="title">${title}</div>
        ${desc ? `<div class="desc">${desc}</div>` : ''}
        <div class="host">${esc(safeHost(u))}</div>
      </div>
    </a>
  `;
}
function safeHost(url) { try { return new URL(url).host; } catch { return ''; } }

// Quoted post (app.bsky.embed.record) rendering
function extractRecordEmbed(embed) {
  if (!embed) return null;
  const t = String(embed?.$type || '');
  if (t.includes('embed.recordWithMedia')) {
    return { record: embed.record || null, media: embed.media || null };
  }
  if (t.includes('embed.record')) {
    return { record: embed.record || null, media: null };
  }
  return null;
}

function recordViewToPostView(rec) {
  // Try to normalize the various view shapes into a PostView-ish object.
  // We only need author + record text + uri/cid for a compact quote.
  try {
    const r = rec?.record || rec; // some shapes nest under .record
    const uri = String(r?.uri || rec?.uri || '');
    const cid = String(r?.cid || rec?.cid || '');
    const author = r?.author || rec?.author || {};
    const value = r?.value || r?.record || rec?.value || {};
    const createdAt = value?.createdAt || value?.indexedAt || '';
    const text = String(value?.text || '');
    if (!uri || !author) return null;
    return {
      uri,
      cid,
      author,
      record: { ...value, text, createdAt },
      indexedAt: createdAt,
    };
  } catch {
    return null;
  }
}

function renderQuotePostCard(postView) {
  if (!postView) return '';
  const a = postView.author || {};
  const display = String(a?.displayName || '');
  const handle = String(a?.handle || '');
  const who = display && handle ? `${display} (@${handle})` : (display || (handle ? `@${handle}` : ''));
  const rec = postView.record || {};
  const text = esc(String(rec?.text || ''));
  const when = fmtTime(String(rec?.createdAt || postView.indexedAt || ''));
  const open = atUriToWebPost(postView.uri);
  return `
    <div class="quote-card">
      <div class="q-top">
        <div class="q-who" title="${esc(who)}">${esc(who)}</div>
        <div class="q-when">${esc(when)}</div>
        ${open ? `<a class="open" target="_blank" rel="noopener" href="${esc(open)}" title="Open quoted post">↗</a>` : ''}
      </div>
      ${text ? `<div class="q-text">${text}</div>` : ''}
    </div>
  `;
}

// Render images grid
function renderImagesGrid(images) {
  const items = images.map(i => `
    <figure class="img-wrap">
      <bsky-lazy-img class="lazy-media" src="${esc(i.src)}" alt="${esc(i.alt)}" aspect="${(i.arW && i.arH) ? `${Math.max(1,i.arW)}/${Math.max(1,i.arH)}` : '1/1'}"></bsky-lazy-img>
    </figure>
  `).join('');
  return `<div class="images-grid">${items}</div>`;
}

// Render video inline when possible.
// NOTE: Many Bluesky videos are HLS (.m3u8). Some browsers can't play HLS without additional support.
function renderVideoPoster(video, openUrl) {
  const src = String(video?.playlist || '');
  const poster = String(video?.thumb || '');
  const type = src.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4';

  if (src) {
    return `
      <div class="video-wrap">
        <video controls playsinline preload="metadata" ${poster ? `poster="${esc(poster)}"` : ''}>
          <source src="${esc(src)}" type="${esc(type)}" />
        </video>
        ${openUrl ? `<a class="open" href="${esc(openUrl)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:6px">Open on Bluesky</a>` : ''}
      </div>
    `;
  }

  // Fallback: just show the poster with an external link.
  const posterHtml = poster ? `<bsky-lazy-img class="lazy-media" src="${esc(poster)}" alt="${esc(video.alt||'Video')}" aspect="16/9"></bsky-lazy-img>` : '';
  return openUrl ? `
    <a class="ext-card video" href="${esc(openUrl)}" target="_blank" rel="noopener" title="Open to play">
      <div class="thumb">
        ${posterHtml}
        <div class="play">▶</div>
      </div>
      <div class="meta">
        <div class="title">Video</div>
        <div class="desc">Open on Bluesky to play</div>
      </div>
    </a>
  ` : '';
}

class BskyMyPosts extends HTMLElement {
  constructor(){
    super();
    this.attachShadow({mode:'open'});
    this._batches = []; // [{ id, items: [] }]
    // Layout modes:
    // - 'pack': CSS multi-column layout to minimize vertical whitespace.
    // - 'grid': CSS grid layout (more chronological row feel, more whitespace).
    this.layout = 'pack';
    this.loading = false;
    this.error = null;

    // Compose/new-thread state.
    this._composePosting = false;
    this._composeQuote = null; // { uri, cid }

    this.cursor = null;
    this.filters = { from: '', to: '', types: new Set(TYPES) };

    this._batchSeq = 0;
    this._layoutRO = null;
    this._cutoff = null;
    this._pagesMax = 15;
    this._offset = 0;

    // Incremental paging + backfill.
    this._latestIso = '';
    this._listCtl = new PanelListController(this, {
      // My Posts has its own specialized anchoring/restore flows; only centralize
      // infinite-scroll binding here.
      itemSelector: '',
      onLoadMore: () => this.load(false),
      onExhausted: () => this.queueOlderFromServer(),
      enabled: () => true,
      isLoading: () => !!this.loading,
      hasMore: () => !!this.cursor,
      threshold: 220,
      exhaustedCooldownMs: 5000,
      cooldownMs: 250,
    });
    this._unbindListsRequest = null;
    this._backfillInFlight = false;
    this._backfillDone = false;

    // Scroll/restore state.
    this._scrollTop = 0;
    this._restoreScrollNext = false;
    this._scrollAnchor = null; // { key, offsetY, scrollTop }
    this._scrollAnchorApplyTries = 0;
    // Used to ignore stale delayed restore attempts (e.g. multiple rapid load-more renders).
    this._scrollRestoreToken = 0;

    // Content-open anchor (used to restore position when Content closes).
    this._contentOpenAnchor = null;
    this._contentOpenFocusUri = '';
    this._focusRevealNext = false;

    this._lastObservedScrollerW = 0;

    this._renderedBatchOrder = [];
    this._winByBatch = new Map();
    this._autoFillPending = true;
    this._autoFillTries = 0;

    // When true, the next render() will explicitly apply this._scrollTop.
    // Used for reset/reload flows; regular renders should not touch scrollTop.
    this._forceScrollTopOnRender = false;

    this.total = 0;

    this._searchSpec = null;
    this._searchMatcher = null;
    this._onSearchChanged = null;

    this._searchApiTimer = null;
    this._searchApiInFlight = false;
    this._searchApiError = null;
    this._searchApiItems = null;

    // Inline thread expansion + caching (avoid incorrect nesting by fetching real threads).
    this._expandedThreads = new Set(); // rootUri
    this._expandedThreadMode = new Map(); // rootUri -> 'preview' | 'full'
    this._threadCache = new Map(); // rootUri -> { preview: out|null, full: out|null }
    this._postingRoots = new Set(); // rootUri (prevent double posts)

    // Root post cache: used to show "root post first" for reply entries in the feed.
    this._postCache = new Map(); // uri -> postView

    // When Content opens and the panel reflows to fewer columns, keep the selected
    // entry anchored and centered so the user doesn't lose context.
    this._focusUri = '';
    this._focusCenterNext = false;

    this._likeChangedHandler = null;
    this._repostChangedHandler = null;
    this._replyPostedHandler = null;

    this._panelsResizedHandler = null;
    this._contentClosedHandler = null;

    this._refreshRecentHandler = (e) => {
      const mins = Number(e?.detail?.minutes ?? 2);
      this.refreshRecent(mins);
    };

    // Current session DID (used for per-post actions like delete).
    this._meDid = '';

    // Pending optimistic deletion (undo window).
    // { uri, removed, restore, timerId, startedAt, state, error }
    this._pendingDelete = null;

    // Pending scheduled-post toast.
    // { id, scheduledAt, kind, state, error, timerId }
    this._pendingSchedule = null;

    // uri -> { open, loading, error, to, text }
    this._translateByUri = new Map();
  }

  _defaultLangs() {
    try {
      return defaultLangs();
    } catch {
      return [];
    }
  }

  _atUriToRkey(uri) {
    const m = String(uri || '').match(/^at:\/\/[^/]+\/app\.bsky\.feed\.post\/([^/]+)/);
    return m ? String(m[1] || '') : '';
  }

  _clearPendingDelete() {
    const pd = this._pendingDelete;
    if (pd?.timerId) {
      try { clearTimeout(pd.timerId); } catch {}
    }
    this._pendingDelete = null;
  }

  _clearPendingSchedule() {
    const ps = this._pendingSchedule;
    if (ps?.timerId) {
      try { clearTimeout(ps.timerId); } catch {}
    }
    this._pendingSchedule = null;
  }

  _formatLocalDateTime(iso) {
    try {
      const d = new Date(String(iso || ''));
      if (!Number.isFinite(d.getTime())) return '';
      return d.toLocaleString();
    } catch {
      return '';
    }
  }

  _removeItemByUri(uri) {
    const target = String(uri || '');
    if (!target) return null;

    const batches = Array.isArray(this._batches) ? this._batches : [];
    for (let bi = 0; bi < batches.length; bi++) {
      const b = batches[bi];
      const items = Array.isArray(b?.items) ? b.items : [];
      const idx = items.findIndex((it) => String(it?.post?.uri || '') === target);
      if (idx < 0) continue;

      const removed = items[idx];
      const batchId = String(b?.id || '');

      // Remove from the data model.
      const nextItems = items.slice(0, idx).concat(items.slice(idx + 1));
      const nextBatches = batches.slice();
      nextBatches[bi] = { ...b, items: nextItems };
      this._batches = nextBatches;

      try {
        if (typeof this.total === 'number' && this.total > 0) this.total = Math.max(0, this.total - 1);
      } catch {}

      // Clear any inline thread expansion state for this entry.
      try { this._expandedThreads.delete(target); } catch {}
      try { this._expandedThreadMode.delete(target); } catch {}

      const restore = () => {
        const cur = Array.isArray(this._batches) ? this._batches : [];
        let inserted = false;
        const nb = cur.map((bb) => {
          if (String(bb?.id || '') !== batchId) return bb;
          const arr = Array.isArray(bb?.items) ? bb.items.slice() : [];
          const safeIdx = Math.max(0, Math.min(idx, arr.length));
          arr.splice(safeIdx, 0, removed);
          inserted = true;
          return { ...bb, items: arr };
        });
        if (inserted) {
          this._batches = nb;
        } else {
          this._batches = [{ id: this._newBatchId('undo'), items: [removed] }, ...cur];
        }

        try {
          if (typeof this.total === 'number') this.total = this.total + 1;
        } catch {}
      };

      return { removed, batchId, idx, restore };
    }
    return null;
  }

  _removeSearchItemByUri(uri) {
    const target = String(uri || '');
    if (!target) return null;
    const arr = Array.isArray(this._searchApiItems) ? this._searchApiItems : null;
    if (!arr || !arr.length) return null;

    const idx = arr.findIndex((it) => String(it?.post?.uri || '') === target);
    if (idx < 0) return null;

    const removed = arr[idx];
    this._searchApiItems = arr.slice(0, idx).concat(arr.slice(idx + 1));

    const restore = () => {
      const cur = Array.isArray(this._searchApiItems) ? this._searchApiItems.slice() : [];
      const safeIdx = Math.max(0, Math.min(idx, cur.length));
      cur.splice(safeIdx, 0, removed);
      this._searchApiItems = cur;
    };

    return { removed, idx, restore };
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

  _renderScheduleToast() {
    const ps = this._pendingSchedule;
    if (!ps?.id) return '';

    const when = this._formatLocalDateTime(ps.scheduledAt);
    const label = (ps.state === 'canceling')
      ? 'Canceling scheduled post…'
      : (ps.state === 'canceled')
        ? 'Scheduled post canceled.'
        : (ps.state === 'failed')
          ? `Schedule failed: ${String(ps.error || 'Unknown error')}`
          : `Scheduled${when ? ` for ${when}` : ''}.`;

    const canCancel = (ps.state === 'scheduled');
    const canDismiss = (ps.state !== 'canceling');

    return `
      <div class="toast" role="status" aria-live="polite">
        <div class="toast-msg">${esc(label)}</div>
        <div class="toast-actions">
          ${canCancel ? `<button class="toast-btn" type="button" data-cancel-scheduled>Cancel</button>` : ''}
          ${canDismiss ? `<button class="toast-btn" type="button" data-dismiss-scheduled>Dismiss</button>` : ''}
        </div>
      </div>
    `;
  }

  async _cancelPendingSchedule() {
    const ps = this._pendingSchedule;
    if (!ps?.id || ps.state !== 'scheduled') return;
    ps.state = 'canceling';
    this.render();
    try {
      const res = await call('cancelScheduledPost', { id: ps.id });
      const canceled = !!(res?.canceled || res?.data?.canceled);
      ps.state = canceled ? 'canceled' : 'failed';
      if (!canceled) ps.error = 'Not canceled (already posted?)';
    } catch (e) {
      ps.state = 'failed';
      ps.error = e?.message || String(e || 'Cancel failed');
    }
    try {
      if (ps.timerId) clearTimeout(ps.timerId);
    } catch {}
    ps.timerId = setTimeout(() => {
      this._clearPendingSchedule();
      this.render();
    }, 6000);
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
      try { pd.restore?.(); } catch {}
      pd.state = 'failed';
      pd.error = e?.message || String(e || 'Delete failed');
      this.render();
    }
  }

  _startOptimisticDelete(uri) {
    const target = String(uri || '').trim();
    if (!target) return;

    if (this._pendingDelete?.state === 'pending') {
      try { this._pendingDelete.restore?.(); } catch {}
      this._clearPendingDelete();
    } else {
      this._clearPendingDelete();
    }

    const removed = this._removeItemByUri(target);
    const removedSearch = this._removeSearchItemByUri(target);
    if (!removed?.removed && !removedSearch?.removed) return;

    const pd = {
      uri: target,
      removed,
      removedSearch,
      restore: () => {
        try { removed?.restore?.(); } catch {}
        try { removedSearch?.restore?.(); } catch {}
      },
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
    try { pd.restore?.(); } catch {}
    this._clearPendingDelete();
    this.render();
  }

  async _unfurlEmbedFromText(text) {
    try {
      return await unfurlEmbedFromText(text, { thumb: true });
    } catch {
      return null;
    }
  }

  _setComposeQuote(quote) {
    const uri = String(quote?.uri || '').trim();
    const cid = String(quote?.cid || '').trim();
    this._composeQuote = uri ? { uri, cid } : null;

    try {
      const dlg = this.shadowRoot?.querySelector?.('#compose-dlg');
      const holder = dlg?.querySelector?.('#compose-quote');
      if (!holder) return;

      if (!this._composeQuote) {
        holder.textContent = '';
        holder.setAttribute('hidden', '');
        return;
      }

      const p = this._findCachedPostByUri(this._composeQuote.uri);
      const title = p ? 'Quote post' : 'Quote URI';
      const meta = this._composeQuote.uri;
      const card = p ? `<div class="quote-embed">${renderQuotePostCard(p)}</div>` : '';

      holder.removeAttribute('hidden');
      holder.innerHTML = `
        <div class="qbox">
          <div class="qhead">
            <div class="qmeta">${esc(title)}</div>
            <button class="qrm" type="button" data-compose-remove-quote>Remove</button>
          </div>
          <div class="qmeta" title="${esc(meta)}"><span class="mono">${esc(meta)}</span></div>
          ${card}
        </div>
      `;
    } catch {
      // ignore
    }
  }

  _extractCreatedRef(out) {
    try {
      const uri = String(out?.uri || out?.data?.uri || out?.record?.uri || out?.value?.uri || '');
      const cid = String(out?.cid || out?.data?.cid || out?.record?.cid || out?.value?.cid || '');
      return (uri && cid) ? { uri, cid } : (uri ? { uri, cid: '' } : null);
    } catch {
      return null;
    }
  }

  async _applyInteractionGates(createdUri, interactions, { isRootPost = false } = {}) {
    const uri = String(createdUri || '').trim();
    if (!uri) return;
    const it = interactions || null;
    if (!it) return;

    // Postgate: disable embedding/quotes.
    try {
      const quotesAllowed = it?.quotes?.allow;
      if (quotesAllowed === false) {
        await call('createPostGate', { postUri: uri, disableEmbedding: true });
      }
    } catch {}

    // Threadgate: reply controls apply to the root post only.
    if (!isRootPost) return;
    try {
      const mode = String(it?.reply?.mode || 'everyone');
      if (mode === 'everyone') return;

      let allow = null;
      if (mode === 'nobody') allow = [];
      if (mode === 'custom') allow = Array.isArray(it?.reply?.allow) ? it.reply.allow : [];
      if (allow === null) return;

      const listUri = String(it?.reply?.listUri || '').trim();
      if (allow.includes('list') && !listUri) return;

      const payload = { postUri: uri, allow };
      if (allow.includes('list')) payload.listUri = listUri;
      await call('createThreadGate', payload);
    } catch {}
  }

  async _uploadImagesToEmbed(images) {
    const uploaded = [];
    try {
      const imgs = Array.isArray(images) ? images : [];
      for (const img of imgs) {
        const mime = String(img?.mime || '');
        const dataBase64 = String(img?.dataBase64 || '');
        if (!mime || !dataBase64) continue;
        const res = await call('uploadBlob', { mime, dataBase64 });
        const blob = res?.blob || res?.data?.blob || res?.data || null;
        if (blob) uploaded.push({ alt: String(img?.alt || ''), image: blob });
      }
    } catch {}
    return uploaded.length ? { $type: 'app.bsky.embed.images', images: uploaded } : null;
  }

  async _submitNewPost(detail) {
    if (this._composePosting) return;
    const text = String(detail?.text || '').trim();
    if (!text) return;
    const scheduledAt = String(detail?.scheduledAt || '').trim();
    this._composePosting = true;
    try {
      const didByHandle = await resolveMentionDidsFromTexts([text]);
      const facets = buildFacetsSafe(text, didByHandle);
      const embed = await selectEmbed({ text, images: detail?.media?.images, quote: this._composeQuote });

      if (scheduledAt) {
        const res = await call('schedulePost', {
          scheduledAt,
          kind: 'post',
          post: { text, langs: this._defaultLangs(), ...(facets ? { facets } : {}), ...(embed ? { embed } : {}) },
          interactions: detail?.interactions || null,
        });
        const id = Number(res?.id ?? res?.data?.id ?? 0);
        const when = String(res?.scheduledAt ?? res?.data?.scheduledAt ?? scheduledAt);
        if (id > 0) {
          this._clearPendingSchedule();
          const ps = { id, scheduledAt: when, kind: 'post', state: 'scheduled', error: null, timerId: null };
          ps.timerId = setTimeout(() => {
            this._clearPendingSchedule();
            this.render();
          }, 10_000);
          this._pendingSchedule = ps;
          this.render();
        }
      } else {
        const out = await call('createPost', { text, langs: this._defaultLangs(), ...(facets ? { facets } : {}), ...(embed ? { embed } : {}) });
        const created = this._extractCreatedRef(out);
        await this._applyInteractionGates(created?.uri, detail?.interactions, { isRootPost: true });
        try {
          await syncRecent({ minutes: 10, refreshMinutes: 30 });
        } catch {}
        this.load(true);
      }
    } finally {
      this._composePosting = false;
      this._setComposeQuote(null);
      try {
        const dlg = this.shadowRoot.getElementById('compose-dlg');
        if (dlg?.open) dlg.close();
      } catch {}
    }
  }

  async _submitEditPost(detail) {
    if (this._composePosting) return;
    const uri = String(detail?.uri || '').trim();
    const text = String(detail?.text || '').trim();
    if (!uri || !text) return;

    this._composePosting = true;
    try {
      const didByHandle = await resolveMentionDidsFromTexts([text]);
      const facets = buildFacetsSafe(text, didByHandle);

      await call('editPost', {
        uri,
        text,
        langs: this._defaultLangs(),
        // Always send facets key so edits don't accidentally preserve old facets.
        facets: facets || null,
      });

      try {
        await syncRecent({ minutes: 10, refreshMinutes: 30 });
      } catch {}

      this.load(true);
    } finally {
      this._composePosting = false;
      this._setComposeQuote(null);
      try {
        const dlg = this.shadowRoot.getElementById('compose-dlg');
        if (dlg?.open) dlg.close();
      } catch {}
    }
  }

  async _submitNewThread(detail) {
    if (this._composePosting) return;
    const parts = Array.isArray(detail?.parts) ? detail.parts : [];
    const clean = parts.map((p) => ({
      text: String(p?.text || '').trim(),
      images: Array.isArray(p?.media?.images) ? p.media.images : [],
    })).filter((p) => p.text);
    if (!clean.length) return;
    const scheduledAt = String(detail?.scheduledAt || '').trim();
    this._composePosting = true;
    try {
      const interactions = detail?.interactions || null;

      let didByHandle = {};
      didByHandle = await resolveMentionDidsFromTexts(clean.map((p) => p.text));

      if (scheduledAt) {
        const partsPayload = [];
        for (let i = 0; i < clean.length; i++) {
          const p = clean[i];
          const facets = buildFacetsSafe(p.text, didByHandle);
          const embed = await selectEmbed({ text: p.text, images: p.images, quote: (i === 0) ? this._composeQuote : null });
          const payload = { text: p.text, langs: this._defaultLangs(), ...(facets ? { facets } : {}), ...(embed ? { embed } : {}) };
          partsPayload.push(payload);
        }

        const res = await call('schedulePost', {
          scheduledAt,
          kind: 'thread',
          parts: partsPayload,
          interactions,
        });

        const id = Number(res?.id ?? res?.data?.id ?? 0);
        const when = String(res?.scheduledAt ?? res?.data?.scheduledAt ?? scheduledAt);
        if (id > 0) {
          this._clearPendingSchedule();
          const ps = { id, scheduledAt: when, kind: 'thread', state: 'scheduled', error: null, timerId: null };
          ps.timerId = setTimeout(() => {
            this._clearPendingSchedule();
            this.render();
          }, 10_000);
          this._pendingSchedule = ps;
          this.render();
        }
      } else {
        let rootRef = null;
        let parentRef = null;
        for (let i = 0; i < clean.length; i++) {
          const p = clean[i];
          const facets = buildFacetsSafe(p.text, didByHandle);
          const embed = await selectEmbed({ text: p.text, images: p.images, quote: (i === 0) ? this._composeQuote : null });

          const payload = { text: p.text, langs: this._defaultLangs(), ...(facets ? { facets } : {}), ...(embed ? { embed } : {}) };
          if (i > 0 && rootRef && parentRef?.uri) {
            payload.reply = {
              root: { uri: rootRef.uri, cid: String(rootRef.cid || '') },
              parent: { uri: parentRef.uri, cid: String(parentRef.cid || '') },
            };
          }
          const out = await call('createPost', payload);
          const created = this._extractCreatedRef(out);
          if (i === 0) rootRef = created || rootRef;
          parentRef = created || parentRef;

          await this._applyInteractionGates(created?.uri, interactions, { isRootPost: i === 0 });
        }
        try {
          await syncRecent({ minutes: 10, refreshMinutes: 30 });
        } catch {}
        this.load(true);
      }
    } finally {
      this._composePosting = false;
      this._setComposeQuote(null);
      try {
        const dlg = this.shadowRoot.getElementById('compose-dlg');
        if (dlg?.open) dlg.close();
      } catch {}
    }
  }

  async _submitInlineThread(entryEl, detail) {
    const entryUri = String(entryEl?.getAttribute?.('data-uri') || '');
    const entryCid = String(entryEl?.getAttribute?.('data-cid') || '');
    if (!entryUri) return;

    const entryPost = this._findCachedPostByUri(entryUri);
    const entryRec = entryPost?.record || {};
    const replyInfo = entryRec?.reply || null;
    const cacheKey = String(replyInfo?.root?.uri || entryUri);

    if (this._postingRoots.has(entryUri)) return;
    const parts = Array.isArray(detail?.parts) ? detail.parts : [];
    const clean = parts.map((p) => ({
      text: String(p?.text || '').trim(),
      images: Array.isArray(p?.media?.images) ? p.media.images : [],
    })).filter((p) => p.text);
    if (!clean.length) return;

    const replyTo = detail?.replyTo || null;
    let parentUri = String(replyTo?.uri || '');
    let parentCid = String(replyTo?.cid || '');
    if (!parentUri || !parentCid) return;

    const outNow = this._threadCache.get(cacheKey) || { preview: null, full: null };
    const threadOut = outNow.full || outNow.preview || null;
    const thread = threadOut?.thread || null;
    const rootPost = thread?.post || null;
    const rootRef = {
      uri: String(rootPost?.uri || cacheKey || entryUri),
      cid: String(rootPost?.cid || entryCid || parentCid),
    };

    this._postingRoots.add(entryUri);
    try {
      let prevRef = { uri: parentUri, cid: parentCid };
      const interactions = detail?.interactions || null;

      let didByHandle = {};
      didByHandle = await resolveMentionDidsFromTexts(clean.map((p) => p.text));

      for (let i = 0; i < clean.length; i++) {
        const p = clean[i];
        const facets = buildFacetsSafe(p.text, didByHandle);
        const embed = await selectEmbed({ text: p.text, images: p.images, quote: null });
        const out = await call('createPost', {
          text: p.text,
          langs: this._defaultLangs(),
          reply: {
            root: { uri: rootRef.uri, cid: rootRef.cid },
            parent: { uri: prevRef.uri, cid: prevRef.cid },
          },
          ...(facets ? { facets } : {}),
          ...(embed ? { embed } : {}),
        });
        const created = this._extractCreatedRef(out);
        await this._applyInteractionGates(created?.uri, interactions, { isRootPost: false });
        if (created?.uri) prevRef = { uri: created.uri, cid: String(created.cid || prevRef.cid) };
      }

      // Optimistically bump reply count on the first parent post.
      try {
        const p0 = this._findCachedPostByUri(parentUri);
        if (p0 && typeof p0.replyCount === 'number') {
          p0.replyCount = p0.replyCount + 1;
          try {
            const postEl = this.shadowRoot.querySelector(`.post[data-uri="${this._cssEscape(parentUri)}"]`);
            const cnt = postEl?.querySelector?.('[data-open-interactions][data-kind="replies"]');
            if (cnt) cnt.textContent = `💬 ${p0.replyCount}`;
          } catch {}
        }
      } catch {}

      try {
        window.dispatchEvent(new CustomEvent('bsky-reply-posted', { detail: { uri: parentUri, rootUri: rootRef.uri } }));
      } catch {}

      try {
        await syncRecent({ minutes: 10, refreshMinutes: 30 });
      } catch {}

      try {
        const outFull = await call('getPostThread', { uri: cacheKey, depth: 10, parentHeight: 6 });
        const next = this._threadCache.get(cacheKey) || { preview: null, full: null };
        next.full = outFull || null;
        this._threadCache.set(cacheKey, next);
      } catch {}
      await this._toggleInlineThread(entryEl, { uri: entryUri, cid: entryCid }, { ensureOpen: true, mode: this._expandedThreadMode.get(entryUri) || 'full' });
    } finally {
      this._postingRoots.delete(entryUri);
    }
  }

  async _prefetchReplyRoots(items = []) {
    try {
      const roots = new Set();
      for (const it of (Array.isArray(items) ? items : [])) {
        try {
          if (this.itemType(it) !== 'reply') continue;
          const rec = it?.post?.record || {};
          const r = rec?.reply || null;
          const rootUri = String(r?.root?.uri || '');
          const entryUri = String(it?.post?.uri || '');
          if (!rootUri || rootUri === entryUri) continue;
          if (this._postCache.has(rootUri)) continue;
          roots.add(rootUri);
        } catch {
          // ignore
        }
      }

      const all = Array.from(roots);
      if (!all.length) return;

      const CHUNK = 25;
      for (let i = 0; i < all.length; i += CHUNK) {
        const chunk = all.slice(i, i + CHUNK);
        if (!chunk.length) continue;
        const res = await call('getPosts', { uris: chunk });
        const posts = Array.isArray(res?.posts) ? res.posts : [];
        for (const p of posts) {
          const uri = String(p?.uri || '');
          if (uri) this._postCache.set(uri, p);
        }
      }
    } catch {
      // ignore
    }
  }

  _nextScrollRestoreToken(){
    this._scrollRestoreToken = (Number(this._scrollRestoreToken || 0) + 1);
    return this._scrollRestoreToken;
  }

  _isRateLimitError(e) {
    return (e && (e.status === 429 || e.code === 'RATE_LIMITED' || e.name === 'RateLimitError'))
      || /\bHTTP\s*429\b/i.test(String(e?.message || ''));
  }

  _retryAfterSeconds(e) {
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

  async _backoffIfRateLimited(e, { quiet = false } = {}) {
    if (!this._isRateLimitError(e)) return false;
    const sec = this._retryAfterSeconds(e);
    const waitSec = Number.isFinite(sec) ? Math.min(3600, Math.max(1, sec)) : 10;

    if (!quiet) {
      this.error = `Rate limited. Waiting ${waitSec}s…`;
      this.render();
    }
    await new Promise((r) => setTimeout(r, waitSec * 1000));
    return true;
  }

  async _fetchSearchResultsFromApi(spec) {
    if (this._searchApiInFlight) return;
    if (window.BSKY?.cacheAvailable === false) return;
    const q = String(spec?.query || '').trim();
    if (q.length < 2) return;

    this._searchApiInFlight = true;
    this._searchApiError = null;
    this.render();

    try {
      const types = (() => {
        try {
          const t = spec?.filters?.posts?.types;
          if (Array.isArray(t) && t.length) return t;
        } catch {}
        return ['post', 'reply', 'repost'];
      })();

      const res = await call('search', {
        q,
        mode: 'cache',
        targets: ['posts'],
        limit: 200,
        hours: 24 * 365 * 5,
        postTypes: types,
      });

      const items = Array.isArray(res?.results?.posts) ? res.results.posts : [];
      this._searchApiItems = items;
    } catch (e) {
      this._searchApiError = (e && e.message) ? e.message : String(e || 'Search failed');
      this._searchApiItems = [];
    } finally {
      this._searchApiInFlight = false;
      this.render();
    }
  }

  _toInputValue(iso){
    try {
      if (!iso) return '';
      const d = new Date(String(iso));
      if (!Number.isFinite(d.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch {
      return '';
    }
  }

  _fromInputValue(v){
    try {
      const s = String(v || '').trim();
      if (!s) return '';
      const d = new Date(s);
      return Number.isFinite(d.getTime()) ? d.toISOString() : '';
    } catch {
      return '';
    }
  }

  selectedTypes(){
    try {
      return Array.from(this.filters.types || []).map(String).filter(Boolean);
    } catch {
      return [];
    }
  }

  remoteFilterForSelection(){
    // Remote filter only supports replies on/off; DB filtering handles kind.
    const wantsReplies = (this.filters.types || new Set()).has('reply');
    return wantsReplies ? 'posts_with_replies' : 'posts_no_replies';
  }

  currentSinceIso(){
    return this.filters.from ? String(this.filters.from) : null;
  }

  currentUntilIso(){
    return this.filters.to ? String(this.filters.to) : null;
  }

  _cssPx(varName, fallback) {
    try {
      const raw = getComputedStyle(this).getPropertyValue(varName);
      const n = Number.parseFloat(String(raw || ''));
      return Number.isFinite(n) ? n : fallback;
    } catch {
      return fallback;
    }
  }

  _cssInt(varName, fallback) {
    try {
      const raw = getComputedStyle(this).getPropertyValue(varName);
      const n = Number.parseInt(String(raw || '').trim(), 10);
      return Number.isFinite(n) ? n : fallback;
    } catch {
      return fallback;
    }
  }

  _findCachedPostByUri(uri) {
    const target = String(uri || '');
    if (!target) return null;
    try {
      for (const it of this._allItems()) {
        const p = it?.post || null;
        if (p && String(p.uri || '') === target) return p;
      }
    } catch {}
    return null;
  }

  _findPostTextByUri(uri) {
    const p = this._findCachedPostByUri(uri);
    return String(p?.record?.text || '');
  }

  async _translateUri(uri) {
    const u = String(uri || '').trim();
    if (!u) return;

    const cur = this._translateByUri.get(u) || null;
    if (cur && cur.open && !cur.loading) {
      this._translateByUri.set(u, { ...cur, open: false });
      this.render();
      return;
    }

    const text = this._findPostTextByUri(u);
    if (!String(text || '').trim()) return;

    const to = String((navigator?.language || 'en').split('-')[0] || 'en').toLowerCase();
    this._translateByUri.set(u, { open: true, loading: true, error: null, to, text: '' });
    this.render();
    try {
      const out = await call('translateText', { text, to, from: 'auto' });
      const translatedText = String(out?.translatedText || out?.data?.translatedText || '');
      this._translateByUri.set(u, { open: true, loading: false, error: null, to, text: translatedText });
    } catch (e) {
      this._translateByUri.set(u, { open: true, loading: false, error: String(e?.message || e || 'Translate failed'), to, text: '' });
    }
    this.render();
  }

  connectedCallback(){
    this.render();
    this.load(true);
    this.shadowRoot.addEventListener('change', (e) => this.onChange(e));
    this.shadowRoot.addEventListener('click',  (e) => this.onClick(e));
    this.shadowRoot.addEventListener('keydown', (e) => this.onKeydown(e));

    // Inline thread interaction events (from bsky-thread-tree / bsky-comment-composer).
    this.shadowRoot.addEventListener('bsky-reply-to', (e) => {
      const d = e?.detail || null;
      const uri = String(d?.uri || '');
      const cid = String(d?.cid || '');
      const author = String(d?.author || '');
      if (!uri || !cid) return;

      const entry = this._entryFromComposedPath(e);
      if (!entry) return;

      // Prefer the nearest composer in the composed path (so nested thread actions
      // target the correct inline composer), else fall back to any composer in entry.
      let composer = null;
      try {
        const path = (typeof e?.composedPath === 'function') ? e.composedPath() : [];
        for (const n of path) {
          if (n && String(n.tagName || '').toLowerCase() === 'bsky-comment-composer') {
            composer = n;
            break;
          }
        }
      } catch {}
      if (!composer) composer = entry.querySelector('bsky-comment-composer');
      composer?.setReplyTo?.({ uri, cid, author });
    });

    this.shadowRoot.addEventListener('bsky-submit-comment', (e) => {
      const detail = e?.detail || null;
      const entry = this._entryFromComposedPath(e);
      if (entry) {
        this._submitInlineComment(entry, detail);
        return;
      }

      // Top-level composer inside the Posts panel (compose dialog).
      const composer = (e?.target && String(e.target.tagName || '').toLowerCase() === 'bsky-comment-composer') ? e.target : null;
      const dlg = composer?.closest?.('#compose-dlg');
      if (dlg) this._submitNewPost(detail);
    });

    this.shadowRoot.addEventListener('bsky-submit-thread', (e) => {
      const detail = e?.detail || null;
      const entry = this._entryFromComposedPath(e);
      if (entry) {
        this._submitInlineThread(entry, detail);
        return;
      }

      // Top-level composer inside the Posts panel (compose dialog).
      const composer = (e?.target && String(e.target.tagName || '').toLowerCase() === 'bsky-comment-composer') ? e.target : null;
      const dlg = composer?.closest?.('#compose-dlg');
      if (dlg) this._submitNewThread(detail);
    });

    this.shadowRoot.addEventListener('bsky-edit-post', (e) => {
      // Edits only happen in the top-level composer (compose dialog).
      const composer = (e?.target && String(e.target.tagName || '').toLowerCase() === 'bsky-comment-composer') ? e.target : null;
      const dlg = composer?.closest?.('#compose-dlg');
      if (!dlg) return;

      // Composer cancel emits a null detail.
      if (!e?.detail) {
        this._setComposeQuote(null);
        try { dlg.close(); } catch { dlg.removeAttribute('open'); }
        return;
      }

      this._submitEditPost(e.detail);
    });

    // List picker support for reply-gating (threadgate listRule).
    if (!this._unbindListsRequest) this._unbindListsRequest = bindListsRequest(this.shadowRoot, { limit: 100 });

    // Restore packed layout + scroll position when the Content panel closes.
    if (!this._contentClosedHandler) {
      this._contentClosedHandler = () => {
        if (!this.isConnected) return;

        const a = this._contentOpenAnchor;
        const u = String(this._contentOpenFocusUri || this._focusUri || '');
        this._contentOpenAnchor = null;
        this._contentOpenFocusUri = '';

        if (a) {
          this._scrollAnchor = a;
          this._restoreScrollNext = true;
        }
        if (u) {
          this._focusUri = u;
          this._focusRevealNext = true;
        }

        // Force a repack render; ResizeObserver will fire again once widths settle.
        this._restoreScrollNext = true;
        this.render();
      };
      window.addEventListener('bsky-content-closed', this._contentClosedHandler);
    }

    // If the scroller width changes after a layout transition (e.g. Content close),
    // repack on the *settled* width so we don't get stuck in a 1-col pack.
    if (!this._layoutRO && typeof ResizeObserver !== 'undefined') {
      try {
        const shell = this.shadowRoot.querySelector('bsky-panel-shell');
        const scroller = shell?.getScroller?.() || resolvePanelScroller(this);
        if (scroller) {
          this._lastObservedScrollerW = Math.round(scroller.getBoundingClientRect().width || scroller.clientWidth || 0);
          this._layoutRO = new ResizeObserver(() => {
            if (!this.isConnected) return;
            if (String(this.layout || 'pack') !== 'pack') return;
            const w = Math.round(scroller.getBoundingClientRect().width || scroller.clientWidth || 0);
            if (!w || Math.abs(w - (this._lastObservedScrollerW || 0)) < 2) return;
            this._lastObservedScrollerW = w;

            if (this._layoutRaf) return;
            this._layoutRaf = requestAnimationFrame(() => {
              this._layoutRaf = null;
              this._restoreScrollNext = true;
              this.render();
            });
          });
          this._layoutRO.observe(scroller);
        }
      } catch {
        // ignore
      }
    }

    // Keep feed card counts/buttons in sync when interactions happen anywhere (inline thread or Content panel).
    if (!this._likeChangedHandler) {
      this._likeChangedHandler = (e) => {
        const d = e?.detail || {};
        const uri = String(d?.uri || '');
        if (!uri) return;
        const liked = (typeof d?.liked === 'boolean') ? d.liked : null;

        const p = this._findCachedPostByUri(uri);
        if (p) {
          p.viewer = p.viewer || {};
          if (typeof liked === 'boolean') {
            if (liked) p.viewer.like = p.viewer.like || { uri: 'local' };
            else {
              try { delete p.viewer.like; } catch { p.viewer.like = null; }
            }
          }
          if (typeof d?.likeCount === 'number') p.likeCount = Math.max(0, d.likeCount);
        }

        try {
          const postEl = this.shadowRoot.querySelector(`.post[data-uri="${this._cssEscape(uri)}"]`);
          const likeBtn = postEl?.querySelector?.('[data-like]');
          if (likeBtn && typeof liked === 'boolean') {
            likeBtn.setAttribute('data-liked', liked ? '1' : '0');
            likeBtn.textContent = liked ? 'Unlike' : 'Like';
          }
          const cnt = postEl?.querySelector?.('[data-open-interactions][data-kind="likes"]');
          if (cnt && p && typeof p.likeCount === 'number') cnt.textContent = `♥ ${p.likeCount}`;
        } catch {}
      };
    }

    if (!this._repostChangedHandler) {
      this._repostChangedHandler = (e) => {
        const d = e?.detail || {};
        const uri = String(d?.uri || '');
        if (!uri) return;
        const reposted = (typeof d?.reposted === 'boolean') ? d.reposted : null;

        const p = this._findCachedPostByUri(uri);
        if (p) {
          p.viewer = p.viewer || {};
          if (typeof reposted === 'boolean') {
            if (reposted) p.viewer.repost = p.viewer.repost || { uri: 'local' };
            else {
              try { delete p.viewer.repost; } catch { p.viewer.repost = null; }
            }
          }
          if (typeof d?.repostCount === 'number') p.repostCount = Math.max(0, d.repostCount);
        }

        try {
          const postEl = this.shadowRoot.querySelector(`.post[data-uri="${this._cssEscape(uri)}"]`);
          const btn = postEl?.querySelector?.('[data-repost]');
          if (btn && typeof reposted === 'boolean') {
            btn.setAttribute('data-reposted', reposted ? '1' : '0');
            btn.textContent = reposted ? 'Undo repost' : 'Repost';
          }
          const cnt = postEl?.querySelector?.('[data-open-interactions][data-kind="reposts"]');
          if (cnt && p && typeof p.repostCount === 'number') cnt.textContent = `🔁 ${p.repostCount}`;
        } catch {}
      };
    }

    window.addEventListener('bsky-like-changed', this._likeChangedHandler);
    window.addEventListener('bsky-repost-changed', this._repostChangedHandler);

    if (!this._replyPostedHandler) {
      this._replyPostedHandler = (e) => {
        const d = e?.detail || {};
        const uri = String(d?.uri || '');
        if (!uri) return;

        const p = this._findCachedPostByUri(uri);
        if (p && typeof p.replyCount === 'number') {
          p.replyCount = p.replyCount + 1;
          try {
            const postEl = this.shadowRoot.querySelector(`.post[data-uri="${this._cssEscape(uri)}"]`);
            const cnt = postEl?.querySelector?.('[data-open-interactions][data-kind="replies"]');
            if (cnt) cnt.textContent = `💬 ${p.replyCount}`;
          } catch {}
        }
      };
    }
    window.addEventListener('bsky-reply-posted', this._replyPostedHandler);

    window.addEventListener('bsky-refresh-recent', this._refreshRecentHandler);

    this._authChangedHandler = (e) => {
      const connected = !!e?.detail?.connected;
      if (!connected) {
        this._batches = [];
        this.cursor = null;
        this._offset = 0;
        this.error = 'Bluesky not connected.';
        this.render();
        return;
      }
      this.error = null;
      this.load(true);
    };
    window.addEventListener('bsky-auth-changed', this._authChangedHandler);

    if (!this._onSearchChanged) {
      this._onSearchChanged = (e) => {
        const spec = e?.detail || null;
        const targets = Array.isArray(spec?.targets) ? spec.targets : [];
        const isTargeted = targets.includes(SEARCH_TARGETS.POSTS);
        if (!isTargeted) {
          if (this._searchSpec || this._searchMatcher) {
            this._searchSpec = null;
            this._searchMatcher = null;
            this._searchApiError = null;
            this._searchApiItems = null;
            if (this._searchApiTimer) { try { clearTimeout(this._searchApiTimer); } catch {} this._searchApiTimer = null; }
            this.render();
          }
          return;
        }

        const q = String(spec?.query || '').trim();
        if (q.length < 2) {
          this._searchSpec = null;
          this._searchMatcher = null;
          this._searchApiError = null;
          this._searchApiItems = null;
          if (this._searchApiTimer) { try { clearTimeout(this._searchApiTimer); } catch {} this._searchApiTimer = null; }
          this.render();
          return;
        }

        this._searchSpec = spec;
        try {
          this._searchMatcher = compileSearchMatcher(spec.parsed);
        } catch {
          this._searchMatcher = null;
        }

        // Full-DB search for posts (cache mode only).
        if (String(spec?.mode || 'cache') === 'cache') {
          if (this._searchApiTimer) { try { clearTimeout(this._searchApiTimer); } catch {} this._searchApiTimer = null; }
          this._searchApiTimer = setTimeout(() => {
            this._searchApiTimer = null;
            this._fetchSearchResultsFromApi(spec);
          }, 250);
        } else {
          this._searchApiError = null;
          this._searchApiItems = null;
        }
        this.render();
      };
      window.addEventListener(BSKY_SEARCH_EVENT, this._onSearchChanged);
    }

    // When the app adds/removes/resizes panels, our available width changes.
    // Rebuild the packed columns so the column count stays correct.
    if (!this._panelsResizedHandler) {
      this._panelsResizedHandler = () => {
        if (!this.isConnected) return;
        if (String(this.layout || 'pack') !== 'pack') return;
        this._restoreScrollNext = true;
        this.render();
        // After the relayout, re-center on the entry that opened Content.
        requestAnimationFrame(() => {
          try { this._maybeCenterOnFocusedEntry(); } catch {}
        });
      };
      window.addEventListener('bsky-panels-resized', this._panelsResizedHandler);
    }
  }

  _maybeCenterOnFocusedEntry(){
    if (!this._focusCenterNext) return;
    const uri = String(this._focusUri || '');
    if (!uri) { this._focusCenterNext = false; return; }
    if (String(this.layout || 'pack') !== 'pack') { this._focusCenterNext = false; return; }

    // Only do the "center" behavior when we are effectively 1 column.
    const cols = (() => {
      try {
        const shell = this.shadowRoot.querySelector('bsky-panel-shell');
        const scroller = shell?.getScroller?.() || null;
        const fallbackW = this.getBoundingClientRect?.().width || 0;
        const w = scroller?.clientWidth || scroller?.getBoundingClientRect?.().width || fallbackW || 0;
        const pxVar = (el, prop, fallback) => {
          try {
            const raw = window.getComputedStyle(el).getPropertyValue(prop);
            const n = Number.parseFloat(String(raw || ''));
            return Number.isFinite(n) ? n : fallback;
          } catch { return fallback; }
        };
        const card = pxVar(this, '--bsky-card-min-w', 350);
        const gap = pxVar(this, '--bsky-card-gap', pxVar(this, '--bsky-grid-gutter', 0));
        if (!w || w < 2) return 1;
        const stride = Math.max(1, card + gap);
        return Math.max(1, Math.floor((w + gap) / stride));
      } catch { return 1; }
    })();
    if (cols !== 1) return;

    try {
      const shell = this.shadowRoot.querySelector('bsky-panel-shell');
      const scroller = shell?.getScroller?.() || resolvePanelScroller(this);
      if (!scroller) return;

      const q = `.entry[data-uri="${this._cssEscape(uri)}"]`;
      const el = this.shadowRoot.querySelector(q);
      if (!el) { this._focusCenterNext = false; return; }

      const r0 = scroller.getBoundingClientRect();
      const r1 = el.getBoundingClientRect();
      const delta = (r1.top - r0.top);
      const target = Math.max(0, (scroller.scrollTop + delta) - (scroller.clientHeight / 2) + (r1.height / 2));
      scroller.scrollTop = target;
    } finally {
      this._focusCenterNext = false;
    }
  }

  disconnectedCallback(){
    window.removeEventListener('bsky-refresh-recent', this._refreshRecentHandler);
    if (this._likeChangedHandler) window.removeEventListener('bsky-like-changed', this._likeChangedHandler);
    if (this._repostChangedHandler) window.removeEventListener('bsky-repost-changed', this._repostChangedHandler);
    if (this._replyPostedHandler) window.removeEventListener('bsky-reply-posted', this._replyPostedHandler);
    if (this._authChangedHandler) window.removeEventListener('bsky-auth-changed', this._authChangedHandler);
    if (this._onSearchChanged) {
      try { window.removeEventListener(BSKY_SEARCH_EVENT, this._onSearchChanged); } catch {}
      this._onSearchChanged = null;
    }
    if (this._searchApiTimer) { try { clearTimeout(this._searchApiTimer); } catch {} this._searchApiTimer = null; }
    if (this._layoutRO) { try { this._layoutRO.disconnect(); } catch {} this._layoutRO = null; }
    if (this._layoutRaf) { try { cancelAnimationFrame(this._layoutRaf); } catch {} this._layoutRaf = null; }
    if (this._panelsResizedHandler) {
      try { window.removeEventListener('bsky-panels-resized', this._panelsResizedHandler); } catch {}
      this._panelsResizedHandler = null;
    }
    if (this._contentClosedHandler) {
      try { window.removeEventListener('bsky-content-closed', this._contentClosedHandler); } catch {}
      this._contentClosedHandler = null;
    }
    if (this._unbindListsRequest) { try { this._unbindListsRequest(); } catch {} this._unbindListsRequest = null; }
    try { this._listCtl?.disconnect?.(); } catch {}

    try {
      for (const ctl of Array.from(this._winByBatch?.values?.() || [])) {
        try { ctl?.disconnect?.(); } catch {}
      }
    } catch {}
    try { this._winByBatch?.clear?.(); } catch {}

    this._clearPendingDelete();
  }

  _getScroller(){
    try {
      return this.shadowRoot.querySelector('bsky-panel-shell')?.getScroller?.()
        || resolvePanelScroller(this)
        || null;
    } catch {
      return null;
    }
  }

  _computePackCols(){
    const pxVar = (el, prop, fallback) => {
      try {
        const raw = window.getComputedStyle(el).getPropertyValue(prop);
        const n = Number.parseFloat(String(raw || ''));
        return Number.isFinite(n) ? n : fallback;
      } catch {
        return fallback;
      }
    };

    try {
      const shell = this.shadowRoot.querySelector('bsky-panel-shell');
      const scroller = shell?.getScroller?.() || null;
      const fallbackW = this.getBoundingClientRect?.().width || 0;
      const w = scroller?.clientWidth || scroller?.getBoundingClientRect?.().width || fallbackW || 0;
      const card = pxVar(this, '--bsky-card-min-w', 350);
      const gap = pxVar(this, '--bsky-card-gap', pxVar(this, '--bsky-grid-gutter', 0));
      if (!w || w < 2) return 1;
      const stride = Math.max(1, card + gap);
      const cols = Math.max(1, Math.floor((w + gap) / stride));
      return Math.min(8, cols);
    } catch {
      return 1;
    }
  }

  _rehydrateExpandedThreadsWithin(scopeEl){
    try {
      const scope = scopeEl || this.shadowRoot;
      const entries = Array.from(scope.querySelectorAll('.entry[data-uri]'));
      for (const entry of entries) {
        const uri = String(entry.getAttribute('data-uri') || '');
        if (!uri || !this._expandedThreads.has(uri)) continue;
        const cid = String(entry.getAttribute('data-cid') || '');
        const mode = this._expandedThreadMode.get(uri) || 'full';
        const host = entry.querySelector('[data-inline-thread]');
        const hasTree = !!host?.querySelector?.('bsky-thread-tree');
        if (host && !hasTree) {
          this._toggleInlineThread(entry, { uri, cid }, { ensureOpen: true, mode });
        }
      }
    } catch {
      // ignore
    }
  }

  _allItems(){
    try {
      return (this._batches || []).flatMap(b => Array.isArray(b?.items) ? b.items : []);
    } catch {
      return [];
    }
  }

  _newBatchId(prefix='b'){
    this._batchSeq++;
    return `${prefix}${this._batchSeq}`;
  }

  async _kickAutoFillViewport(){
    // Load additional pages until the scroller becomes scrollable (or we hit a cap).
    if (!this._autoFillPending) return;
    if (this.loading) return;

    const scroller = this.shadowRoot.querySelector('bsky-panel-shell')?.getScroller?.();
    if (!scroller) return;

    const MAX_TRIES = 6;
    if (this._autoFillTries >= MAX_TRIES) {
      this._autoFillPending = false;
      return;
    }

    // If the content doesn't fill the viewport yet, we can't scroll to trigger near-bottom.
    const notScrollable = scroller.scrollHeight <= (scroller.clientHeight + 8);
    if (!notScrollable) {
      this._autoFillPending = false;
      return;
    }

    if (!this.cursor) {
      // No more cached rows to page; stop trying.
      this._autoFillPending = false;
      return;
    }

    this._autoFillTries++;
    await this.load(false);
  }

  _cssEscape(s) {
    try {
      const v = String(s ?? '');
      if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(v);
      // Fallback: escape characters that would break an attribute selector.
      return v.replace(/[^a-zA-Z0-9_\-]/g, (m) => `\\${m}`);
    } catch {
      return '';
    }
  }

  _captureScrollAnchor(){
    try {
      const scroller = this.shadowRoot.querySelector('bsky-panel-shell')?.getScroller?.()
        || resolvePanelScroller(this);
      if (!scroller) return;

      this._scrollAnchor = captureScrollAnchor({
        scroller,
        root: this.shadowRoot,
        itemSelector: '.entry[data-k]',
        keyAttr: 'data-k',
      });
      this._scrollAnchorApplyTries = 0;
    } catch {
      // ignore
    }
  }

  _applyScrollAnchor(token){
    if (!this._restoreScrollNext) return;
    if (Number.isFinite(token) && token !== this._scrollRestoreToken) return;

    try {
      const scroller = this.shadowRoot.querySelector('bsky-panel-shell')?.getScroller?.()
        || resolvePanelScroller(this);
      if (!scroller) return;

      const a = this._scrollAnchor;
      if (!a) {
        this._restoreScrollNext = false;
        return;
      }

      // If entries are windowed, materialize the anchor key before applying.
      try {
        const k = String(a?.key || '').trim();
        if (k) {
          for (const ctl of Array.from(this._winByBatch?.values?.() || [])) {
            try { ctl?.ensureKeyVisible?.(k); } catch {}
          }
        }
      } catch {}

      this._scrollAnchorApplyTries++;

      const ok = applyScrollAnchor({ scroller, root: this.shadowRoot, anchor: a, keyAttr: 'data-k' });
      if (ok) {
        this._scrollAnchor = null;
        this._restoreScrollNext = false;
        return;
      }

      // Give layout a couple frames; then stop trying.
      if (this._scrollAnchorApplyTries >= 3) {
        this._scrollAnchor = null;
        this._restoreScrollNext = false;
      }
    } catch {
      // ignore
    }
  }

  _captureContentOpenAnchor(){
    try {
      const scroller = this.shadowRoot.querySelector('bsky-panel-shell')?.getScroller?.()
        || resolvePanelScroller(this);
      if (!scroller) return;
      this._contentOpenAnchor = captureScrollAnchor({
        scroller,
        root: this.shadowRoot,
        itemSelector: '.entry[data-k]',
        keyAttr: 'data-k',
      });
    } catch {
      // ignore
    }
  }

  _maybeRevealFocusedEntry(){
    if (!this._focusRevealNext) return;
    const uri = String(this._focusUri || '');
    if (!uri) { this._focusRevealNext = false; return; }

    try {
      const shell = this.shadowRoot.querySelector('bsky-panel-shell');
      const scroller = shell?.getScroller?.() || resolvePanelScroller(this);
      if (!scroller) return;

      const escUri = this._cssEscape(uri);
      const el = this.shadowRoot.querySelector(`.entry[data-uri="${escUri}"]`) || this.shadowRoot.querySelector(`.post[data-uri="${escUri}"]`);
      if (!el) { this._focusRevealNext = false; return; }

      const r0 = scroller.getBoundingClientRect();
      const r1 = el.getBoundingClientRect();

      const topOk = r1.top >= (r0.top + 12);
      const botOk = r1.bottom <= (r0.bottom - 12);
      if (topOk && botOk) {
        this._focusRevealNext = false;
        return;
      }

      const delta = (r1.top - r0.top);
      const target = Math.max(0, (scroller.scrollTop + delta) - 24);
      scroller.scrollTop = target;
    } finally {
      this._focusRevealNext = false;
    }
  }

  async refreshRecent(minutes=2){
    if (this.loading) return;
    const mins = Math.max(1, Number(minutes || 2));
    const floorIso = new Date(Date.now() - (mins * 60 * 1000)).toISOString();
    const sinceIso = this._latestIso || floorIso;

    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) return;

      this._meDid = String(auth?.activeDid || auth?.did || '');

      const out = await call('cacheQueryMyPosts', {
        since: sinceIso,
        until: this.currentUntilIso(),
        hours: 0,
        types: this.selectedTypes(),
        limit: 100,
        offset: 0,
        newestFirst: true,
      });

      const batch = out?.items || [];
      if (!batch.length) return;

      const have = new Set(this._allItems().map(it => it?.post?.uri).filter(Boolean));
      const fresh = [];
      for (const it of batch) {
        const uri = it?.post?.uri;
        if (!uri || have.has(uri)) continue;
        have.add(uri);
        fresh.push(it);
      }

      if (fresh.length) {
        this._restoreScrollNext = true;
        this._batches = [{ id: this._newBatchId('new'), items: fresh }, ...(this._batches || [])];
        // Track newest seen timestamp for subsequent refreshes.
        try {
          const maxIso = fresh
            .map(it => it?.post?.record?.createdAt || it?.post?.indexedAt || '')
            .filter(Boolean)
            .sort()
            .slice(-1)[0];
          if (maxIso && (!this._latestIso || maxIso > this._latestIso)) this._latestIso = maxIso;
        } catch {}
        this.render();
      }
    } catch (e) {
      // Silent; auto refresh shouldn't disrupt the UI.
      console.warn('refreshRecent (cache) failed', e);
    }
  }

  onChange(e){
    if (e.target?.id === 'layout') {
      const v = String(e.target.value || '').toLowerCase();
      this.layout = (v === 'grid') ? 'grid' : 'pack';
      this.render();
      return;
    }
    const t = e.target?.getAttribute?.('data-type');
    if (t) {
      if (e.target.checked) this.filters.types.add(t);
      else this.filters.types.delete(t);
      // Reload so limit/offset apply to the selected types.
      this.load(true);
    }
  }

  async onClick(e){
    const copyTextBtn = e.target?.closest?.('[data-copy-post-text]');
    if (copyTextBtn) {
      const uri = String(copyTextBtn.getAttribute('data-uri') || '').trim();
      const ok = await copyToClipboard(this._findPostTextByUri(uri));
      try {
        copyTextBtn.textContent = ok ? 'Copied' : 'Copy failed';
        clearTimeout(copyTextBtn.__bskyCopyT);
        copyTextBtn.__bskyCopyT = setTimeout(() => {
          try { copyTextBtn.textContent = 'Copy'; } catch {}
        }, 900);
      } catch {}
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const copyTrBtn = e.target?.closest?.('[data-copy-translation]');
    if (copyTrBtn) {
      const uri = String(copyTrBtn.getAttribute('data-uri') || '').trim();
      const tr = uri ? (this._translateByUri.get(uri) || null) : null;
      const ok = await copyToClipboard(String(tr?.text || ''));
      try {
        copyTrBtn.textContent = ok ? 'Copied' : 'Copy failed';
        clearTimeout(copyTrBtn.__bskyCopyT);
        copyTrBtn.__bskyCopyT = setTimeout(() => {
          try { copyTrBtn.textContent = 'Copy translation'; } catch {}
        }, 900);
      } catch {}
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const trBtn = e.target?.closest?.('[data-translate-post]');
    if (trBtn) {
      const uri = String(trBtn.getAttribute('data-uri') || '').trim();
      await this._translateUri(uri);
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

    if (e.target?.closest?.('[data-cancel-scheduled]')) {
      this._cancelPendingSchedule();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.target?.closest?.('[data-dismiss-scheduled]')) {
      this._clearPendingSchedule();
      this.render();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const delBtn = e.target?.closest?.('[data-delete-post]');
    if (delBtn) {
      const uri = String(delBtn.getAttribute('data-uri') || '').trim();
      if (!uri) return;
      if (this._pendingDelete?.state === 'pending' && String(this._pendingDelete.uri) === uri) return;

      const ok = confirm('Delete this post? It will be removed immediately, with a short undo window.');
      if (!ok) return;

      this._startOptimisticDelete(uri);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (e.target.id === 'compose') {
      const dlg = this.shadowRoot.querySelector('#compose-dlg');
      if (dlg) {
        this._setComposeQuote(null);
        try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); }
        try { dlg.querySelector('bsky-comment-composer')?.focus?.(); } catch {}
      }
      return;
    }
    if (e.target.id === 'compose-close') {
      const dlg = this.shadowRoot.querySelector('#compose-dlg');
      if (dlg) {
        this._setComposeQuote(null);
        try { dlg.close(); } catch { dlg.removeAttribute('open'); }
      }
      return;
    }

    if (e.target?.closest?.('[data-compose-remove-quote]')) {
      this._setComposeQuote(null);
      return;
    }

    if (e.target.id === 'reload') { this.load(true); return; }
    if (e.target.id === 'more') {
      if (this.loading) return;
      if (this.cursor) { this.load(false); return; }
      this.queueOlderFromServer().then(() => this.load(false));
      return;
    }

    if (e.target.id === 'open-range') {
      const dlg = this.shadowRoot.querySelector('#range-dlg');
      if (dlg) {
        try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); }
      }
      return;
    }
    if (e.target.id === 'clear-range') {
      if (this.loading) return;
      this.filters.from = '';
      this.filters.to = '';
      this.load(true);
      return;
    }
    if (e.target.id === 'dlg-clear') {
      const f = this.shadowRoot.querySelector('#dlg-from');
      const t = this.shadowRoot.querySelector('#dlg-to');
      if (f) f.value = '';
      if (t) t.value = '';
      this.filters.from = '';
      this.filters.to = '';
      const dlg = this.shadowRoot.querySelector('#range-dlg');
      if (dlg) {
        try { dlg.close(); } catch { dlg.removeAttribute('open'); }
      }
      this.load(true);
      return;
    }
    if (e.target.id === 'dlg-apply') {
      const dlg = this.shadowRoot.querySelector('#range-dlg');
      const f = String(this.shadowRoot.querySelector('#dlg-from')?.value || '').trim();
      const t = String(this.shadowRoot.querySelector('#dlg-to')?.value || '').trim();

      const toIsoStart = (d) => {
        if (!d) return '';
        const dt = new Date(`${d}T00:00:00`);
        return Number.isFinite(dt.getTime()) ? dt.toISOString() : '';
      };
      const toIsoEnd = (d) => {
        if (!d) return '';
        const dt = new Date(`${d}T23:59:59.999`);
        return Number.isFinite(dt.getTime()) ? dt.toISOString() : '';
      };

      this.filters.from = toIsoStart(f);
      this.filters.to = toIsoEnd(t);
      if (dlg) {
        try { dlg.close(); } catch { dlg.removeAttribute('open'); }
      }
      this.load(true);
      return;
    }

    // Click → swap YouTube thumb to iframe
    const yt = e.target.closest?.('[data-yt-id]');
    if (yt) {
      const id = yt.getAttribute('data-yt-id');
      if (id) { this.mountYouTubeIframe(yt, id); return; }
    }

    // Expand/collapse inline thread (fetch real thread; don't guess/nest unrelated posts).
    const tog = e.target.closest?.('[data-toggle-thread]');
    if (tog) {
      const entry = e.target.closest?.('.entry[data-uri]');
      if (!entry) return;
      const uri = entry.getAttribute('data-uri') || '';
      const cid = entry.getAttribute('data-cid') || '';
      if (!uri) return;
      const curMode = this._expandedThreadMode.get(uri) || null;
      // Toggle button is the "full" view.
      if (curMode === 'full') {
        await this._toggleInlineThread(entry, { uri, cid }, { ensureOpen: false, mode: 'full' });
      } else {
        await this._toggleInlineThread(entry, { uri, cid }, { ensureOpen: true, mode: 'full' });
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Preview thread (root + N replies) without leaving the Posts panel.
    const previewBtn = e.target.closest?.('[data-preview-thread]');
    if (previewBtn) {
      const entry = e.target.closest?.('.entry[data-uri]');
      if (!entry) return;
      const uri = entry.getAttribute('data-uri') || '';
      const cid = entry.getAttribute('data-cid') || '';
      if (!uri) return;
      await this._toggleInlineThread(entry, { uri, cid }, { ensureOpen: true, mode: 'preview' });
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Escalate preview -> full thread.
    const showFullBtn = e.target.closest?.('[data-show-full-thread]');
    if (showFullBtn) {
      const entry = e.target.closest?.('.entry[data-uri]');
      if (!entry) return;
      const uri = entry.getAttribute('data-uri') || '';
      const cid = entry.getAttribute('data-cid') || '';
      if (!uri) return;
      await this._toggleInlineThread(entry, { uri, cid }, { ensureOpen: true, mode: 'full', focus: true });
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Reply button (opens inline thread + focuses composer)
    const replyBtn = e.target.closest?.('[data-reply]');
    if (replyBtn) {
      const entry = e.target.closest?.('.entry[data-uri]');
      if (!entry) return;
      const rootUri = entry.getAttribute('data-uri') || '';
      const rootCid = entry.getAttribute('data-cid') || '';
      const uri = replyBtn.getAttribute('data-uri') || rootUri;
      const cid = replyBtn.getAttribute('data-cid') || rootCid;
      const author = replyBtn.getAttribute('data-author') || '';
      if (!rootUri) return;

      const postEl = replyBtn.closest?.('.post[data-uri]') || entry.querySelector?.('.post[data-uri]') || null;
      this._openInlineReplyComposer(entry, postEl, { uri, cid, author });
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Quote (opens compose dialog with quote target)
    const quoteBtn = e.target.closest?.('[data-quote]');
    if (quoteBtn) {
      const uri = String(quoteBtn.getAttribute('data-uri') || '').trim();
      const cid = String(quoteBtn.getAttribute('data-cid') || '').trim();
      if (!uri) return;

      const dlg = this.shadowRoot.querySelector('#compose-dlg');
      if (!dlg) return;
      this._setComposeQuote({ uri, cid });
      try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); }
      try { dlg.querySelector('bsky-comment-composer')?.focus?.(); } catch {}
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Edit (opens compose dialog prefilled)
    const editBtn = e.target.closest?.('[data-edit-post]');
    if (editBtn) {
      const uri = String(editBtn.getAttribute('data-uri') || '').trim();
      if (!uri) return;

      const p = this._findCachedPostByUri(uri);
      const rec = p?.record || {};
      const text = String(rec?.text || '');

      const dlg = this.shadowRoot.querySelector('#compose-dlg');
      if (!dlg) return;

      this._setComposeQuote(null);
      try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); }
      try {
        const composer = dlg.querySelector('bsky-comment-composer');
        composer?.setEditTarget?.({ uri, text });
        composer?.focus?.();
      } catch {}

      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Repost/unrepost
    const repostBtn = e.target.closest?.('[data-repost]');
    if (repostBtn) {
      const uri = repostBtn.getAttribute('data-uri') || '';
      const cid = repostBtn.getAttribute('data-cid') || '';
      if (!uri || !cid) return;
      const reposted = repostBtn.getAttribute('data-reposted') === '1';
      repostBtn.setAttribute('disabled', '');
      try {
        await call(reposted ? 'unrepost' : 'repost', { uri, cid });

        const p = this._findCachedPostByUri(uri);
        if (p) {
          p.viewer = p.viewer || {};
          if (reposted) {
            try { delete p.viewer.repost; } catch { p.viewer.repost = null; }
            if (typeof p.repostCount === 'number') p.repostCount = Math.max(0, p.repostCount - 1);
          } else {
            p.viewer.repost = p.viewer.repost || { uri: 'local' };
            if (typeof p.repostCount === 'number') p.repostCount = p.repostCount + 1;
          }
        }

        repostBtn.setAttribute('data-reposted', reposted ? '0' : '1');
        repostBtn.textContent = reposted ? 'Repost' : 'Undo repost';

        // If an inline thread is open, sync the thread tree root node too.
        try {
          const entry = repostBtn.closest?.('.entry');
          const tree = entry?.querySelector?.('bsky-thread-tree');
          tree?.applyEngagementPatch?.({ uri, reposted: !reposted, repostCount: (p && typeof p.repostCount === 'number') ? p.repostCount : undefined });
        } catch {}

        // Update visible count (if present).
        try {
          const postEl = repostBtn.closest?.('.post');
          const cnt = postEl?.querySelector?.('[data-open-interactions][data-kind="reposts"]');
          if (cnt && p && typeof p.repostCount === 'number') cnt.textContent = `🔁 ${p.repostCount}`;
        } catch {}

        // Broadcast for other panels (Content / modals / other feeds).
        try {
          window.dispatchEvent(new CustomEvent('bsky-repost-changed', {
            detail: {
              uri,
              cid,
              reposted: !reposted,
              repostCount: (p && typeof p.repostCount === 'number') ? p.repostCount : null,
            },
          }));
        } catch {}

        try {
          await syncRecent({ minutes: 5, refreshMinutes: 30, allowDirectFallback: false });
        } catch {}
      } catch (err) {
        console.warn('repost toggle failed', err);
      } finally {
        try { repostBtn.removeAttribute('disabled'); } catch {}
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Like/unlike
    const likeBtn = e.target.closest?.('[data-like]');
    if (likeBtn) {
      const uri = likeBtn.getAttribute('data-uri') || '';
      const cid = likeBtn.getAttribute('data-cid') || '';
      if (!uri || !cid) return;
      const liked = likeBtn.getAttribute('data-liked') === '1';
      likeBtn.setAttribute('disabled', '');
      try {
        await call(liked ? 'unlike' : 'like', { uri, cid });

        const p = this._findCachedPostByUri(uri);
        if (p) {
          p.viewer = p.viewer || {};
          if (liked) {
            try { delete p.viewer.like; } catch { p.viewer.like = null; }
            if (typeof p.likeCount === 'number') p.likeCount = Math.max(0, p.likeCount - 1);
          } else {
            p.viewer.like = p.viewer.like || { uri: 'local' };
            if (typeof p.likeCount === 'number') p.likeCount = p.likeCount + 1;
          }
        }

        likeBtn.setAttribute('data-liked', liked ? '0' : '1');
        likeBtn.textContent = liked ? 'Like' : 'Unlike';

        // If an inline thread is open, sync the thread tree root node too.
        try {
          const entry = likeBtn.closest?.('.entry');
          const tree = entry?.querySelector?.('bsky-thread-tree');
          tree?.applyEngagementPatch?.({ uri, liked: !liked, likeCount: (p && typeof p.likeCount === 'number') ? p.likeCount : undefined });
        } catch {}

        try {
          const postEl = likeBtn.closest?.('.post');
          const cnt = postEl?.querySelector?.('[data-open-interactions][data-kind="likes"]');
          if (cnt && p && typeof p.likeCount === 'number') cnt.textContent = `♥ ${p.likeCount}`;
        } catch {}

        // Broadcast for other panels (Content / modals / other feeds).
        try {
          window.dispatchEvent(new CustomEvent('bsky-like-changed', {
            detail: {
              uri,
              cid,
              liked: !liked,
              likeCount: (p && typeof p.likeCount === 'number') ? p.likeCount : null,
            },
          }));
        } catch {}

        try {
          await syncRecent({ minutes: 5, refreshMinutes: 30, allowDirectFallback: false });
        } catch {}
      } catch (err) {
        console.warn('like toggle failed', err);
      } finally {
        try { likeBtn.removeAttribute('disabled'); } catch {}
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // NEW: open interactions lightbox on counts click
    const cnt = e.target.closest?.('[data-open-interactions]');
    if (cnt) {
      const kind = cnt.getAttribute('data-kind'); // likes|reposts|replies
      const uri  = cnt.getAttribute('data-uri');
      const cid  = cnt.getAttribute('data-cid') || '';

      // Integrate counts into the Content panel.
      // Ctrl/Cmd-click keeps the old behavior (modal/lightbox) for power users.
      if (e?.metaKey || e?.ctrlKey) {
        this.openInteractions(kind, uri, cid);
        return;
      }
      if (uri) {
        this._captureContentOpenAnchor();
        this._contentOpenFocusUri = String(uri);
        this._focusUri = String(uri);
        this._focusCenterNext = true;
        const view = (kind === 'replies') ? 'replies' : (kind === 'reposts') ? 'reposts' : (kind === 'likes') ? 'likes' : '';
        this.dispatchEvent(new CustomEvent('bsky-open-content', {
          detail: { uri, cid, spawnAfter: 'posts', view },
          bubbles: true,
          composed: true,
        }));
      }
      return;
    }

    // If the user clicks a nested post inside a grouped thread entry, open that post.
    const nestedPost = e.target.closest?.('.post[data-uri]');
    if (nestedPost) {
      if (e.target.closest?.('a,button,input,select,textarea,[data-yt-id]')) return;
      const uri = nestedPost.getAttribute('data-uri') || '';
      const cid = nestedPost.getAttribute('data-cid') || '';
      if (!uri) return;
      this._captureContentOpenAnchor();
      this._contentOpenFocusUri = String(uri);
      this._focusUri = String(uri);
      this._focusCenterNext = true;
      this.dispatchEvent(new CustomEvent('bsky-open-content', {
        detail: { uri, cid, spawnAfter: 'posts', view: 'replies' },
        bubbles: true,
        composed: true,
      }));
      return;
    }

    // Open content panel when clicking a post card (but not on links/buttons).
    const entry = e.target.closest?.('.entry');
    if (entry) {
      if (e.target.closest?.('a,button,input,select,textarea,[data-yt-id]')) return;
      const uri = entry.getAttribute('data-uri') || '';
      const cid = entry.getAttribute('data-cid') || '';
      if (!uri) return;
      this._captureContentOpenAnchor();
      this._contentOpenFocusUri = String(uri);
      this._focusUri = String(uri);
      this._focusCenterNext = true;
      this.dispatchEvent(new CustomEvent('bsky-open-content', {
        detail: { uri, cid, spawnAfter: 'posts', view: 'replies' },
        bubbles: true,
        composed: true,
      }));
    }
  }

  _openInlineReplyComposer(entryEl, postEl, replyTo){
    if (!entryEl) return;

    // If a thread preview/full view is open for this entry, close it to keep the card clean.
    try {
      const entryUri = String(entryEl.getAttribute('data-uri') || '');
      const host = entryEl.querySelector('[data-inline-thread]');
      const open = !!(host && !host.hidden && (host.textContent || host.childNodes.length));
      if (entryUri && open) {
        this._expandedThreads.delete(entryUri);
        this._expandedThreadMode.delete(entryUri);
        try { host.hidden = true; } catch {}
        try { host.textContent = ''; } catch {}
        try {
          const toggleBtn = entryEl.querySelector('[data-toggle-thread]');
          if (toggleBtn) toggleBtn.textContent = '+';
        } catch {}
      }
    } catch {}

    // Remove any other inline reply boxes in this entry.
    try {
      for (const h of Array.from(entryEl.querySelectorAll('[data-inline-reply]'))) {
        if (postEl && (h === postEl.nextElementSibling)) continue;
        try { h.remove(); } catch { try { entryEl.removeChild(h); } catch {} }
      }
    } catch {}

    if (!postEl) return;

    let host = (postEl.nextElementSibling && postEl.nextElementSibling.matches?.('[data-inline-reply]'))
      ? postEl.nextElementSibling
      : null;

    // Toggle behavior: clicking Reply again on the same post closes the inline composer.
    if (host) {
      const curUri = String(host.getAttribute('data-reply-uri') || '');
      const curCid = String(host.getAttribute('data-reply-cid') || '');
      const nextUri = String(replyTo?.uri || '');
      const nextCid = String(replyTo?.cid || '');
      if (curUri && curCid && nextUri && nextCid && curUri === nextUri && curCid === nextCid) {
        try { host.remove(); } catch { try { entryEl.removeChild(host); } catch {} }
        return;
      }
    }

    if (!host) {
      host = document.createElement('div');
      host.className = 'inline-reply';
      host.setAttribute('data-inline-reply', '');
      host.innerHTML = '<bsky-comment-composer maxchars="300" thread="1"></bsky-comment-composer>';
      try { postEl.insertAdjacentElement('afterend', host); } catch { entryEl.appendChild(host); }
    }

    try {
      host.setAttribute('data-reply-uri', String(replyTo?.uri || ''));
      host.setAttribute('data-reply-cid', String(replyTo?.cid || ''));
    } catch {}

    const composer = host.querySelector('bsky-comment-composer');
    try {
      if (replyTo && composer?.setReplyTo) composer.setReplyTo(replyTo);
    } catch {}

    try { composer?.focus?.(); } catch {}
    try { composer?.shadowRoot?.querySelector?.('textarea')?.focus?.(); } catch {}
  }

  _entryFromComposedPath(e) {
    try {
      const path = (typeof e?.composedPath === 'function') ? e.composedPath() : [];
      for (const n of path) {
        if (n && n.classList && n.classList.contains('entry')) return n;
      }
    } catch {}
    return null;
  }

  async _toggleInlineThread(entryEl, root, opts = null) {
    const entryUri = String(root?.uri || '');
    const entryCid = String(root?.cid || '');
    if (!entryUri) return;

    // If this entry is a reply, prefer showing the actual thread root first
    // (root post, then our reply nested beneath it).
    const entryPost = this._findCachedPostByUri(entryUri);
    const entryRec = entryPost?.record || {};
    const replyInfo = entryRec?.reply || null;
    const threadUri = String(replyInfo?.root?.uri || entryUri);
    const isReplyEntry = !!(replyInfo && threadUri && threadUri !== entryUri);

    const options = opts || {};
    const ensureOpen = !!options.ensureOpen;
    // For reply entries, default to full thread so the root + our reply is always visible.
    const defaultMode = isReplyEntry ? 'full' : 'full';
    const mode = (options.mode === 'preview' || options.mode === 'full') ? options.mode : (this._expandedThreadMode.get(entryUri) || defaultMode);
    const shouldOpen = ensureOpen || !this._expandedThreads.has(entryUri);
    const shouldClose = !ensureOpen && this._expandedThreads.has(entryUri) && (this._expandedThreadMode.get(entryUri) === mode);

    const toggleBtn = entryEl.querySelector('[data-toggle-thread]');

    let host = entryEl.querySelector('[data-inline-thread]');
    if (!host) {
      host = document.createElement('div');
      host.className = 'inline-thread';
      host.setAttribute('data-inline-thread', '');
      host.hidden = true;
      entryEl.appendChild(host);
    }

    if (shouldClose) {
      this._expandedThreads.delete(entryUri);
      this._expandedThreadMode.delete(entryUri);
      host.hidden = true;
      host.textContent = '';
      if (toggleBtn) toggleBtn.textContent = '+';
      return;
    }

    if (!shouldOpen) return;
    this._expandedThreads.add(entryUri);
    this._expandedThreadMode.set(entryUri, mode);
    host.hidden = false;
    if (toggleBtn) toggleBtn.textContent = '−';

    const cacheKey = threadUri || entryUri;
    const cache = this._threadCache.get(cacheKey) || { preview: null, full: null };
    // Canonicalize: always try to fetch/store a full thread so preview can show the true newest replies.
    const cachedOut = cache.full || cache.preview || null;
    if (!cachedOut) {
      host.textContent = (mode === 'preview') ? 'Loading thread preview…' : 'Loading thread…';
      try {
        const out = await call('getPostThread', {
          uri: cacheKey,
          depth: 10,
          parentHeight: 6,
        });
        const next = this._threadCache.get(cacheKey) || { preview: null, full: null };
        next.full = out || null;
        next.preview = out || null;
        this._threadCache.set(cacheKey, next);
      } catch (err) {
        host.textContent = `Error loading thread: ${String(err?.message || err || '')}`;
        return;
      }
    }

    const outNow = this._threadCache.get(cacheKey) || { preview: null, full: null };
    const threadOut = outNow.full || outNow.preview || null;
    const fullThread = threadOut?.thread || null;

    const collectReplyNodes = (node, out) => {
      const replies = Array.isArray(node?.replies) ? node.replies : [];
      for (const r of replies) {
        if (r && r.post) out.push(r);
        collectReplyNodes(r, out);
      }
    };

    const countReplies = (node) => {
      try {
        const tmp = [];
        collectReplyNodes(node, tmp);
        return tmp.length;
      } catch {
        return 0;
      }
    };

    const pickIso = (post) => {
      try {
        const rec = post?.record || {};
        return String(rec?.createdAt || post?.indexedAt || '');
      } catch {
        return '';
      }
    };

    const makeRecentRepliesPreview = (thread, maxReplies = 5, mustIncludeUris = []) => {
      if (!thread || !thread.post) return thread;

      // We want a "newest N replies" preview but still nested beneath their actual parent
      // (i.e. don't flatten all picked replies as direct children of the root).
      const withPath = [];
      const pathByUri = new Map();
      const collectWithPath = (node, pathUris) => {
        const replies = Array.isArray(node?.replies) ? node.replies : [];
        for (const r of replies) {
          const uri = String(r?.post?.uri || '');
          const nextPath = uri ? [...pathUris, uri] : [...pathUris];
          if (r && r.post && uri) {
            try { pathByUri.set(uri, nextPath); } catch {}
            withPath.push({
              node: r,
              uri,
              iso: pickIso(r.post),
              pathUris: nextPath,
            });
          }
          collectWithPath(r, nextPath);
        }
      };
      collectWithPath(thread, []);

      const sorted = withPath
        .filter((x) => x.uri)
        .sort((a, b) => {
          if (a.iso !== b.iso) return (a.iso < b.iso) ? 1 : -1; // desc
          return (a.uri < b.uri) ? -1 : (a.uri > b.uri ? 1 : 0);
        });

      const n = Math.max(0, Number(maxReplies || 0) || 0);
      const picked = sorted.slice(0, n);
      const includeUris = new Set();
      for (const p of picked) {
        for (const u of (Array.isArray(p.pathUris) ? p.pathUris : [])) includeUris.add(String(u || ''));
      }

      // Force-include specific replies (e.g. the entry itself when the entry is a reply)
      // so the user always sees "root post → our reply" even if the reply isn't among newest N.
      try {
        for (const u0 of (Array.isArray(mustIncludeUris) ? mustIncludeUris : [])) {
          const u = String(u0 || '');
          if (!u) continue;
          const path = pathByUri.get(u) || null;
          if (Array.isArray(path)) {
            for (const x of path) includeUris.add(String(x || ''));
          } else {
            includeUris.add(u);
          }
        }
      } catch {}

      const prune = (node, forceInclude = false) => {
        if (!node || !node.post) return null;
        const uri = String(node?.post?.uri || '');
        const replies = Array.isArray(node?.replies) ? node.replies : [];
        const keptReplies = [];
        for (const r of replies) {
          const kept = prune(r, false);
          if (kept) keptReplies.push(kept);
        }

        const keepMe = forceInclude || (uri && includeUris.has(uri)) || keptReplies.length > 0;
        if (!keepMe) return null;

        return {
          post: node.post,
          replies: keptReplies,
        };
      };

      const pruned = prune(thread, true) || { post: thread.post, replies: [] };
      return {
        ...pruned,
        // preserve ancestors if the selected post is itself a reply
        ...(thread.parent ? { parent: thread.parent } : {}),
      };
    };

      const totalReplies = fullThread ? countReplies(fullThread) : 0;
      const PREVIEW_N = Math.max(0, this._cssInt('--bsky-thread-preview-count', 5));
    const thread = (mode === 'preview') ? makeRecentRepliesPreview(fullThread, PREVIEW_N, isReplyEntry ? [entryUri] : []) : fullThread;
    const showing = (mode === 'preview') ? Math.min(PREVIEW_N, totalReplies) : totalReplies;

    const showFull = (mode === 'preview');
    host.innerHTML = `
      <div class="inline-actions">
        <span class="muted">${showFull ? `Thread preview · newest ${showing}${totalReplies ? ` of ${totalReplies}` : ''} replies` : 'Thread'}</span>
        ${showFull ? `<button class="act" type="button" data-show-full-thread>Show full thread</button>` : ''}
      </div>
      <bsky-thread-tree></bsky-thread-tree>
      <bsky-comment-composer></bsky-comment-composer>
    `;

    const tree = host.querySelector('bsky-thread-tree');
    tree?.setThread?.(thread, { hideRoot: true });

    const composer = host.querySelector('bsky-comment-composer');
    if (options.replyTo) composer?.setReplyTo?.(options.replyTo);
    if (options.focus) {
      try { composer?.focus?.(); } catch {}
      try { composer?.shadowRoot?.querySelector?.('textarea')?.focus?.(); } catch {}
    }

    // Default reply target: root post.
    if (!options.replyTo && composer?.setReplyTo) {
      const rootPost = thread?.post || null;
      const uri = String(rootPost?.uri || threadUri || entryUri);
      const cid = String(rootPost?.cid || entryCid);
      const author = String(rootPost?.author?.handle || '');
      if (uri && cid) composer.setReplyTo({ uri, cid, author });
    }
  }

  async _submitInlineComment(entryEl, detail) {
    const entryUri = String(entryEl?.getAttribute?.('data-uri') || '');
    const entryCid = String(entryEl?.getAttribute?.('data-cid') || '');
    if (!entryUri) return;

    const entryPost = this._findCachedPostByUri(entryUri);
    const entryRec = entryPost?.record || {};
    const replyInfo = entryRec?.reply || null;
    const cacheKey = String(replyInfo?.root?.uri || entryUri);

    if (this._postingRoots.has(entryUri)) return;
    const text = String(detail?.text || '').trim();
    if (!text) return;

    const replyTo = detail?.replyTo || null;
    const parentUri = String(replyTo?.uri || '');
    const parentCid = String(replyTo?.cid || '');
    if (!parentUri || !parentCid) return;

    const outNow = this._threadCache.get(cacheKey) || { preview: null, full: null };
    const threadOut = outNow.full || outNow.preview || null;
    const thread = threadOut?.thread || null;
    const rootPost = thread?.post || null;
    const rootRef = {
      uri: String(rootPost?.uri || cacheKey || entryUri),
      cid: String(rootPost?.cid || entryCid || parentCid),
    };

    const images = Array.isArray(detail?.media?.images) ? detail.media.images : [];

    this._postingRoots.add(entryUri);
    try {
      const didByHandle = await resolveMentionDidsFromTexts([text]);
      const facets = buildFacetsSafe(text, didByHandle);
      const embed = await selectEmbed({ text, images, quote: null });

      const out = await call('createPost', {
        text,
        langs: this._defaultLangs(),
        reply: {
          root: { uri: rootRef.uri, cid: rootRef.cid },
          parent: { uri: parentUri, cid: parentCid },
        },
        ...(facets ? { facets } : {}),
        ...(embed ? { embed } : {}),
      });

      const created = this._extractCreatedRef(out);
      await this._applyInteractionGates(created?.uri, detail?.interactions, { isRootPost: false });

      // Optimistically bump reply count on the parent post.
      try {
        const p = this._findCachedPostByUri(parentUri);
        if (p && typeof p.replyCount === 'number') {
          p.replyCount = p.replyCount + 1;
          try {
            const postEl = this.shadowRoot.querySelector(`.post[data-uri="${this._cssEscape(parentUri)}"]`);
            const cnt = postEl?.querySelector?.('[data-open-interactions][data-kind="replies"]');
            if (cnt) cnt.textContent = `💬 ${p.replyCount}`;
          } catch {}
        }
      } catch {}

      // Let other panels (e.g. Content) sync their own copies.
      try {
        window.dispatchEvent(new CustomEvent('bsky-reply-posted', { detail: { uri: parentUri, rootUri: rootRef.uri } }));
      } catch {}

      // Ensure cached feeds can see the new reply.
      try {
        await syncRecent({ minutes: 10, refreshMinutes: 30 });
      } catch {}

      // Refresh thread cache and rerender expanded thread.
      try {
        const outFull = await call('getPostThread', { uri: cacheKey, depth: 10, parentHeight: 6 });
        const next = this._threadCache.get(cacheKey) || { preview: null, full: null };
        next.full = outFull || null;
        this._threadCache.set(cacheKey, next);
      } catch {}
      await this._toggleInlineThread(entryEl, { uri: entryUri, cid: entryCid }, { ensureOpen: true, mode: this._expandedThreadMode.get(entryUri) || 'full' });
    } finally {
      this._postingRoots.delete(entryUri);
    }
  }

  onKeydown(e){
    // Enter/Space to activate YouTube preview
    const yt = e.target.closest?.('[data-yt-id]');
    if (!yt) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const id = yt.getAttribute('data-yt-id');
      if (id) this.mountYouTubeIframe(yt, id);
    }
  }

  mountYouTubeIframe(wrapper, id){
    const origin = (() => {
      try { return encodeURIComponent(String(window.location.origin || '')); } catch { return ''; }
    })();
    const src = `https://www.youtube.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&enablejsapi=1${origin ? `&origin=${origin}` : ''}`;
    wrapper.outerHTML = `
      <div class="ext-card yt iframe">
        <div class="yt-16x9">
          <iframe
            src="${esc(src)}"
            title="YouTube video player"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowfullscreen
            loading="lazy"
          ></iframe>
        </div>
      </div>
    `;
  }

	openInteractions(kind, uri, cid){
	  if (!uri) return;

	  // NEW TAG
	  const modal = document.createElement('bsky-interactions-modal');
	  modal.setAttribute('uri', uri);
	  if (cid)   modal.setAttribute('cid', cid);
	  if (kind)  modal.setAttribute('initial', kind); // 'likes' | 'reposts' | 'replies'

	  document.body.appendChild(modal);

	  // Wait for custom element upgrade if needed, then call open()
	  if (typeof modal.open === 'function') {
		modal.open();
	  } else {
		customElements.whenDefined('bsky-interactions-modal')
		  .then(() => modal.open())
		  .catch(() => {}); // no-op
	  }
	}

  async load(reset){
    if (this.loading) return;

    if (reset) {
      this._batches = [];
      this.cursor = null;
      this._offset = 0;
      this.total = 0;
      this._cutoff = new Date();
      this._latestIso = '';
      this._backfillDone = false;
      this._restoreScrollNext = false;
      this._scrollTop = 0;
      this._forceScrollTopOnRender = true;
      this._autoFillPending = true;
      this._autoFillTries = 0;
    } else {
      // For paging (append older entries), new content is added below the viewport.
      // With per-batch rendering, scrollTop should remain stable without forcing
      // anchor restoration on every append.
      this._restoreScrollNext = false;
      this._forceScrollTopOnRender = false;
    }

    this.loading = true;
    this.error = null;

    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) {
        this._batches = [];
        this.cursor = null;
        this._offset = 0;
        this.error = 'Not connected. Use the Connect button.';
        return;
      }

      this._meDid = String(auth?.activeDid || auth?.did || '');

      const limit = 100;
      let out = await call('cacheQueryMyPosts', {
        since: this.currentSinceIso(),
        until: this.currentUntilIso(),
        hours: 0,
        types: this.selectedTypes(),
        limit,
        offset: this._offset,
        newestFirst: true,
      });

      let batch = out?.items || [];
      let hasMore = !!out?.hasMore;
      if (typeof out?.total === 'number') this.total = Number(out.total || 0);

      // If cache is empty on first load, do a one-time seed sync.
      if (reset && batch.length === 0) {
        const filter = this.remoteFilterForSelection();
        for (;;) {
          try {
            await call('cacheSyncMyPosts', {
              // Seed sync should always use a small recent window.
              hours: 24,
              pagesMax: this._pagesMax,
              filter,
            });
            break;
          } catch (e) {
            const waited = await this._backoffIfRateLimited(e, { quiet: false });
            if (waited) continue;
            throw e;
          }
        }
        out = await call('cacheQueryMyPosts', {
          since: this.currentSinceIso(),
          until: this.currentUntilIso(),
          hours: 0,
          types: this.selectedTypes(),
          limit,
          offset: this._offset,
          newestFirst: true,
        });
        batch = out?.items || [];
        hasMore = !!out?.hasMore;
        if (typeof out?.total === 'number') this.total = Number(out.total || 0);
      }

      const have = new Set(this._allItems().map(it => it?.post?.uri).filter(Boolean));
      const unique = [];
      for (const it of batch) {
        const uri = it?.post?.uri;
        if (uri && have.has(uri)) continue;
        if (uri) have.add(uri);
        unique.push(it);
      }

      // Prefetch root posts so reply entries can render "root first" without extra clicks.
      // Best-effort; failure should not block list rendering.
      try { await this._prefetchReplyRoots(unique); } catch {}

      if (unique.length) {
        const id = this._newBatchId(reset ? 'b' : 'p');
        this._batches = [...(this._batches || []), { id, items: unique }];
      }

      // Track newest seen timestamp for refreshRecent.
      try {
        const maxIso = batch
          .map(it => it?.post?.record?.createdAt || it?.post?.indexedAt || '')
          .filter(Boolean)
          .sort()
          .slice(-1)[0];
        if (maxIso && (!this._latestIso || maxIso > this._latestIso)) this._latestIso = maxIso;
      } catch {}

      this._offset += batch.length;
      this.cursor = hasMore ? 'more' : null;
    } catch (e) {
      this.error = isNotConnectedError(e) ? 'Not connected. Use the Connect button.' : e.message;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  async queueOlderFromServer(){
    if (this._backfillInFlight) return;
    if (this._backfillDone) return;

    this._backfillInFlight = true;
    try {
      let res;
      for (;;) {
        try {
          res = await call('cacheBackfillMyPosts', {
            // One author-feed page = 100 posts.
            pagesMax: 1,
            filter: this.remoteFilterForSelection(),
          });
          break;
        } catch (e) {
          const waited = await this._backoffIfRateLimited(e, { quiet: true });
          if (waited) continue;
          throw e;
        }
      }

      const done = !!res?.done;
      const inserted = Number(res?.inserted || 0);
      const updated = Number(res?.updated || 0);

      if (done || (inserted + updated) === 0) {
        this._backfillDone = true;
      }
    } catch {
      // Silent; the next query will surface if nothing changes.
    } finally {
      this._backfillInFlight = false;
    }
  }

  itemType(it){
    const p = it.post || {};
    const rec = p.record || {};
    if (it.reason && typeof it.reason === 'object' && String(it.reason.$type || '').includes('#reasonRepost')) return 'repost';
    if (rec.reply) return 'reply';
    return 'post';
  }

  filteredItems(){
    const allowed = this.filters.types;
    // IMPORTANT: preserve the existing list order.
    // - Initial loads come from the DB already sorted newest→oldest.
    // - Infinite scroll appends older entries.
    // - Refresh prepends newer entries.
    // Sorting here would reshuffle already-loaded entries.
    return this._allItems().filter(it => allowed.has(this.itemType(it)));
  }

  filteredBatches(){
    const allowed = this.filters.types;
    return (this._batches || []).map((b) => ({
      id: String(b?.id || ''),
      items: (Array.isArray(b?.items) ? b.items : []).filter(it => allowed.has(this.itemType(it)))
    }));
  }

  // Build media/link preview HTML for a post
  renderEmbedsFor(it){
    const p = it.post || {};
    const rec = p.record || {};
    const open = atUriToWebPost(p.uri);

    // 0) quote posts (record / recordWithMedia)
    const recEmbed = extractRecordEmbed(p.embed);
    if (recEmbed?.record) {
      const quoted = recordViewToPostView(recEmbed.record);
      const quoteHtml = quoted ? renderQuotePostCard(quoted) : '';

      // recordWithMedia: render media below the quote
      const media = recEmbed.media || null;
      const imgsM = extractImagesFromEmbed(media);
      const vidM = extractVideoFromEmbed(media);
      const extM = extractExternalFromEmbed(media);
      const mediaHtml = (imgsM && imgsM.length) ? renderImagesGrid(imgsM)
        : (vidM && (vidM.thumb || vidM.playlist)) ? renderVideoPoster(vidM, open)
        : extM ? (() => { const ytId = getYouTubeId(extM.uri || ''); return ytId ? renderYouTubeCard(ytId) : renderExternalCard(extM); })()
        : '';

      return `
        <div class="quote-embed">${quoteHtml}${mediaHtml ? `<div class="q-media">${mediaHtml}</div>` : ''}</div>
      `;
    }

    // 1) images
    const imgs = extractImagesFromEmbed(p.embed);
    if (imgs && imgs.length) return renderImagesGrid(imgs);

    // 2) video view → poster card
    const vid = extractVideoFromEmbed(p.embed);
    if (vid && (vid.thumb || vid.playlist)) return renderVideoPoster(vid, open);

    // 3) external (YouTube etc.)
    const extFromEmbed = extractExternalFromEmbed(p.embed);
    if (extFromEmbed) {
      const ytId = getYouTubeId(extFromEmbed.uri || '');
      if (ytId) return renderYouTubeCard(ytId);
      return renderExternalCard(extFromEmbed);
    }

    // 4) facets links
    const links = linksFromFacets(rec);
    if (links.length) {
      for (const u of links) {
        const id = getYouTubeId(u);
        if (id) return renderYouTubeCard(id);
      }
      return renderExternalCard({ uri: links[0] });
    }

    return '';
  }

  render(){
    // Preserve scroll position.
    // - For restore flows (prepend / append / relayout), capture a visible-entry anchor before mutating the DOM.
    // - For reset/reload, we explicitly scroll to this._scrollTop once.
    const restoreToken = this._restoreScrollNext ? this._nextScrollRestoreToken() : 0;
    if (this._restoreScrollNext) this._captureScrollAnchor();

    const fromVal = this._toInputValue(this.filters.from);
    const toVal = this._toInputValue(this.filters.to);
    const fromDate = fromVal ? fromVal.slice(0, 10) : '';
    const toDate = toVal ? toVal.slice(0, 10) : '';
    const rangeLabel = (this.filters.from || this.filters.to)
      ? `${fromDate || '…'} → ${toDate || '…'}`
      : 'All time';

    const layout = (String(this.layout || 'pack') === 'grid') ? 'grid' : 'pack';

    const filters = `
      <div class="filters">
        <button id="open-range" title="Select date range" aria-label="Select date range">📅</button>
        <span class="range-label" title="Current date range">${rangeLabel}</span>
        <button id="clear-range" ${(!this.filters.from && !this.filters.to) ? 'disabled' : ''}>Clear</button>
        <select id="layout" title="Layout">
          <option value="pack" ${layout==='pack'?'selected':''}>Packed</option>
          <option value="grid" ${layout==='grid'?'selected':''}>Grid</option>
        </select>
        <div class="types">
          ${TYPES.map((t) => `
            <label><input type="checkbox" data-type="${t}" ${this.filters.types.has(t) ? 'checked' : ''}> ${t}</label>
          `).join('')}
        </div>
        <div class="actions">
          <button id="compose" title="Compose a new post">Compose</button>
          <button id="reload" ${this.loading?'disabled':''}>Reload</button>
        </div>
      </div>
    `;

    const batchViews = (() => {
      const searchQ = String(this._searchSpec?.query || '').trim();
      const searchActive = !!(this._searchMatcher && searchQ.length >= 2);
      const apiItems = Array.isArray(this._searchApiItems) ? this._searchApiItems : null;
      if (searchActive && apiItems) {
        return [{ id: 'search', items: apiItems }];
      }
      return this.filteredBatches();
    })();
    const shownCount = (() => {
      try {
        let n = 0;
        for (const b of batchViews) n += (Array.isArray(b?.items) ? b.items.length : 0);
        return n;
      } catch {
        return 0;
      }
    })();
    const loadedCount = (() => {
      try { return this._allItems().length; } catch { return 0; }
    })();
    const totalCount = Number(this.total || 0) || loadedCount;

    const pickReplyInfo = (it) => {
      try {
        const rec = it?.post?.record || {};
        const r = rec?.reply || null;
        const rootUri = String(r?.root?.uri || '');
        const parentUri = String(r?.parent?.uri || '');
        return { rootUri, parentUri };
      } catch {
        return { rootUri: '', parentUri: '' };
      }
    };

    const searchQ = String(this._searchSpec?.query || '').trim();
    const searchMatcher = this._searchMatcher;
    const searchActive = !!(searchMatcher && searchQ.length >= 2);
    const hudTypes = (() => {
      try {
        const t = this._searchSpec?.filters?.posts?.types;
        if (Array.isArray(t) && t.length) return new Set(t.map(String));
      } catch {}
      return null;
    })();

    const matchesSearch = (it) => {
      if (!searchActive) return true;
      try {
        const p = it?.post || {};
        const rec = p?.record || {};
        const kind = this.itemType(it);
        if (hudTypes && hudTypes.size && !hudTypes.has(kind)) return false;

        const facetsLinks = (() => {
          try { return linksFromFacets(rec).join(' '); } catch { return ''; }
        })();
        const ext = (() => {
          try { return String(extractExternalFromEmbed(p.embed)?.uri || ''); } catch { return ''; }
        })();

        const { rootUri, parentUri } = pickReplyInfo(it);
        const text = [rec.text || '', facetsLinks, ext, kind, p.uri || ''].filter(Boolean).join(' ');
        const fields = {
          type: kind,
          uri: p.uri || '',
          cid: p.cid || '',
          root: rootUri,
          parent: parentUri,
          createdAt: rec.createdAt || p.indexedAt || '',
        };
        return !!searchMatcher(text, fields);
      } catch {
        return true;
      }
    };

    const renderPostBlock = (it, ord = 0, depth = 0, chron = null) => {
      const p = it.post || {};
      const rec = p.record || {};
      const text = renderPostTextHtml(rec.text || '');

      const uri = p.uri || '';
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
              <button class="act" type="button" data-copy-translation data-uri="${esc(uri)}">Copy translation</button>
            </div>
            <div class="translate-text">${renderPostTextHtml(t)}</div>
          </div>
        `;
      })() : '';
      const when = fmtTime(rec.createdAt || p.indexedAt || '');
      const likeCount   = (typeof p.likeCount === 'number') ? p.likeCount : 0;
      const repostCount = (typeof p.repostCount === 'number') ? p.repostCount : 0;
      const replyCount  = (typeof p.replyCount === 'number') ? p.replyCount : 0;
      const open = atUriToWebPost(p.uri);
      const kind = this.itemType(it);
      const embeds = this.renderEmbedsFor(it);

      const cid = p.cid || '';

      const a = p.author || {};
      const meDid = String(this._meDid || '');
      const handle = String(a?.handle || '');
      const display = String(a?.displayName || '');
      const who = display && handle ? `${display} (@${handle})` : (display || (handle ? `@${handle}` : ''));

      const isMine = !!(meDid && String(a?.did || '') === meDid);
      const canEdit = isMine && (String(kind || '') !== 'repost');
      const canDelete = isMine && (String(kind || '') !== 'repost');
      const deletingThis = !!(this._pendingDelete?.uri && String(this._pendingDelete.uri) === String(uri || ''));

      const expanded = this._expandedThreads.has(String(uri || ''));
      const icon = expanded ? '−' : '+';

      const reposted = !!(p?.viewer && p.viewer.repost);
      const repostLabel = reposted ? 'Undo repost' : 'Repost';

      const liked = !!(p?.viewer && p.viewer.like);
      const likeLabel = liked ? 'Unlike' : 'Like';

      return `
        <div class="post" style="--depth:${esc(depth)}" data-ord="${esc(ord)}" data-uri="${esc(uri)}" data-cid="${esc(cid)}">
          <header class="meta">
            <button class="icon" type="button" data-toggle-thread aria-label="Toggle thread" title="Toggle thread">${esc(icon)}</button>
            ${chron ? `<span class="chron">#${esc(chron)}</span>` : ''}
            <span class="kind">${esc(kind)}</span>
            ${who ? `<span class="author">${esc(who)}</span>` : ''}
            <span class="time">${esc(when)}</span>
            ${open ? `<a class="open" target="_blank" rel="noopener" href="${esc(open)}">Open</a>` : ''}
          </header>
          ${text ? `<div class="text">${text}</div>` : ''}
          ${trBlock}
          ${embeds ? `<div class="embeds">${embeds}</div>` : ''}
          <footer class="counts">
            <span title="Replies (click to preview thread; Ctrl/Cmd-click to open Content)" class="count" data-open-interactions data-kind="replies" data-uri="${esc(uri)}" data-cid="${esc(cid)}">💬 ${replyCount}</span>
            <span title="Reposts" class="count" data-open-interactions data-kind="reposts" data-uri="${esc(uri)}" data-cid="${esc(cid)}">🔁 ${repostCount}</span>
            <span title="Likes"   class="count" data-open-interactions data-kind="likes"   data-uri="${esc(uri)}" data-cid="${esc(cid)}">♥ ${likeCount}</span>
          </footer>
          <footer class="actions">
            <button class="act" type="button" data-reply data-uri="${esc(uri)}" data-cid="${esc(cid)}" data-author="${esc(handle ? `@${handle}` : '')}">Reply</button>
            <button class="act" type="button" data-quote data-uri="${esc(uri)}" data-cid="${esc(cid)}">Quote</button>
            ${canEdit ? `<button class="act" type="button" data-edit-post data-uri="${esc(uri)}">Edit</button>` : ''}
            ${uri ? `<button class="act" type="button" data-copy-post-text data-uri="${esc(uri)}">Copy</button>` : ''}
            ${uri ? `<button class="act" type="button" data-translate-post data-uri="${esc(uri)}">${(tr && tr.open) ? 'Hide translation' : 'Translate'}</button>` : ''}
            <button class="act" type="button" data-repost data-uri="${esc(uri)}" data-cid="${esc(cid)}" data-reposted="${reposted ? '1' : '0'}">${esc(repostLabel)}</button>
            <button class="act" type="button" data-like data-uri="${esc(uri)}" data-cid="${esc(cid)}" data-liked="${liked ? '1' : '0'}">${esc(likeLabel)}</button>
            ${canDelete ? `<button class="act danger" type="button" data-delete-post data-uri="${esc(uri)}" ${deletingThis ? 'disabled' : ''}>Delete</button>` : ''}
          </footer>
        </div>
      `;
    };

    const groupIntoThreadsAcrossBatches = (batchViews = []) => {
      // Group by true thread root across *all* rendered batches.
      // Key idea: a newly-created reply often lands in the newest batch, while the root
      // post might be in an older batch. We still want a single root card with sub-posts.
      const byRoot = new Map(); // rootUri -> { key, rootUri, hostBatchId, items: [{it, ord}] }
      const hostBatchByRoot = new Map();
      let seq = 0;

      // First pass: collect all items by root; decide host batch as the first batch in
      // display order where we see that root (newest wins).
      for (let bi = 0; bi < batchViews.length; bi++) {
        const b = batchViews[bi];
        const bid = String(b?.id || '');
        const items = Array.isArray(b?.items) ? b.items : [];
        for (let oi = 0; oi < items.length; oi++) {
          const it = items[oi];
          const uri = String(it?.post?.uri || '');
          const rec = it?.post?.record || {};
          const r = rec?.reply || null;
          const rootUri = String(r?.root?.uri || uri || `${bid}:${oi}`);
          if (!rootUri) continue;

          if (!hostBatchByRoot.has(rootUri)) hostBatchByRoot.set(rootUri, bid);

          let g = byRoot.get(rootUri) || null;
          if (!g) {
            g = { key: rootUri, rootUri, hostBatchId: hostBatchByRoot.get(rootUri) || bid, items: [] };
            byRoot.set(rootUri, g);
          }
          g.hostBatchId = hostBatchByRoot.get(rootUri) || g.hostBatchId || bid;
          g.items.push({ it, ord: ++seq });
        }
      }

      // Second pass: stable order of groups per batch by first occurrence within that batch.
      const groupsByBatch = new Map();
      for (let bi = 0; bi < batchViews.length; bi++) {
        const b = batchViews[bi];
        const bid = String(b?.id || '');
        const items = Array.isArray(b?.items) ? b.items : [];
        const seen = new Set();
        for (let oi = 0; oi < items.length; oi++) {
          const it = items[oi];
          const uri = String(it?.post?.uri || '');
          const rec = it?.post?.record || {};
          const r = rec?.reply || null;
          const rootUri = String(r?.root?.uri || uri || `${bid}:${oi}`);
          if (!rootUri) continue;
          const g = byRoot.get(rootUri);
          if (!g) continue;
          if (String(g.hostBatchId || '') !== bid) continue;
          if (seen.has(rootUri)) continue;
          seen.add(rootUri);
          if (!groupsByBatch.has(bid)) groupsByBatch.set(bid, []);
          groupsByBatch.get(bid).push(g);
        }
      }

      return { byRoot, groupsByBatch };
    };

    const renderThreadEntry = (group, batchId, chron = null) => {
      const key = String(group?.key || '');
      const anchorKey = `${key}::${String(batchId || '')}`;
      const items = Array.isArray(group?.items) ? group.items : [];
      const groupRootUri = String(group?.rootUri || '');

      const kindOf = (it) => { try { return this.itemType(it); } catch { return 'post'; } };
      const pickRootObj = () => {
        // Prefer a real "post" item if we have it; fall back to any item whose post.uri is the root.
        const rootMatches = items.filter((x) => String(x?.it?.post?.uri || '') === groupRootUri);
        const prefer = rootMatches.find((x) => kindOf(x.it) === 'post')
          || rootMatches.find((x) => kindOf(x.it) !== 'repost')
          || rootMatches[0]
          || items[0]
          || null;
        return prefer;
      };

      const rootObj = pickRootObj();
      const rootIt = rootObj?.it || null;
      const rootOrd = rootObj?.ord || 0;

      const rootPostView = (groupRootUri && this._postCache.has(groupRootUri)) ? (this._postCache.get(groupRootUri) || null) : null;
      const rootUri = groupRootUri || String(rootIt?.post?.uri || '');
      const rootCid = String(rootPostView?.cid || rootIt?.post?.cid || '');

      const repliesInGroup = items
        .map((x) => ({ it: x?.it || null, ord: x?.ord || 0 }))
        .filter((x) => x.it && kindOf(x.it) === 'reply' && String(x.it?.post?.uri || '') !== rootUri);

      const entryIsThread = (repliesInGroup.length > 0)
        || ((typeof rootIt?.post?.replyCount === 'number') && rootIt.post.replyCount > 0);
      const entryClass = entryIsThread ? 'entry is-thread' : 'entry';

      const rootPseudoItem = rootPostView ? ({ post: rootPostView }) : null;

      return {
        key,
        anchorKey,
        html: `
          <article class="${entryClass}" data-k="${esc(anchorKey)}" data-uri="${esc(rootUri)}" data-cid="${esc(rootCid)}">
            ${rootPseudoItem
              ? renderPostBlock(rootPseudoItem, rootOrd, 0, chron)
              : (rootIt ? renderPostBlock(rootIt, rootOrd, 0, chron) : '')}

            ${repliesInGroup.map(({ it, ord }) => renderPostBlock(it, ord, 1, null)).join('')}
            <div class="inline-thread" data-inline-thread hidden></div>
          </article>
        `
      };
    };

    const searchStatus = (() => {
      if (!searchActive) return '';
      const src = Array.isArray(this._searchApiItems) ? 'db' : 'loaded';
      const err = this._searchApiError ? ` · Error: ${esc(this._searchApiError)}` : '';
      const loading = this._searchApiInFlight ? ' · Searching…' : '';
      return `<div class="search-status">Search: <b>${esc(searchQ)}</b> · Source: ${esc(src)}${loading}${err}</div>`;
    })();

    const buildPackedColumns = (entriesHost) => {
      if (!entriesHost) return;
      if (this.layout !== 'pack') return;

      // Preserve top/bottom window spacers if present.
      const topSpacer = (() => {
        try {
          const el = entriesHost.querySelector(':scope > .win-spacer[data-win-spacer="top"]');
          return el ? el.cloneNode(true) : null;
        } catch { return null; }
      })();
      const bottomSpacer = (() => {
        try {
          const el = entriesHost.querySelector(':scope > .win-spacer[data-win-spacer="bottom"]');
          return el ? el.cloneNode(true) : null;
        } catch { return null; }
      })();

  const cols = Math.max(1, Number(this._computePackCols() || 1));

      // Flatten entries from either direct children or an existing .cols wrapper.
      const entries = Array.from(entriesHost.querySelectorAll(':scope > .entry, :scope > .cols .entry'));
      if (!entries.length) {
        // Ensure no stale column wrapper sticks around.
        const w = entriesHost.querySelector(':scope > .cols');
        if (w) {
          try { w.remove(); } catch { try { entriesHost.removeChild(w); } catch {} }
        }
        try {
          // If we're windowing, keep spacer nodes so scroll height is preserved.
          if (topSpacer || bottomSpacer) {
            entriesHost.textContent = '';
            if (topSpacer) entriesHost.appendChild(topSpacer);
            if (bottomSpacer) entriesHost.appendChild(bottomSpacer);
          }
        } catch {}
        return;
      }

      entriesHost.textContent = '';

      if (topSpacer) entriesHost.appendChild(topSpacer);
      const colsWrap = document.createElement('div');
      colsWrap.className = 'cols';
      colsWrap.setAttribute('data-cols', String(cols));

      const colEls = [];
      for (let i = 0; i < cols; i++) {
        const c = document.createElement('div');
        c.className = 'col';
        colsWrap.appendChild(c);
        colEls.push(c);
      }

      entriesHost.appendChild(colsWrap);
      if (bottomSpacer) entriesHost.appendChild(bottomSpacer);

      const heights = new Array(cols).fill(0);
      let tieRot = 0;
      const pickCol = () => {
        let min = heights[0] ?? 0;
        for (let i = 1; i < heights.length; i++) {
          const h = heights[i] ?? 0;
          if (h < min) min = h;
        }
        const candidates = [];
        for (let i = 0; i < heights.length; i++) {
          if ((heights[i] ?? 0) <= min + 1) candidates.push(i);
        }
        if (!candidates.length) return 0;
        const idx = candidates[tieRot % candidates.length];
        tieRot++;
        return idx;
      };

      for (const el of entries) {
        const idx = pickCol();
        colEls[idx].appendChild(el);
        // Update measured column height (includes all children).
        try {
          heights[idx] = colEls[idx].offsetHeight || colEls[idx].getBoundingClientRect().height || heights[idx];
        } catch {
          // leave as-is
        }
      }
    };

    let chron = 0;
    const grouped = groupIntoThreadsAcrossBatches(batchViews);
    const batchRenders = batchViews.map((b) => {
      const bid = String(b?.id || '');
      const groupsAll = Array.isArray(grouped?.groupsByBatch?.get(bid)) ? grouped.groupsByBatch.get(bid) : [];
      const groups = searchActive
        ? groupsAll.filter((g) => {
            try {
              const arr = Array.isArray(g?.items) ? g.items : [];
              return arr.some(({ it }) => matchesSearch(it));
            } catch {
              return true;
            }
          })
        : groupsAll;

      const cards = groups.map((g) => renderThreadEntry(g, bid, ++chron));
      const entriesHtml = cards.map((c) => c.html).join('');
      return { id: bid, cards, entriesHtml };
    });

    const ensureStaticDom = () => {
      const existing = this.shadowRoot.querySelector('bsky-panel-shell');
      if (existing) return false;

      this.shadowRoot.innerHTML = `
      <style>
        :host, *, *::before, *::after{box-sizing:border-box}
        :host{display:block;margin:0;--bsky-posts-ui-offset:290px}
        :host{--bsky-grid-gutter:0px; --bsky-card-gap:0px; --bsky-panels-gap:0px}
        .filters{display:flex;gap:var(--bsky-panel-control-gap-dense, 6px);flex-wrap:wrap;align-items:center}
        .filters label{color:#ddd}
        .range-label{color:#bbb;font-size:.9rem;white-space:nowrap;max-width:45ch;overflow:hidden;text-overflow:ellipsis}
        .types{display:flex;gap:var(--bsky-panel-control-gap-dense, 6px);flex-wrap:wrap}
        .actions{margin-left:auto}

        .entries{width:100%;display:block}
        .batch{width:100%}
        .batch-hr{border:0;border-top:1px solid #222;margin:20px 0}

        .search-status{margin:8px 0;color:#bbb;font-size:.9rem}

        .toast{display:flex;gap:10px;align-items:center;justify-content:space-between;margin:10px 0;padding:8px 10px;border:1px solid #333;background:#0f0f0f}
        .toast-msg{color:#ddd;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .toast-actions{display:flex;gap:8px;flex:0 0 auto}
        .toast-btn{background:#111;border:1px solid #555;color:#fff;padding:6px 10px;border-radius:0;cursor:pointer}

        .act.danger{border-color:#7a2b2b}
        .act.danger:hover{border-color:#b13a3a}

        /* Layout modes (pure CSS; no JS masonry/reparenting).
           - grid: CSS grid (source order).
           - pack: fixed columns filled left→right in source order so the top row is newest.
         */
        .entries{max-width:100%;min-height:0}
        .entries.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--bsky-card-min-w, 350px),1fr));gap:var(--bsky-card-gap, var(--bsky-grid-gutter, 0px));align-items:start}
        .entries.grid .entry{width:100%;max-width:100%;min-width:0;margin:0;}
        /* Lightweight “windowing” (grid mode only): skip rendering offscreen entries. */
        .entries.grid .entry{content-visibility:auto;contain-intrinsic-size:350px 520px}

        .entries.pack{display:block}
        .entries.pack .cols{display:flex;gap:var(--bsky-card-gap, var(--bsky-grid-gutter, 0px));align-items:flex-start;width:100%;max-width:100%}
        .entries.pack .col{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:var(--bsky-card-gap, var(--bsky-grid-gutter, 0px))}
        .entries.pack .entry{width:100%;max-width:100%;min-width:0;margin:0;}

        .entry{border:2px solid #333; border-radius:0; padding:5px; margin:0; background:#0b0b0b; width:100%; max-width:100%}
        .entry.is-thread{border:2px dotted rgba(255,255,255,0.9); padding-top:7px; padding-bottom:7px}

        /* Inline thread expansion */
        .inline-thread{margin-top:10px; padding:10px; border-top:1px solid #222}
        .inline-reply{margin-top:10px; padding:10px; border-top:1px solid #222}
        .inline-actions{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
        .meta{display:flex; align-items:center; gap:10px; color:#bbb; font-size:.9rem; margin-bottom:6px}
        .meta .icon{appearance:none;background:#111;border:1px solid #444;color:#fff;padding:0 8px;height:26px;line-height:24px}
        .meta .chron{background:#111;border:1px solid #444;border-radius:0;padding:1px 8px;color:#ddd}
        .meta .kind{background:#111;border:1px solid #444;border-radius:0;padding:1px 8px}
        .meta .author{color:#ddd;max-width:40ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .meta .time{margin-left:auto}
        .open{color:#9cd3ff}
        .text{white-space:pre-wrap;line-height:1.35}
        .counts{display:flex;gap:12px;color:#bbb;margin-top:6px}
        .counts .count{cursor:pointer}
        .actions{display:flex;gap:8px;margin-top:8px}
        .act{background:#111;border:1px solid #555;color:#fff;padding:6px 10px;border-radius:0;cursor:pointer}

        /* External cards (generic) */
        .embeds{margin-top:8px}
        .ext-card{display:block;border:1px solid #333;border-radius:0;overflow:hidden;background:#0f0f0f;width:100%}
        .ext-card.link{text-decoration:none;color:#fff;display:flex;flex-wrap:wrap;gap:0;width:100%}
        .ext-card .thumb{position:relative;flex:0 0 160px;max-width:100%;background:#111}
        .ext-card .thumb-img{width:100%;height:100%;object-fit:cover;display:block}
        .ext-card .meta{padding:10px;display:flex;flex-direction:column;gap:6px;flex:1 1 220px;min-width:0}
        .ext-card .title{font-weight:700;line-height:1.2}
        .ext-card .desc{color:#ccc;font-size:.95rem;line-height:1.3;max-height:3.2em;overflow:hidden}
        .ext-card .host{color:#8aa;font-size:.85rem;margin-top:auto}

        /* Images grid */
        .images-grid{display:grid;grid-template-columns:1fr;gap:0;width:100%}
        .img-wrap{margin:0;padding:0;background:#111;border-radius:0;overflow:hidden}
        .img-wrap img{display:block;width:100%;height:100%;object-fit:cover}

        /* Quote posts */
        .quote-embed{display:grid;gap:8px}
        .quote-card{border:1px solid #222;background:#0a0a0a;padding:8px}
        .q-top{display:flex;gap:10px;align-items:center;color:#bbb;font-size:.9rem;margin-bottom:6px}
        .q-who{font-weight:700;color:#eaeaea;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .q-when{margin-left:auto;white-space:nowrap}
        .q-text{white-space:pre-wrap;line-height:1.3;color:#ddd}
        .q-media{margin-top:2px}

        /* Compose quote preview */
        #compose-quote[hidden]{display:none}
        .qbox{border:1px solid #222;background:#0a0a0a;padding:8px}
        .qhead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}
        .qrm{background:#111;border:1px solid #444;color:#fff;padding:4px 8px;border-radius:0;cursor:pointer}
        .qmeta{color:#bbb;font-size:.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .qtext{white-space:pre-wrap;line-height:1.3;color:#ddd;margin-top:6px}

        /* YouTube preview */
        .ext-card.yt{cursor:pointer}
        .ext-card.yt .thumb{width:100%;min-width:0;aspect-ratio:16/9;background:#111}
        .ext-card.yt .thumb img{width:100%;height:100%;object-fit:cover;display:block}
        .ext-card.yt .play{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,.55);border:2px solid #fff;border-radius:0;padding:8px 14px;font-weight:700}
        .ext-card.yt.iframe .yt-16x9{position:relative;width:100%}
        .ext-card.yt.iframe .yt-16x9::before{content:"";display:block;padding-top:56.25%}
        .ext-card.yt.iframe iframe{position:absolute;inset:0;width:100%;height:100%;border:0}

        /* Video poster (Bluesky video) */
        .ext-card.video{text-decoration:none;color:#fff;display:flex;gap:0;flex-wrap:wrap}
        .ext-card.video .thumb{position:relative;flex:0 0 160px;max-width:100%;background:#111;display:flex;align-items:center;justify-content:center}
        .ext-card.video .thumb img{width:100%;height:100%;object-fit:cover;display:block}
        .ext-card.video .play{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,.55);border:2px solid #fff;border-radius:0;padding:8px 14px;font-weight:700}

        .video-wrap video{width:100%;max-width:100%;display:block;background:#000}

        @media (max-width: 520px){
          .ext-card .thumb{flex:0 0 100%;min-width:0}
          .ext-card .meta{flex:0 0 100%}
          :host{--bsky-posts-ui-offset:240px}
        }

        button{background:#111;border:1px solid #555;color:#fff;padding:6px 10px;border-radius:0;cursor:pointer}
        button:disabled{opacity:.6;cursor:not-allowed}
        select{background:#0f0f0f;color:#fff;border:1px solid #333;border-radius:0;padding:6px 10px}
        .muted{color:#aaa}
        .err{color:#f0a2a2}

        .translate{margin:10px 0 0 0; padding:10px; border:1px solid #2b2b2b; background:#0f0f0f; border-radius:10px}
        .translate-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
        .translate-text{white-space:normal}
        .win-spacer{width:100%;pointer-events:none;contain:layout size style}
        .footer{display:flex;justify-content:center}

        dialog{border:1px solid #333;border-radius:0;background:#0b0b0b;color:#fff;padding:0;max-width:min(520px, 92vw)}
        dialog::backdrop{background:rgba(0,0,0,.55)}
        .dlg{padding:14px}
        .dlg-head{padding-bottom:10px;border-bottom:1px solid #222}
        .dlg-body{display:grid;gap:10px;padding:10px 0}
        .dlg-body label{display:grid;gap:6px;color:#ddd}
        .dlg-body input{background:#0f0f0f;color:#fff;border:1px solid #333;border-radius:0;padding:8px 10px}
        .dlg-actions{display:flex;gap:8px;justify-content:flex-end;padding-top:10px;border-top:1px solid #222}

        bsky-lazy-img.lazy-media{display:block;width:100%;background:#111}
        .ext-card .thumb{background:#111;overflow:hidden}
        .ext-card.link .thumb{width:72px;height:72px;flex:0 0 auto;display:flex;align-items:center;justify-content:center}
        .ext-card.link .thumb-img{width:72px;height:72px}
        .images-grid{display:grid;grid-template-columns:1fr;gap:6px;margin-top:6px}
        .img-wrap{background:#111;overflow:hidden}
        .img-wrap bsky-lazy-img{width:100%}
      </style>
      <bsky-panel-shell title="Posts" dense persist-key="posts" style="--bsky-panel-ui-offset: var(--bsky-posts-ui-offset)">
        <div id="head-right" slot="head-right" class="muted"></div>
        <div id="toolbar" slot="toolbar"></div>
        <div id="list">
          <div id="toast"></div>
          <div id="search-status"></div>
          <div id="batches"></div>
          <div id="empty" class="muted"></div>
        </div>
        <div id="err" class="muted" style="color:#f88" hidden></div>
        <div slot="footer" class="footer"><button id="more"></button></div>
      </bsky-panel-shell>

      <dialog id="range-dlg">
        <form method="dialog" class="dlg">
          <div class="dlg-head"><strong>Date range</strong></div>
          <div class="dlg-body">
            <label>From
              <input id="dlg-from" type="date" value="">
            </label>
            <label>To
              <input id="dlg-to" type="date" value="">
            </label>
            <div class="muted">Pick a lower/upper timeframe to filter posts.</div>
          </div>
          <div class="dlg-actions">
            <button value="cancel">Cancel</button>
            <button id="dlg-clear" type="button">Clear</button>
            <button id="dlg-apply" type="button">Apply</button>
          </div>
        </form>
      </dialog>

      <dialog id="compose-dlg">
        <div class="dlg">
          <div class="dlg-head" style="display:flex;align-items:center;justify-content:space-between;gap:10px">
            <strong>Compose</strong>
            <button id="compose-close" type="button">Close</button>
          </div>
          <div class="dlg-body">
            <div id="compose-quote" hidden></div>
            <bsky-comment-composer mode="post" thread="1" maxchars="300"></bsky-comment-composer>
          </div>
        </div>
      </dialog>
    `;

      return true;
    };

    const created = ensureStaticDom();

    // Update dynamic regions without recreating the scroller.
    try {
      const headRightEl = this.shadowRoot.getElementById('head-right');
      if (headRightEl) headRightEl.textContent = `Showing: ${shownCount} / ${totalCount}`;

      const toolbarEl = this.shadowRoot.getElementById('toolbar');
      if (toolbarEl) toolbarEl.innerHTML = filters;

      const listEl = this.shadowRoot.getElementById('list');
      if (listEl) {
        // Ensure incremental sub-structure exists (for older cached DOM).
        let toastEl = this.shadowRoot.getElementById('toast');
        let statusEl = this.shadowRoot.getElementById('search-status');
        let batchesEl = this.shadowRoot.getElementById('batches');
        let emptyEl = this.shadowRoot.getElementById('empty');
        if (!toastEl || !statusEl || !batchesEl || !emptyEl) {
          listEl.innerHTML = '<div id="toast"></div><div id="search-status"></div><div id="batches"></div><div id="empty" class="muted"></div>';
          toastEl = this.shadowRoot.getElementById('toast');
          statusEl = this.shadowRoot.getElementById('search-status');
          batchesEl = this.shadowRoot.getElementById('batches');
          emptyEl = this.shadowRoot.getElementById('empty');
        }

        if (toastEl) toastEl.innerHTML = `${this._renderDeleteToast()}${this._renderScheduleToast()}`;

        if (statusEl) statusEl.innerHTML = searchStatus || '';

        // Decide whether we can append-only (no teardown) or we must rebuild.
        const desiredIds = batchRenders.map((b) => b.id);
        const layoutChanged = (String(this._lastLayout || '') !== String(layout));
        this._lastLayout = layout;
        const allowReuse = !searchActive && !layoutChanged; // search/layout changes may change visible cards in every batch
        const prev = Array.isArray(this._renderedBatchOrder) ? this._renderedBatchOrder : [];

        const isAppendOnly = (() => {
          if (!allowReuse) return false;
          if (!prev.length) return true;
          if (desiredIds.length < prev.length) return false;
          for (let i = 0; i < prev.length; i++) {
            if (prev[i] !== desiredIds[i]) return false;
          }
          return true;
        })();

        const rebuildAll = !isAppendOnly;
        this._lastRenderRebuiltAll = rebuildAll;
        if (batchesEl) {
          if (rebuildAll) {
            batchesEl.textContent = '';
          }

          // Map existing sections for quick reuse.
          const byId = new Map();
          if (!rebuildAll) {
            for (const sec of Array.from(batchesEl.querySelectorAll(':scope > section.batch[data-batch]'))) {
              const bid = String(sec.getAttribute('data-batch') || '');
              if (bid) byId.set(bid, sec);
            }
          }

          for (let i = 0; i < batchRenders.length; i++) {
            const b = batchRenders[i];
            const bid = b.id;
            const wantDivider = (i > 0);

            // Divider element (one per batch except the first).
            if (wantDivider) {
              const hr = document.createElement('hr');
              hr.className = 'batch-hr';
              hr.setAttribute('aria-hidden', 'true');
              hr.setAttribute('data-hr-for', bid);
              if (rebuildAll) batchesEl.appendChild(hr);
              else {
                // On append-only, the hr only needs to exist for new batches.
                if (!batchesEl.querySelector(`:scope > hr.batch-hr[data-hr-for="${this._cssEscape(bid)}"]`)) {
                  batchesEl.appendChild(hr);
                }
              }
            }

            let sec = byId.get(bid) || null;
            if (!sec) {
              sec = document.createElement('section');
              sec.className = 'batch';
              sec.setAttribute('data-batch', bid);
              sec.innerHTML = `
                <div class="entries" data-batch="${esc(bid)}" role="region" aria-label="Posts batch"></div>
              `;
              batchesEl.appendChild(sec);
              byId.set(bid, sec);
            }

            const entriesHost = sec.querySelector(':scope > .entries[data-batch]') || null;
            if (entriesHost) {
              // Always apply the current layout class (even for append-only renders).
              try {
                entriesHost.classList.toggle('grid', layout === 'grid');
                entriesHost.classList.toggle('pack', layout !== 'grid');
              } catch {}

              // True DOM windowing to prevent massive entry DOM growth.
              const winCtl = (() => {
                const id = String(bid || '');
                let ctl = null;
                try { ctl = this._winByBatch?.get?.(id) || null; } catch { ctl = null; }
                if (!ctl) {
                  ctl = new ListWindowingController(this, {
                    getRoot: () => this.shadowRoot,
                    getScroller: () => this._getScroller(),
                    getListEl: () => entriesHost,
                    itemSelector: '.entry[data-k]',
                    keyAttr: 'data-k',
                    enabled: () => true,
                    getLayout: () => 'grid',
                    getColumns: () => (this.layout === 'pack' ? this._computePackCols() : 0),
                    minItemsToWindow: 90,
                    estimatePx: 560,
                    overscanItems: 16,
                    keyFor: (c) => String(c?.anchorKey || ''),
                    renderRow: (c) => String(c?.html || ''),
                    onAfterRender: () => {
                      // Repack and rehydrate after window-only rerenders.
                      if (this.layout === 'pack') buildPackedColumns(entriesHost);
                      this._rehydrateExpandedThreadsWithin(entriesHost);
                    },
                  });
                  try { this._winByBatch?.set?.(id, ctl); } catch {}
                }
                return ctl;
              })();

              try { winCtl.setItems(Array.isArray(b?.cards) ? b.cards : []); } catch {}

              // Only update existing batch HTML when we can't safely reuse (e.g. search active).
              if (rebuildAll || !allowReuse) {
                entriesHost.innerHTML = winCtl.innerHtml({ loadingHtml: '<div class="muted">Loading…</div>', emptyHtml: '' });
              } else if (!sec.dataset.bskyRendered) {
                // First time created.
                entriesHost.innerHTML = winCtl.innerHtml({ loadingHtml: '<div class="muted">Loading…</div>', emptyHtml: '' });
              }

              // Ensure window bindings are live; also repacks/rehydrates via onAfterRender.
              winCtl.afterRender();
            }
            sec.dataset.bskyRendered = '1';
          }

          // Remove any stale sections when rebuilding.
          if (rebuildAll) {
            // (Already cleared)
          } else {
            const desired = new Set(desiredIds);
            for (const sec of Array.from(batchesEl.querySelectorAll(':scope > section.batch[data-batch]'))) {
              const bid = String(sec.getAttribute('data-batch') || '');
              if (bid && !desired.has(bid)) {
                try {
                  const hr = batchesEl.querySelector(`:scope > hr.batch-hr[data-hr-for="${this._cssEscape(bid)}"]`);
                  if (hr) hr.remove();
                } catch {}
                try { sec.remove(); } catch { try { batchesEl.removeChild(sec); } catch {} }
              }
            }
          }
        }

        this._renderedBatchOrder = desiredIds;

        const visibleCount = (() => {
          try {
            let n = 0;
            for (const b of batchRenders) n += (b.entriesHtml ? 1 : 0);
            return n;
          } catch { return 0; }
        })();

        if (emptyEl) {
          const anyPosts = (batchRenders.length > 0) && (visibleCount > 0);
          const hasMore = !!this.cursor || !this._backfillDone;
          emptyEl.innerHTML = renderListEndcap({
            loading: !!this.loading && !anyPosts,
            loadingMore: !!this.loading && anyPosts,
            hasMore,
            count: anyPosts ? 1 : 0,
            emptyText: 'No posts.',
          });
        }
      }

      const errEl = this.shadowRoot.getElementById('err');
      if (errEl) {
        if (this.error) {
          errEl.hidden = false;
          errEl.textContent = `Error: ${String(this.error || '')}`;
        } else {
          errEl.hidden = true;
          errEl.textContent = '';
        }
      }

      const moreBtn = this.shadowRoot.getElementById('more');
      if (moreBtn) {
        const hasMore = !!this.cursor || !this._backfillDone;
        moreBtn.hidden = !hasMore;
        moreBtn.disabled = !!(this.loading || !hasMore);
        moreBtn.textContent = 'Load more';
      }

      const dlgFrom = this.shadowRoot.getElementById('dlg-from');
      const dlgTo = this.shadowRoot.getElementById('dlg-to');
      if (dlgFrom) dlgFrom.value = String(fromDate || '');
      if (dlgTo) dlgTo.value = String(toDate || '');
    } catch {
      // ignore
    }

    // Restore viewport anchoring only for prepend flows.
    // For normal paging (append older entries), we intentionally do not touch scrollTop.
    queueMicrotask(() => {
      requestAnimationFrame(() => {
        const scroller = this.shadowRoot.querySelector('bsky-panel-shell')?.getScroller?.();
        if (!scroller) return;

        if (this._restoreScrollNext) {
          this._applyScrollAnchor(restoreToken);
          try { this._maybeRevealFocusedEntry(); } catch {}
          setTimeout(() => {
            this._applyScrollAnchor(restoreToken);
            try { this._maybeRevealFocusedEntry(); } catch {}
          }, 160);
          return;
        }

        const force = !!this._forceScrollTopOnRender;
        this._forceScrollTopOnRender = false;
        if (force || created) scroller.scrollTop = Math.max(0, Number(this._scrollTop || 0) || 0);
      });
    });

    // Infinite scroll: load the next page when nearing the bottom.
    // (Centralized binding + dedupe via shared controller.)
    this._listCtl.afterRender();

    // After initial/reset load, auto-fetch until the viewport is scrollable.
    if (this._autoFillPending) {
      queueMicrotask(() => this._kickAutoFillViewport());
    }

    // If the DOM was rebuilt, restore expanded inline threads.
    if (created || this._lastRenderRebuiltAll) {
      queueMicrotask(() => {
        try {
          const entries = Array.from(this.shadowRoot.querySelectorAll('.entry[data-uri]'));
          for (const entry of entries) {
            const uri = String(entry.getAttribute('data-uri') || '');
            if (!uri || !this._expandedThreads.has(uri)) continue;
            const cid = String(entry.getAttribute('data-cid') || '');
            const mode = this._expandedThreadMode.get(uri) || 'full';
            const host = entry.querySelector('[data-inline-thread]');
            const hasTree = !!host?.querySelector?.('bsky-thread-tree');
            if (host && !hasTree) {
              this._toggleInlineThread(entry, { uri, cid }, { ensureOpen: true, mode });
            }
          }
        } catch {}
      });
    }

  }
}
customElements.define('bsky-my-posts', BskyMyPosts);
