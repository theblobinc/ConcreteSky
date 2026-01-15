// application/single_pages/bluesky_feed/js/components/my_posts.js
import { call } from '../../../api.js';
import { getAuthStatusCached, isNotConnectedError } from '../../../auth_state.js';
import { bindInfiniteScroll, resolvePanelScroller, captureScrollAnchor, applyScrollAnchor } from '../../panel_api.js';
import { BSKY_SEARCH_EVENT } from '../../../search/search_bus.js';
import { SEARCH_TARGETS } from '../../../search/constants.js';
import { compileSearchMatcher } from '../../../search/query.js';

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

// Render images grid
function renderImagesGrid(images) {
  const items = images.map(i => `
    <figure class="img-wrap">
      <bsky-lazy-img class="lazy-media" src="${esc(i.src)}" alt="${esc(i.alt)}" aspect="${(i.arW && i.arH) ? `${Math.max(1,i.arW)}/${Math.max(1,i.arH)}` : '1/1'}"></bsky-lazy-img>
    </figure>
  `).join('');
  return `<div class="images-grid">${items}</div>`;
}

// Render video poster card (we’ll open the post to play if it’s HLS)
function renderVideoPoster(video, openUrl) {
  const poster = video.thumb ? `<bsky-lazy-img class="lazy-media" src="${esc(video.thumb)}" alt="${esc(video.alt||'Video')}" aspect="16/9"></bsky-lazy-img>` : '';
  return `
    <a class="ext-card video" href="${esc(openUrl)}" target="_blank" rel="noopener" title="Open to play">
      <div class="thumb">
        ${poster}
        <div class="play">▶</div>
      </div>
      <div class="meta">
        <div class="title">Video</div>
        <div class="desc">Open in Bluesky to play</div>
      </div>
    </a>
  `;
}

