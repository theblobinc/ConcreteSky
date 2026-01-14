// application/single_pages/bluesky_feed/js/components/my_posts.js
import { call } from '../api.js';
import { getAuthStatusCached, isNotConnectedError } from '../auth_state.js';
// Versioned import to bust aggressive browser module cache when MagicGrid changes.
import MagicGrid from '../magicgrid/magic-grid.esm.js?v=0.1.28';

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
      alt: img.alt || ''
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
        <img src="${esc(thumb)}" alt="">
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
  const thumb = external?.thumb ? `<img class="thumb-img" src="${esc(external.thumb)}" alt="">` : '';
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
      <img loading="lazy" src="${esc(i.src)}" alt="${esc(i.alt)}">
    </figure>
  `).join('');
  return `<div class="images-grid">${items}</div>`;
}

// Render video poster card (we’ll open the post to play if it’s HLS)
function renderVideoPoster(video, openUrl) {
  const poster = video.thumb ? `<img src="${esc(video.thumb)}" alt="${esc(video.alt||'Video')}" />` : '';
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
    this.items = [];
    this.loading = false;
    this.error = null;
    this.cursor = null;
    this.filters = { hours: 24, types: new Set(TYPES) };
    // Single layout mode: MagicGrid.
    this.view = 'magic';

    this._magic = null;
    this._magicRO = null;
    this._cutoff = null;
    this._pagesMax = 15;
    this._offset = 0;

    this._refreshRecentHandler = (e) => {
      const mins = Number(e?.detail?.minutes ?? 2);
      this.refreshRecent(mins);
    };
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
        this.items = [];
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
  }

  disconnectedCallback(){
    window.removeEventListener('bsky-refresh-recent', this._refreshRecentHandler);
    if (this._authChangedHandler) window.removeEventListener('bsky-auth-changed', this._authChangedHandler);
    if (this._magicRO) { try { this._magicRO.disconnect(); } catch {} this._magicRO = null; }
    this._magic = null;
  }

  ensureMagicGrid(){
    if (this.view !== 'magic') {
      if (this._magicRO) { try { this._magicRO.disconnect(); } catch {} this._magicRO = null; }
      this._magic = null;
      return;
    }

    const host = this.shadowRoot.querySelector('.posts.magic');
    if (!host) return;

    if (!this._magic) {
      try {
        this._magic = new MagicGrid({
          container: host,
          static: true,
          gutter: 12,
          useTransform: false,
          animate: false,
          center: false,
          maxColumns: false,
          useMin: false,
          itemWidth: 350,
        });
      } catch {
        this._magic = null;
      }
    } else {
      try { this._magic.setContainer(host); } catch {}
    }

    try { this._magic?.positionItems?.(); } catch {}

    if (!this._magicRO) {
      try {
        this._magicRO = new ResizeObserver(() => {
          try { this._magic?.positionItems?.(); } catch {}
        });
        this._magicRO.observe(host);
      } catch {
        this._magicRO = null;
      }
    }
  }

  async refreshRecent(minutes=2){
    if (this.loading) return;
    const mins = Math.max(1, Number(minutes || 2));
    const sinceIso = new Date(Date.now() - (mins * 60 * 1000)).toISOString();

    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) return;

      const out = await call('cacheQueryMyPosts', {
        since: sinceIso,
        hours: Math.max(1, Number(this.filters.hours || 24)),
        limit: 100,
        offset: 0,
        newestFirst: true,
      });

      const batch = out?.items || [];
      if (!batch.length) return;

      const have = new Set(this.items.map(it => it?.post?.uri).filter(Boolean));
      const fresh = [];
      for (const it of batch) {
        const uri = it?.post?.uri;
        if (!uri || have.has(uri)) continue;
        have.add(uri);
        fresh.push(it);
      }

      if (fresh.length) {
        this.items = [...fresh, ...this.items];
        this.render();
      }
    } catch (e) {
      // Silent; auto refresh shouldn't disrupt the UI.
      console.warn('refreshRecent (cache) failed', e);
    }
  }

  onChange(e){
    if (e.target.id === 'range') {
      this.filters.hours = Number(e.target.value || 24);
      this.load(true);
      return;
    }
    const t = e.target?.getAttribute?.('data-type');
    if (t) {
      if (e.target.checked) this.filters.types.add(t);
      else this.filters.types.delete(t);
      this.render();
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
    if (e.target.id === 'more')   { this.load(false); return; }

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
      this.openInteractions(kind, uri, cid);
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
      this.items = [];
      this.cursor = null;
      this._offset = 0;
      this._cutoff = new Date();
      this._cutoff.setHours(this._cutoff.getHours() - (this.filters.hours || 24));
    }

    this.loading = true;
    this.error = null;
    this.render();

    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) {
        this.items = [];
        this.cursor = null;
        this._offset = 0;
        this.error = 'Not connected. Use the Connect button.';
        return;
      }

      const limit = 50;
      const out = await call('cacheQueryMyPosts', {
        hours: Math.max(1, Number(this.filters.hours || 24)),
        limit,
        offset: this._offset,
        newestFirst: true,
      });

      let batch = out?.items || [];

      // If cache is empty on first load, do a one-time seed sync.
      if (reset && batch.length === 0) {
        const wantsReplies = this.filters.types.has('reply');
        const filter = wantsReplies ? 'posts_with_replies' : 'posts_no_replies';
        await call('cacheSyncMyPosts', {
          hours: Math.max(1, Number(this.filters.hours || 24)),
          pagesMax: this._pagesMax,
          filter,
        });
        const out2 = await call('cacheQueryMyPosts', {
          hours: Math.max(1, Number(this.filters.hours || 24)),
          limit,
          offset: this._offset,
          newestFirst: true,
        });
        batch = out2?.items || [];
      }

      const have = new Set(this.items.map(it => it?.post?.uri).filter(Boolean));
      for (const it of batch) {
        const uri = it?.post?.uri;
        if (uri && have.has(uri)) continue;
        if (uri) have.add(uri);
        this.items.push(it);
      }

      this._offset += batch.length;
      this.cursor = out?.hasMore ? 'more' : null;
    } catch (e) {
      this.error = isNotConnectedError(e) ? 'Not connected. Use the Connect button.' : e.message;
    } finally {
      this.loading = false;
      this.render();
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
    const arr = this.items.filter(it => allowed.has(this.itemType(it)));
    arr.sort((a,b) => {
      const at = new Date((a.post?.record?.createdAt) || a.post?.indexedAt || 0);
      const bt = new Date((b.post?.record?.createdAt) || b.post?.indexedAt || 0);
      return bt - at;
    });
    return arr;
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
    const filters = `
      <div class="filters">
        <label>Range:
          <select id="range">
            <option value="24"  ${this.filters.hours===24?'selected':''}>Last 24h</option>
            <option value="72"  ${this.filters.hours===72?'selected':''}>Last 3 days</option>
            <option value="168" ${this.filters.hours===168?'selected':''}>Last 7 days</option>
            <option value="720" ${this.filters.hours===720?'selected':''}>Last 30 days</option>
          </select>
        </label>
          <div class="filters">
            <div class="types">
              ${TYPES.map((t) => `
                <label><input type="checkbox" data-type="${t}" ${this.filters.types.has(t) ? 'checked' : ''}> ${t}</label>
              `).join('')}
            </div>
            <div class="actions">
              <button id="reload" ${this.loading?'disabled':''}>Reload</button>
              <button id="more" ${this.loading || !this.hasMore ? 'disabled' : ''}>More</button>
            </div>
          </div>
    `;

    const ordered = this.filteredItems();

        const cards = ordered.map((it) => {
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

      // data-* hooks so clicking opens the modal
      const uri = p.uri || '';
      const cid = p.cid || '';
      const key = uri || cid || String(rec.createdAt || p.indexedAt || when || '');
          const sizeAttr = '';

      return {
        key,
        html: `<article class="post"${sizeAttr} data-uri="${esc(uri)}" data-cid="${esc(cid)}">
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
        </article>`
      };
    });

    const postsHtml = cards.map(c => c.html).join('');
    const listHtml = postsHtml || (this.loading ? '<div class="muted">Loading…</div>' : '<div class="muted">No posts in this range.</div>');

    this.shadowRoot.innerHTML = `
      <style>
        :host, *, *::before, *::after{box-sizing:border-box}
        :host{display:block;margin:0;--bsky-posts-ui-offset:290px}
        .wrap{border:1px solid #333;border-radius:12px;padding:10px;background:#070707;color:#fff}
        .head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
        .filters{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
        .filters label{color:#ddd}
        .types{display:flex;gap:10px;flex-wrap:wrap}
        .actions{margin-left:auto}

        .postsWrap{width:100%;max-height:calc(100vh - var(--bsky-posts-ui-offset));overflow:auto;padding-right:4px}

        .posts{width:100%;display:block}

        /* MagicGrid: JS-positioned layout (library managed). */
        .posts.magic{position:relative;display:block;width:100%;min-height:0}
        /* Cards need a fixed width so MagicGrid can compute columns. Clamp to 350px but allow shrinking on very narrow panels. */
        .posts.magic .post{width:350px;max-width:350px;margin:0}

        .post{border:1px solid #333; border-radius:10px; padding:10px; margin:0; background:#0b0b0b; width:min(350px, 100%); max-width:350px}
        .meta{display:flex; align-items:center; gap:10px; color:#bbb; font-size:.9rem; margin-bottom:6px}
        .meta .kind{background:#111;border:1px solid #444;border-radius:999px;padding:1px 8px}
        .meta .time{margin-left:auto}
        .open{color:#9cd3ff}
        .text{white-space:pre-wrap;line-height:1.35}
        .counts{display:flex;gap:12px;color:#bbb;margin-top:6px}
        .counts .count{cursor:pointer}

        /* External cards (generic) */
        .embeds{margin-top:8px}
        .ext-card{
          display:block; border:1px solid #333; border-radius:10px; overflow:hidden; background:#0f0f0f; width:100%;
        }
        .ext-card.link{ text-decoration:none; color:#fff; display:flex; flex-wrap:wrap; gap:0; width:100% }
        .ext-card .thumb{ position:relative; flex:0 0 160px; max-width:100%; background:#111; } /* generic card */
        .ext-card .thumb-img{ width:100%; height:100%; object-fit:cover; display:block }
        .ext-card .meta{ padding:10px; display:flex; flex-direction:column; gap:6px; flex:1 1 220px; min-width:0; }
        .ext-card .title{ font-weight:700; line-height:1.2 }
        .ext-card .desc{ color:#ccc; font-size:.95rem; line-height:1.3; max-height:3.2em; overflow:hidden }
        .ext-card .host{ color:#8aa; font-size:.85rem; margin-top:auto }

        /* Images grid */
        .images-grid{
          display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap:6px; width:100%;
        }
        .img-wrap{margin:0; padding:0; background:#111; border-radius:8px; overflow:hidden}
        .img-wrap img{ display:block; width:100%; height:100%; object-fit:cover }

        /* YouTube preview — OVERRIDE the generic card's 40% thumb.
           This makes the preview thumb use full width of the column. */
        .ext-card.yt{ cursor:pointer; }
        .ext-card.yt .thumb{ width:100%; min-width:0; aspect-ratio: 16 / 9; background:#111; } /* <-- override width */
        .ext-card.yt .thumb img{ width:100%; height:100%; object-fit:cover; display:block }
        .ext-card.yt .play{
          position:absolute; inset:auto; left:50%; top:50%;
          transform:translate(-50%,-50%);
          background:rgba(0,0,0,.55); border:2px solid #fff; border-radius:9999px;
          padding:8px 14px; font-weight:700;
        }
        .ext-card.yt.iframe .yt-16x9{ position:relative; width:100%; }
        .ext-card.yt.iframe .yt-16x9::before{ content:""; display:block; padding-top:56.25%; }
        .ext-card.yt.iframe iframe{ position:absolute; inset:0; width:100%; height:100%; border:0; }

        /* Video poster (Bluesky video) */
        .ext-card.video{ text-decoration:none; color:#fff; display:flex; gap:0; }
        .ext-card.video{ flex-wrap:wrap; }
        .ext-card.video .thumb{ position:relative; flex:0 0 160px; max-width:100%; background:#111; display:flex; align-items:center; justify-content:center }
        .ext-card.video .thumb img{ width:100%; height:100%; object-fit:cover; display:block }
        .ext-card.video .play{
          position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
          background:rgba(0,0,0,.55); border:2px solid #fff; border-radius:9999px; padding:8px 14px; font-weight:700;
        }

        /* Stack external cards when the panel is narrow */
        @media (max-width: 520px){
          .ext-card .thumb{ flex:0 0 100%; min-width:0 }
          .ext-card .meta{ flex:0 0 100% }
          :host{--bsky-posts-ui-offset:240px}
        }

        button{background:#111;border:1px solid #555;color:#fff;padding:6px 10px;border-radius:8px;cursor:pointer}
        button:disabled{opacity:.6;cursor:not-allowed}
        select{background:#0f0f0f;color:#fff;border:1px solid #333;border-radius:10px;padding:6px 10px}
        .muted{color:#aaa}
        .footer{margin-top:8px;display:flex;justify-content:center}
      </style>
      <div class="wrap">
        <div class="head"><div><strong>Posts</strong></div></div>
        ${filters}
        <div class="postsWrap" role="region" aria-label="Posts list">
          <div class="posts magic">
            ${listHtml}
          </div>
        </div>
        ${this.error ? `<div class="muted" style="color:#f88">Error: ${esc(this.error)}</div>` : ''}
        <div class="footer">
          <button id="more" ${this.loading || !this.cursor ? 'disabled':''}>${this.cursor ? 'Load more' : 'No more'}</button>
        </div>
      </div>
    `;

    this.view = 'magic';
    queueMicrotask(() => this.ensureMagicGrid());
  }
}
customElements.define('bsky-my-posts', BskyMyPosts);