class BskyMyPosts extends HTMLElement {
  constructor(){
    super();
    this.attachShadow({mode:'open'});
    this._batches = []; // [{ id, items: [] }]
    this.loading = false;
    this.error = null;
    this.cursor = null;
    this.filters = { from: '', to: '', types: new Set(TYPES) };
    // Single layout mode: MagicGrid.
    this.view = 'magic';

    this._batchSeq = 0;
    this._layoutRO = null;
    this._cutoff = null;
    this._pagesMax = 15;
    this._offset = 0;

    this._latestIso = '';

    this._unbindInfiniteScroll = null;
    this._infiniteScrollEl = null;
    this._backfillInFlight = false;
    this._backfillDone = false;

    this._scrollTop = 0;
    this._restoreScrollNext = false;
    this._scrollAnchor = null; // { key, offsetY, scrollTop }
    this._scrollAnchorApplyTries = 0;
    this._autoFillPending = true;
    this._autoFillTries = 0;

    this.total = 0;

    this._searchSpec = null;
    this._searchMatcher = null;
    this._onSearchChanged = null;

    this._searchApiTimer = null;
    this._searchApiInFlight = false;
    this._searchApiError = null;
    this._searchApiItems = null;
    this._refreshRecentHandler = (e) => {
      const mins = Number(e?.detail?.minutes ?? 2);
      this.refreshRecent(mins);
    };
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

  connectedCallback(){
    this.render();
    this.load(true);
    this.shadowRoot.addEventListener('change', (e) => this.onChange(e));
    this.shadowRoot.addEventListener('click',  (e) => this.onClick(e));
    this.shadowRoot.addEventListener('keydown', (e) => this.onKeydown(e));

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
  }

  disconnectedCallback(){
    window.removeEventListener('bsky-refresh-recent', this._refreshRecentHandler);
    if (this._authChangedHandler) window.removeEventListener('bsky-auth-changed', this._authChangedHandler);
    if (this._onSearchChanged) {
      try { window.removeEventListener(BSKY_SEARCH_EVENT, this._onSearchChanged); } catch {}
      this._onSearchChanged = null;
    }
    if (this._searchApiTimer) { try { clearTimeout(this._searchApiTimer); } catch {} this._searchApiTimer = null; }
    if (this._layoutRO) { try { this._layoutRO.disconnect(); } catch {} this._layoutRO = null; }
    if (this._unbindInfiniteScroll) { try { this._unbindInfiniteScroll(); } catch {} this._unbindInfiniteScroll = null; }
    this._infiniteScrollEl = null;
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
      const scroller = resolvePanelScroller(this);
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

  _applyScrollAnchor(){
    if (!this._restoreScrollNext) return;

    try {
      const scroller = resolvePanelScroller(this);
      if (!scroller) return;

      const a = this._scrollAnchor;
      if (!a) {
        this._restoreScrollNext = false;
        return;
      }

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

  _computeColumns(){
    try {
      const shell = this.shadowRoot.querySelector('bsky-panel-shell');
      const scroller = shell?.getScroller?.() || null;

      const UNIT = this._cssPx('--bsky-grid-unit', 0);
      const panelSpanRaw = this._cssPx('--bsky-panel-span', 0);
      const panelSpan = Math.max(0, Math.round(panelSpanRaw || 0));
      const GAP = this._cssPx('--bsky-grid-gutter', this._cssPx('--bsky-card-gap', 0));

      const MIN_SPAN = 2;
      const MIN = (UNIT && UNIT > 0)
        ? Math.max(1, Math.floor((UNIT * MIN_SPAN) + GAP))
        : this._cssPx('--bsky-card-min-w', 350);

      const fallback = this.getBoundingClientRect?.().width || 0;
      const available = scroller?.clientWidth || scroller?.getBoundingClientRect?.().width || fallback || 0;
      if (!available || available < 2) return { cols: 1, cardW: Math.max(1, Math.floor(available || MIN)), gap: GAP };

      const colsBySpan = (panelSpan >= MIN_SPAN) ? Math.max(1, Math.floor(panelSpan / MIN_SPAN)) : 0;
      const colsByMin = Math.max(1, Math.floor((available + GAP) / (MIN + GAP)));
      const cols = colsBySpan ? Math.min(colsBySpan, colsByMin) : colsByMin;
      const cardW = Math.max(1, Math.floor((available - ((cols - 1) * GAP)) / cols));

      return { cols: Math.max(1, cols), cardW, gap: GAP };
    } catch {
      return { cols: 1, cardW: this._cssPx('--bsky-card-min-w', 350), gap: this._cssPx('--bsky-grid-gutter', 0) };
    }
  }

  ensureMagicGrid(){
    if (this.view !== 'magic') {
      if (this._layoutRO) { try { this._layoutRO.disconnect(); } catch {} this._layoutRO = null; }
      return;
    }

    const hosts = Array.from(this.shadowRoot.querySelectorAll('.entries.magic[data-batch]'));
    if (!hosts.length) return;

    let _rebalanceQueued = false;
    let _rebalanceTimer = null;
    let _lastRebalanceAt = 0;
    const queueRebalance = () => {
      // Coalesce bursts (ResizeObserver + many image loads) into a single rebalance.
      if (_rebalanceTimer) return;
      _rebalanceTimer = setTimeout(() => {
        _rebalanceTimer = null;
        if (_rebalanceQueued) return;
        _rebalanceQueued = true;
        requestAnimationFrame(() => {
          _rebalanceQueued = false;
          _lastRebalanceAt = Date.now();
          // Keep the current top-most visible entry pinned while we reshuffle.
          this._captureScrollAnchor();
          this._restoreScrollNext = true;
          rebalance();
          requestAnimationFrame(() => this._applyScrollAnchor());
        });
      }, 60);
    };

    const rebalance = () => {
      const { cols, cardW, gap } = this._computeColumns();
      this.style.setProperty('--bsky-card-w', `${cardW}px`);
      this.style.setProperty('--bsky-grid-gutter', `${gap}px`);

      for (const host of hosts) {
        try {
          const entries = Array.from(host.querySelectorAll(':scope > .entry, :scope > .cols > .col > .entry'));
          if (!entries.length) continue;

          if (cols <= 1) {
            host.innerHTML = '';
            for (const el of entries) host.appendChild(el);
            continue;
          }

          // Keep a stable order within the batch so repeated rebalances don't reshuffle.
          const ordFor = (el, fallback) => {
            const raw = el?.getAttribute?.('data-ord');
            const n = Number.parseInt(String(raw || ''), 10);
            return Number.isFinite(n) ? n : fallback;
          };
          const ordered = entries.slice().sort((a, b) => ordFor(a, 0) - ordFor(b, 0));

          // Create/reuse the columns wrapper to avoid heavy DOM teardown.
          let colsWrap = host.querySelector(':scope > .cols');
          if (!colsWrap) {
            colsWrap = document.createElement('div');
            colsWrap.className = 'cols';
            host.innerHTML = '';
            host.appendChild(colsWrap);
          }

          // Ensure column count.
          const colEls = Array.from(colsWrap.querySelectorAll(':scope > .col'));
          while (colEls.length < cols) {
            const c = document.createElement('div');
            c.className = 'col';
            colsWrap.appendChild(c);
            colEls.push(c);
          }
          while (colEls.length > cols) {
            const last = colEls.pop();
            if (last) {
              // Move anything remaining into the first column before dropping.
              const first = colEls[0];
              if (first) {
                while (last.firstChild) first.appendChild(last.firstChild);
              }
              try { last.remove(); } catch { try { colsWrap.removeChild(last); } catch {} }
            }
          }

          // Measure entry heights in-place (avoids offscreen reparenting).
          const entryHeights = ordered.map((el) => {
            try { return Math.max(0, el.getBoundingClientRect().height || 0); } catch { return 0; }
          });

          // Greedy packing by current shortest column.
          const colHeights = new Array(colEls.length).fill(0);
          for (const c of colEls) c.textContent = '';

          for (let i = 0; i < ordered.length; i++) {
            const el = ordered[i];
            const h = entryHeights[i] || 0;

            let bestIdx = 0;
            let bestH = colHeights[0] ?? 0;
            for (let c = 1; c < colHeights.length; c++) {
              const ch = colHeights[c] ?? 0;
              if (ch < bestH) { bestH = ch; bestIdx = c; }
            }

            colEls[bestIdx].appendChild(el);
            colHeights[bestIdx] = (colHeights[bestIdx] ?? 0) + h;
          }

          // Late-loading media can change entry heights after initial packing.
          const imgs = Array.from(host.querySelectorAll('img'));
          for (const img of imgs) {
            try {
              if (img.dataset?.bskyRebalanceBound === '1') continue;
              if (img.complete) continue;
              img.dataset.bskyRebalanceBound = '1';
              img.addEventListener('load', queueRebalance, { once: true });
              img.addEventListener('error', queueRebalance, { once: true });
            } catch {
              // ignore
            }
          }
        } catch {
          // ignore
        }
      }
    };

    // Run once, then once more after layout settles.
    // IMPORTANT: always go through queueRebalance so we preserve the user's
    // scroll position while DOM is re-parented into columns.
    queueRebalance();
    requestAnimationFrame(() => queueRebalance());

    // The posts DOM is re-created on every render(), so always re-bind observer.
    if (this._layoutRO) { try { this._layoutRO.disconnect(); } catch {} this._layoutRO = null; }
    try {
      let t = null;
      this._layoutRO = new ResizeObserver(() => {
        if (t) clearTimeout(t);
        t = setTimeout(() => {
          t = null;
          queueRebalance();
        }, 60);
      });
      // Observe the panel scroller width via the shell.
      const shell = this.shadowRoot.querySelector('bsky-panel-shell');
      const scroller = shell?.getScroller?.() || null;
      if (scroller) this._layoutRO.observe(scroller);
      this._layoutRO.observe(this);
    } catch {
      this._layoutRO = null;
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
    const t = e.target?.getAttribute?.('data-type');
    if (t) {
      if (e.target.checked) this.filters.types.add(t);
      else this.filters.types.delete(t);
      // Reload so limit/offset apply to the selected types.
      this.load(true);
    }

    if (e.target.id === 'view') {
      // Collapse legacy view selections into MagicGrid only.
      this.view = 'magic';
      this.render();
      return;
    }
  }

  onClick(e){
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

    // NEW: open interactions lightbox on counts click
    const cnt = e.target.closest?.('[data-open-interactions]');
    if (cnt) {
      const kind = cnt.getAttribute('data-kind'); // likes|reposts|replies
      const uri  = cnt.getAttribute('data-uri');
      const cid  = cnt.getAttribute('data-cid') || '';
      // Clicking replies should open the thread/content panel.
      if (kind === 'replies' && uri) {
        this.dispatchEvent(new CustomEvent('bsky-open-content', {
          detail: { uri, cid, spawnAfter: 'posts' },
          bubbles: true,
          composed: true,
        }));
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      this.openInteractions(kind, uri, cid);
      return;
    }

    // If the user clicks a nested post inside a grouped thread entry, open that post.
    const nestedPost = e.target.closest?.('.post[data-uri]');
    if (nestedPost) {
      if (e.target.closest?.('a,button,input,select,textarea,[data-yt-id]')) return;
      const uri = nestedPost.getAttribute('data-uri') || '';
      const cid = nestedPost.getAttribute('data-cid') || '';
      if (!uri) return;
      this.dispatchEvent(new CustomEvent('bsky-open-content', {
        detail: { uri, cid, spawnAfter: 'posts' },
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
      this.dispatchEvent(new CustomEvent('bsky-open-content', {
        detail: { uri, cid, spawnAfter: 'posts' },
        bubbles: true,
        composed: true,
      }));
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
    const src = `https://www.youtube.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0`;
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
      this._autoFillPending = true;
      this._autoFillTries = 0;
    } else {
      this._restoreScrollNext = true;
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
        await call('cacheSyncMyPosts', {
          // Seed sync should always use a small recent window.
          hours: 24,
          pagesMax: this._pagesMax,
          filter,
        });
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
      const res = await call('cacheBackfillMyPosts', {
        // One author-feed page = 100 posts.
        pagesMax: 1,
        filter: this.remoteFilterForSelection(),
      });

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
    // Preserve scroll position across re-renders.
    // For paging renders, capture a visible-entry anchor so masonry reflows don't jump the user.
    if (this._restoreScrollNext) {
      this._captureScrollAnchor();
    } else {
      try {
        const prevScroller = this.shadowRoot.querySelector('bsky-panel-shell')?.getScroller?.();
        if (prevScroller) this._scrollTop = prevScroller.scrollTop || 0;
      } catch {}
    }

    const fromVal = this._toInputValue(this.filters.from);
    const toVal = this._toInputValue(this.filters.to);
    const fromDate = fromVal ? fromVal.slice(0, 10) : '';
    const toDate = toVal ? toVal.slice(0, 10) : '';
    const rangeLabel = (this.filters.from || this.filters.to)
      ? `${fromDate || '…'} → ${toDate || '…'}`
      : 'All time';

    const filters = `
      <div class="filters">
        <button id="open-range" title="Select date range" aria-label="Select date range">📅</button>
        <span class="range-label" title="Current date range">${rangeLabel}</span>
        <button id="clear-range" ${(!this.filters.from && !this.filters.to) ? 'disabled' : ''}>Clear</button>
        <div class="types">
          ${TYPES.map((t) => `
            <label><input type="checkbox" data-type="${t}" ${this.filters.types.has(t) ? 'checked' : ''}> ${t}</label>
          `).join('')}
        </div>
        <div class="actions">
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

    const renderPostBlock = (it, ord = 0, depth = 0) => {
      const p = it.post || {};
      const rec = p.record || {};
      const text = esc(rec.text || '');
      const when = fmtTime(rec.createdAt || p.indexedAt || '');
      const likeCount   = (typeof p.likeCount === 'number') ? p.likeCount : 0;
      const repostCount = (typeof p.repostCount === 'number') ? p.repostCount : 0;
      const replyCount  = (typeof p.replyCount === 'number') ? p.replyCount : 0;
      const open = atUriToWebPost(p.uri);
      const kind = this.itemType(it);
      const embeds = this.renderEmbedsFor(it);

      const uri = p.uri || '';
      const cid = p.cid || '';

      return `
        <div class="post" style="--depth:${esc(depth)}" data-ord="${esc(ord)}" data-uri="${esc(uri)}" data-cid="${esc(cid)}">
          <header class="meta">
            <span class="kind">${esc(kind)}</span>
            <span class="time">${esc(when)}</span>
            ${open ? `<a class="open" target="_blank" rel="noopener" href="${esc(open)}">Open</a>` : ''}
          </header>
          ${text ? `<div class="text">${text}</div>` : ''}
          ${embeds ? `<div class="embeds">${embeds}</div>` : ''}
          <footer class="counts">
            <span title="Replies" class="count" data-open-interactions data-kind="replies" data-uri="${esc(uri)}" data-cid="${esc(cid)}">💬 ${replyCount}</span>
            <span title="Reposts" class="count" data-open-interactions data-kind="reposts" data-uri="${esc(uri)}" data-cid="${esc(cid)}">🔁 ${repostCount}</span>
            <span title="Likes"   class="count" data-open-interactions data-kind="likes"   data-uri="${esc(uri)}" data-cid="${esc(cid)}">♥ ${likeCount}</span>
          </footer>
        </div>
      `;
    };

    const groupIntoThreads = (items = []) => {
      const groups = [];
      const byKey = new Map();

      for (let ord = 0; ord < items.length; ord++) {
        const it = items[ord];
        const uri = String(it?.post?.uri || '');
        const { rootUri } = pickReplyInfo(it);
        const key = (rootUri || uri || String(ord));
        if (!byKey.has(key)) {
          const g = { key, rootUri: rootUri || uri, items: [] };
          byKey.set(key, g);
          groups.push(g);
        }
        byKey.get(key).items.push({ it, ord });
      }

      return groups;
    };

    const renderThreadEntry = (group) => {
      const key = String(group?.key || '');
      const rootUri = String(group?.rootUri || '');
      const items = Array.isArray(group?.items) ? group.items : [];

      // Prefer rendering a real root post if it's present in this batch.
      const rootObj = items.find(({ it }) => String(it?.post?.uri || '') === rootUri) || items[0] || null;
      const rootIt = rootObj?.it || null;
      const rootOrd = rootObj?.ord || 0;
      const rootCid = String(rootIt?.post?.cid || '');

      // Build a reply tree (by parent URI) for items that are replies.
      const nodes = new Map();
      const roots = [];

      for (const o of items) {
        const it = o?.it;
        if (!it) continue;
        const uri = String(it?.post?.uri || '');
        if (!uri) continue;
        if (uri === rootUri) continue;
        if (this.itemType(it) !== 'reply') continue;

        const { parentUri } = pickReplyInfo(it);
        nodes.set(uri, { uri, parentUri: parentUri || rootUri, it, ord: o.ord, children: [] });
      }

      // Attach children.
      for (const node of nodes.values()) {
        const parent = nodes.get(node.parentUri);
        if (parent && parent.uri !== node.uri) parent.children.push(node);
        else roots.push(node);
      }

      const sortTree = (arr) => {
        arr.sort((a, b) => (a.ord - b.ord));
        for (const n of arr) sortTree(n.children);
      };
      sortTree(roots);

      const renderNode = (n, depth) => {
        const childHtml = n.children?.length ? n.children.map((c) => renderNode(c, depth + 1)).join('') : '';
        return `
          <div class="thread-node" style="--depth:${esc(depth)}">
            ${renderPostBlock(n.it, n.ord, depth)}
            ${childHtml ? `<div class="thread-children">${childHtml}</div>` : ''}
          </div>
        `;
      };

      const childrenHtml = roots.length ? `<div class="thread-children">${roots.map((n) => renderNode(n, 1)).join('')}</div>` : '';

      return {
        key,
        html: `
          <article class="entry thread" data-k="${esc(key)}" data-uri="${esc(rootUri)}" data-cid="${esc(rootCid)}">
            ${rootIt ? renderPostBlock(rootIt, rootOrd, 0) : ''}
            ${childrenHtml}
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

    const batchesHtml = batchViews.map((b, idx) => {
      const groupsAll = groupIntoThreads(b.items || []);
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
      const cards = groups.map((g) => renderThreadEntry(g));
      const entriesHtml = cards.map((c) => c.html).join('');
      const divider = idx > 0 ? `<hr class="batch-hr" aria-hidden="true">` : '';
      return `
        ${divider}
        <section class="batch" data-batch="${esc(b.id)}">
          <div class="entries magic" data-batch="${esc(b.id)}" role="region" aria-label="Posts batch">
            ${entriesHtml}
          </div>
        </section>
      `;
    }).join('');

    const listHtml = (searchStatus ? `${searchStatus}${batchesHtml}` : batchesHtml) || (this.loading ? '<div class="muted">Loading…</div>' : '<div class="muted">No posts.</div>');

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

        /* Balanced-columns layout: each batch becomes N columns, entries placed by measured height. */
        .entries.magic{display:block;max-width:100%;min-height:0}
        .entries.magic .cols{display:flex;gap:var(--bsky-grid-gutter, 0px);align-items:flex-start;justify-content:flex-start;width:100%}
        .entries.magic .col{flex:0 0 auto;width:min(100%, var(--bsky-card-w, 350px));display:flex;flex-direction:column;gap:0;min-width:0}
        .entries.magic .entry{width:100%;max-width:100%;min-width:0;margin:0;}

        .entry{border:2px solid #333; border-radius:0; padding:5px; margin:0; background:#0b0b0b; width:100%; max-width:100%}

        /* Thread grouping: render replies/comments nested under the root post */
        .entry.thread{padding:6px}
        .entry.thread .post{border:0; padding:0; margin:0; background:transparent}
        .entry.thread .post + .thread-children{margin-top:8px}
        .thread-node{margin-top:6px; padding-left: calc(var(--depth, 0) * 12px); border-left: 2px solid rgba(255,255,255,0.06)}
        .thread-node .post{border:1px solid #222; background:#0a0a0a; padding:6px}
        .thread-node .thread-children{margin-top:6px}
        .meta{display:flex; align-items:center; gap:10px; color:#bbb; font-size:.9rem; margin-bottom:6px}
        .meta .kind{background:#111;border:1px solid #444;border-radius:0;padding:1px 8px}
        .meta .time{margin-left:auto}
        .open{color:#9cd3ff}
        .text{white-space:pre-wrap;line-height:1.35}
        .counts{display:flex;gap:12px;color:#bbb;margin-top:6px}
        .counts .count{cursor:pointer}

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
        .images-grid{display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:0;width:100%}
        .img-wrap{margin:0;padding:0;background:#111;border-radius:0;overflow:hidden}
        .img-wrap img{display:block;width:100%;height:100%;object-fit:cover}

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

        @media (max-width: 520px){
          .ext-card .thumb{flex:0 0 100%;min-width:0}
          .ext-card .meta{flex:0 0 100%}
          :host{--bsky-posts-ui-offset:240px}
        }

        button{background:#111;border:1px solid #555;color:#fff;padding:6px 10px;border-radius:0;cursor:pointer}
        button:disabled{opacity:.6;cursor:not-allowed}
        select{background:#0f0f0f;color:#fff;border:1px solid #333;border-radius:0;padding:6px 10px}
        .muted{color:#aaa}
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
        .images-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:6px}
        .img-wrap{background:#111;overflow:hidden}
        .img-wrap bsky-lazy-img{width:100%}
      </style>
      <bsky-panel-shell title="Posts" dense style="--bsky-panel-ui-offset: var(--bsky-posts-ui-offset)">
        <div slot="head-right" class="muted">Showing: ${esc(shownCount)} / ${esc(totalCount)}</div>
        <div slot="toolbar">${filters}</div>

        ${listHtml}

        ${this.error ? `<div class="muted" style="color:#f88">Error: ${esc(this.error)}</div>` : ''}

        <div slot="footer" class="footer">
          <button id="more" ${this.loading || (this._backfillDone && !this.cursor) ? 'disabled':''}>
            ${this.cursor ? 'Load more' : (this._backfillDone ? 'No more' : 'Load more')}
          </button>
        </div>
      </bsky-panel-shell>

      <dialog id="range-dlg">
        <form method="dialog" class="dlg">
          <div class="dlg-head"><strong>Date range</strong></div>
          <div class="dlg-body">
            <label>From
              <input id="dlg-from" type="date" value="${esc(fromDate)}">
            </label>
            <label>To
              <input id="dlg-to" type="date" value="${esc(toDate)}">
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
    `;

    // After re-render + relayout, lock the user's view to the same top-most visible entry.
    // We do this *after* column balancing so the anchor survives DOM reparenting.
    queueMicrotask(() => {
      requestAnimationFrame(() => {
        this._applyScrollAnchor();
        setTimeout(() => this._applyScrollAnchor(), 160);
      });
    });

    // Infinite scroll: load the next page when nearing the bottom.
    const scroller = this.shadowRoot.querySelector('bsky-panel-shell')?.getScroller?.();
    if (scroller && scroller !== this._infiniteScrollEl) {
      try { this._unbindInfiniteScroll?.(); } catch {}
      this._infiniteScrollEl = scroller;
      this._unbindInfiniteScroll = bindInfiniteScroll(scroller, () => this.load(false), {
        threshold: 220,
        enabled: () => true,
        isLoading: () => !!this.loading,
        hasMore: () => !!this.cursor,
        onExhausted: () => this.queueOlderFromServer(),
        exhaustedCooldownMs: 5000,
        // We do a smarter "fill viewport" loop ourselves.
        initialTick: false,
      });
    }

    // After initial/reset load, auto-fetch until the viewport is scrollable.
    if (this._autoFillPending) {
      queueMicrotask(() => this._kickAutoFillViewport());
    }

    this.view = 'magic';
    queueMicrotask(() => this.ensureMagicGrid());

  }
}
customElements.define('bsky-my-posts', BskyMyPosts);
