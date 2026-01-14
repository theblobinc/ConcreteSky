// application/single_pages/bluesky_feed/js/components/interactions.js
import { call } from '../api.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) =>
  ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[m])
);
const fmtTime = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return ''; } };

// ---------- caching ----------
const postCache   = new Map(); // uri -> post
const threadCache = new Map(); // uri -> normalized thread root

// ---------- link + embed helpers ----------
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

function extractImagesFromEmbed(embed) {
  if (!embed) return null;
  const t = String(embed.$type || '');
  if (t.includes('embed.images') && Array.isArray(embed.images) && embed.images.length) {
    return embed.images.map(img => ({
      src: img.fullsize || img.thumb || '',
      alt: img.alt || ''
    })).filter(i => i.src);
  }
  return null;
}

function extractVideoFromEmbed(embed) {
  if (!embed) return null;
  const t = String(embed.$type || '');
  if (t.includes('embed.video')) {
    return { playlist: embed.playlist || '', thumb: embed.thumbnail || embed.thumb || '', alt: embed.alt || 'Video' };
  }
  return null;
}

function extractExternalFromEmbed(embed) {
  if (!embed) return null;
  const type = String(embed.$type || '');
  if (type.includes('embed.external') && embed.external) return embed.external;
  if (embed.external && (embed.external.uri || embed.external.title || embed.external.thumb)) return embed.external;
  return null;
}

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
        ${desc ? `<div class="desc">${esc(desc)}</div>` : ''}
        <div class="host">${esc(safeHost(u))}</div>
      </div>
    </a>
  `;
}
function safeHost(url) { try { return new URL(url).host; } catch { return ''; } }

function renderImagesGrid(images) {
  const items = images.map(i => `
    <figure class="img-wrap">
      <img loading="lazy" src="${esc(i.src)}" alt="${esc(i.alt)}">
    </figure>
  `).join('');
  return `<div class="images-grid">${items}</div>`;
}

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

function atUriToWebPost(uri) {
  const m = String(uri || '').match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)/);
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : '';
}

// ---------- counts / reach ----------
function countsOf(post) {
  if (!post) return { replies: 0, likes: 0, reposts: 0, reach: 0 };
  const r = Number(post.replyCount ?? 0);
  const l = Number(post.likeCount ?? 0);
  const rp = Number(post.repostCount ?? 0);
  const reach = r + l + rp;
  return { replies: r, likes: l, reposts: rp, reach };
}
function renderCounts(c) {
  return `
    <div class="counts">
      <span class="c c-replies" title="Comments">💬 ${c.replies}</span>
      <span class="c c-likes"   title="Likes">❤️ ${c.likes}</span>
      <span class="c c-reposts" title="Reposts">🔁 ${c.reposts}</span>
    </div>
  `;
}

// Render a full post (author, time, text, embeds + counts)
function renderPostFull(p) {
  if (!p) return '';
  const a     = p.author || {};
  const rec   = p.record || {};
  const when  = fmtTime(rec.createdAt || p.indexedAt || '');
  const open  = atUriToWebPost(p.uri);
  const text  = esc(rec.text || '');

  const imgs  = extractImagesFromEmbed(p.embed);
  const vid   = extractVideoFromEmbed(p.embed);
  const ext   = extractExternalFromEmbed(p.embed);
  const links = linksFromFacets(rec);

  let embeds = '';
  if (imgs?.length) embeds = renderImagesGrid(imgs);
  else if (vid && (vid.thumb || vid.playlist)) embeds = renderVideoPoster(vid, open);
  else if (ext) {
    const ytId = getYouTubeId(ext.uri || '');
    embeds = ytId ? renderYouTubeCard(ytId) : renderExternalCard(ext);
  } else if (links.length) {
    const id = links.map(getYouTubeId).find(Boolean);
    embeds = id ? renderYouTubeCard(id) : renderExternalCard({ uri: links[0] });
  }

  const c = renderCounts(countsOf(p));

  return `
    <article class="post">
      <header class="meta">
        <img class="av" src="${esc(a.avatar||'')}" alt="" onerror="this.style.display='none'">
        <div class="who">
          <div class="name"><a target="_blank" rel="noopener" href="https://bsky.app/profile/${esc(a.did||'')}">${esc(a.displayName || a.handle || a.did || '')}</a></div>
          <div class="sub">@${esc(a.handle||'')} • ${esc(when)}</div>
        </div>
        ${open ? `<a class="open" target="_blank" rel="noopener" href="${esc(open)}">Open</a>` : ''}
      </header>
      ${text ? `<div class="text">${text}</div>` : ''}
      ${embeds ? `<div class="embeds">${embeds}</div>` : ''}
      ${c}
    </article>
  `;
}

// scan a thread subtree for keyword match (case-insensitive)
function nodeHasKeyword(node, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    const txt = String(n?.post?.record?.text || n?.record?.text || '').toLowerCase();
    if (txt.includes(needle)) return true;
    const kids = Array.isArray(n?.replies) ? n.replies : [];
    for (const k of kids) stack.push(k);
  }
  return false;
}

// Render a thread subtree recursively (with optional actions)
function renderThreadTree(node, depth=0, actionsHTMLFn=null) {
  if (!node) return '';
  const post = node.post || node;
  const indent = Math.min(depth, 6);
  const inner = renderPostFull(post) + (actionsHTMLFn ? actionsHTMLFn(post) : '');
  const children = Array.isArray(node.replies)
    ? node.replies.map(child => renderThreadTree(child, depth+1, actionsHTMLFn)).join('')
    : '';
  return `
    <div class="thread-node" style="--indent:${indent}">
      ${inner}
      ${children ? `<div class="thread-children">${children}</div>` : ''}
    </div>
  `;
}

class BskyInteractions extends HTMLElement {
  constructor(){
    super();
    this.attachShadow({mode:'open'});

    this.state = {
      open: false,
      uri: '',
      cid: '',
      loading: false,
      error: null,
      meDid: null,
      subject: null,
      parent: null,
      subjectThread: null,
      parentThread:  null,
      followMap: {},
      timeline: [],
      filters: new Set(['like','repost','reply']),
      // expand/collapse
      collapseAll: false,
      collapsedRows: new Set(),
      // inline composers open per post uri
      openComposers: new Set(),
      // other replies controls
      otherSort: 'chrono',      // 'chrono' | 'reach'
      otherHours: 24,           // 24, 72, 168, 720, 0(ALL)
      otherSearch: '',          // keyword
    };
  }

  static get observedAttributes(){ return ['uri','cid']; }
  attributeChangedCallback(name, _, v){
    if (name === 'uri') this.state.uri = v || '';
    if (name === 'cid') this.state.cid = v || '';
  }

  open(){
    this.state.open = true;
    this.render();
    this.loadAll();
  }

  close(){
    this.state.open = false;
    this.remove();
  }

  connectedCallback(){
    this.render();
    this.shadowRoot.addEventListener('click', (e) => this.onClick(e));
    this.shadowRoot.addEventListener('change', (e) => this.onChange(e));
    this.shadowRoot.addEventListener('input', (e) => this.onInput(e));
    this.shadowRoot.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
      const yt = e.target.closest?.('[data-yt-id]');
      if (yt && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        const id = yt.getAttribute('data-yt-id'); if (id) this.mountYouTubeIframe(yt, id);
      }
    });
  }

  // ---------- events ----------
  onInput(e){
    const ctrl = e.target?.getAttribute?.('data-ctrl');
    if (ctrl === 'search') {
      this.state.otherSearch = e.target.value || '';
      // targeted refresh (keeps focus/caret)
      this.updateOtherRepliesOnly(e.target);
    }
  }

  onChange(e){
    const f = e.target?.getAttribute?.('data-filter');
    if (f) {
      if (e.target.checked) this.state.filters.add(f);
      else this.state.filters.delete(f);
      this.render();
      return;
    }
    const ctrl = e.target?.getAttribute?.('data-ctrl');
    if (ctrl === 'sort') {
      this.state.otherSort = e.target.value === 'reach' ? 'reach' : 'chrono';
      this.updateOtherRepliesOnly(); // no full rerender
      return;
    }
    if (ctrl === 'hours') {
      const v = Number(e.target.value || 24);
      this.state.otherHours = Number.isFinite(v) ? v : 24;
      this.updateOtherRepliesOnly(); // no full rerender
      return;
    }
  }

  onClick(e){
    const overlay = e.target.closest('#overlay');
    if (overlay && e.target === overlay) { this.close(); return; }

    if (e.target.closest('#close')) { this.close(); return; }

    if (e.target.id === 'expand-all') { this.state.collapseAll = false; this.state.collapsedRows.clear(); this.render(); return; }
    if (e.target.id === 'collapse-all') { this.state.collapseAll = true; this.render(); return; }

    const toggle = e.target.closest('[data-toggle-row]');
    if (toggle) {
      const idx = parseInt(toggle.getAttribute('data-toggle-row') || '-1', 10);
      if (idx >= 0) {
        if (this.state.collapseAll) this.state.collapseAll = false;
        if (this.state.collapsedRows.has(idx)) this.state.collapsedRows.delete(idx);
        else this.state.collapsedRows.add(idx);
        this.render();
      }
      return;
    }

    // follow
    const followBtn = e.target.closest('[data-follow-did]');
    if (followBtn) { this.follow(followBtn.getAttribute('data-follow-did'), followBtn); return; }

    // per-post composer toggles / cancel / send
    const tgl = e.target.closest('[data-reply-toggle-uri]');
    if (tgl) {
      const u = tgl.getAttribute('data-reply-toggle-uri') || '';
      if (this.state.openComposers.has(u)) this.state.openComposers.delete(u);
      else this.state.openComposers.add(u);
      this.render();
      return;
    }
    const cancelBtn = e.target.closest('[data-reply-cancel-uri]');
    if (cancelBtn) {
      const u = cancelBtn.getAttribute('data-reply-cancel-uri') || '';
      this.state.openComposers.delete(u);
      this.render();
      return;
    }
    const sendBtn = e.target.closest('[data-reply-send-uri][data-reply-send-cid]');
    if (sendBtn) {
      const u = sendBtn.getAttribute('data-reply-send-uri') || '';
      const c = sendBtn.getAttribute('data-reply-send-cid') || '';
      const ta = this.shadowRoot.querySelector(`[data-reply-textarea-for="${CSS.escape(u)}"]`);
      const txt = (ta?.value || '').trim();
      if (!txt) return;
      this.submitReply(u, c, sendBtn, txt, ta).then(() => {
        this.state.openComposers.delete(u);
      });
      return;
    }

    // like / unlike / repost / unrepost
    const actBtn = e.target.closest('[data-action][data-uri]');
    if (actBtn) {
      const action = actBtn.getAttribute('data-action');
      const uri    = actBtn.getAttribute('data-uri') || '';
      const cid    = actBtn.getAttribute('data-cid') || '';
      const likeRec   = actBtn.getAttribute('data-like-rec') || '';
      const repostRec = actBtn.getAttribute('data-repost-rec') || '';
      if (action === 'like') this.toggleLike(uri, cid, true, null, actBtn);
      if (action === 'unlike') this.toggleLike(uri, cid, false, likeRec, actBtn);
      if (action === 'repost') this.toggleRepost(uri, cid, true, null, actBtn);
      if (action === 'unrepost') this.toggleRepost(uri, cid, false, repostRec, actBtn);
      return;
    }

    // legacy: reply button on timeline row (kept for convenience)
    const replyBtn = e.target.closest('[data-reply-uri][data-reply-cid]');
    if (replyBtn) {
      this.submitReply(replyBtn.getAttribute('data-reply-uri'), replyBtn.getAttribute('data-reply-cid'), replyBtn);
      return;
    }

    // quick reply to subject (separate box still works)
    if (e.target.id === 'reply-subject') {
      const ta = this.shadowRoot.getElementById('reply-subject-text');
      const txt = (ta?.value || '').trim();
      if (!txt) return;
      this.submitReply(this.state.uri, this.state.cid, e.target, txt, ta);
      return;
    }

    const yt = e.target.closest?.('[data-yt-id]');
    if (yt) {
      const id = yt.getAttribute('data-yt-id');
      if (id) this.mountYouTubeIframe(yt, id);
      return;
    }
  }

  // ---------- media ----------
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

  // ---------- data ----------
  async loadAll(){
    if (!this.state.uri || this.state.loading) return;
    this.state.loading = true; this.state.error = null; this.render();

    try {
      if (!this.state.meDid) {
        try {
          const me = await call('getProfile', {});
          this.state.meDid = me?.did || null;
          window.BSKY = window.BSKY || {};
          window.BSKY.meDid = this.state.meDid;
        } catch {}
      }

      const subject = await this.getOnePost(this.state.uri);
      this.state.subject = subject || null;

      const parentUri = subject?.record?.reply?.parent?.uri || null;
      this.state.parent = parentUri ? await this.getOnePost(parentUri) : null;

      const subjectThread = await this.getThread(subject?.uri);
      this.state.subjectThread = subjectThread;

      this.state.parentThread = parentUri ? await this.getThread(parentUri) : null;

      const [likesRes, repostsRes, threadRes] = await Promise.allSettled([
        call('getLikes', { uri: this.state.uri, limit: 100 }),
        call('getRepostedBy', { uri: this.state.uri, limit: 100 }),
        call('getPostThread', { uri: this.state.uri, depth: 5, parentHeight: 0 })
      ]);

      const likes = (likesRes.status === 'fulfilled' ? (likesRes.value?.likes || []) : [])
        .map(l => ({ type: 'like', ts: new Date(l.indexedAt || l.createdAt || 0), actor: l.actor || {}, replyPost: null }));

      const reposts = (repostsRes.status === 'fulfilled' ? (repostsRes.value?.repostedBy || []) : [])
        .map(r => ({ type: 'repost', ts: new Date(r.indexedAt || 0), actor: r || {}, replyPost: null }));

      let replies = [];
      if (threadRes.status === 'fulfilled') {
        const view = threadRes.value?.thread || threadRes.value?.view || threadRes.value;
        const stack = Array.isArray(view?.replies) ? [...view.replies] : [];
        while (stack.length) {
          const node = stack.shift();
          if (node?.post) {
            const p = node.post;
            replies.push({ type: 'reply', ts: new Date(p?.record?.createdAt || p?.indexedAt || 0), actor: p?.author || {}, replyPost: p });
          }
          if (Array.isArray(node?.replies)) stack.push(...node.replies);
        }
      }

      this.state.timeline = [...likes, ...reposts, ...replies].sort((a, b) => b.ts - a.ts);

      const dids = Array.from(new Set(this.state.timeline.map(x => x.actor?.did).filter(Boolean)));
      if (dids.length) {
        try {
          const rel = await call('getRelationships', { actors: dids });
          (rel.relationships || []).forEach(r => { this.state.followMap[r.did] = { following: !!r.following }; });
        } catch {}
      }

    } catch (e) {
      this.state.error = e.message;
    } finally {
      this.state.loading = false;
      this.render();
    }
  }

  async getOnePost(uri){
    if (!uri) return null;
    if (postCache.has(uri)) return postCache.get(uri);
    try {
      const res = await call('getPosts', { uris: [uri] });
      const p = (res?.posts || [])[0] || null;
      if (p) postCache.set(uri, p);
      return p;
    } catch { return null; }
  }

  async getThread(uri){
    if (!uri) return null;
    if (threadCache.has(uri)) return threadCache.get(uri);
    try {
      const res  = await call('getPostThread', { uri, depth: 10, parentHeight: 6 });
      const view = res?.thread || res?.view || res || null;
      if (view) threadCache.set(uri, view);
      return view;
    } catch { return null; }
  }

  async refreshOnePost(uri){
    try {
      const res = await call('getPosts', { uris: [uri] });
      const p = (res?.posts || [])[0] || null;
      if (!p) return;
      postCache.set(uri, p);
      // update subject/parent
      if (this.state.subject?.uri === uri) this.state.subject = p;
      if (this.state.parent?.uri === uri)  this.state.parent  = p;
      // update in subjectThread / parentThread / timeline
      const repl = (node) => {
        if (!node) return;
        if (node.post?.uri === uri) node.post = p;
        if (Array.isArray(node.replies)) node.replies.forEach(repl);
      };
      repl(this.state.subjectThread);
      repl(this.state.parentThread);
      this.state.timeline = this.state.timeline.map(it => it.type === 'reply' && it.replyPost?.uri === uri ? {...it, replyPost: p} : it);
    } catch {}
  }

  // ---------- actions ----------
  async follow(did, btn){
    if (!did) return;
    if (this.state.meDid && did === this.state.meDid) return;
    btn?.setAttribute('disabled','disabled');
    try {
      await call('follow', { did });
      this.state.followMap[did] = { following: true };
      btn.textContent = 'Following';
      btn.classList.add('following');
    } catch (e) {
      alert('Follow failed: ' + e.message);
      btn?.removeAttribute('disabled');
    }
  }

  async submitReply(parentUri, parentCid, btn, textOverride=null, textareaEl=null){
    let text = textOverride;
    if (text == null) {
      const box = btn?.closest('.reply-box')?.querySelector('textarea');
      text = (box?.value || '').trim();
      if (!text) return;
      textareaEl = box;
    }
    btn?.setAttribute('disabled','disabled');
    try {
      await call('createPost', {
        text,
        reply: { root: { uri: parentUri, cid: parentCid }, parent: { uri: parentUri, cid: parentCid } }
      });
      if (textareaEl) textareaEl.value = '';
      // refresh the related threads + the parent post quickly
      await Promise.all([
        this.refreshOnePost(parentUri),
        this.getThread(this.state.subject?.uri).then(v => this.state.subjectThread = v),
        this.state.parent?.uri ? this.getThread(this.state.parent.uri).then(v => this.state.parentThread = v) : null
      ]);
      this.render();
    } catch (e) {
      alert('Reply failed: ' + e.message);
    } finally {
      btn?.removeAttribute('disabled');
    }
  }

  async toggleLike(uri, cid, wantLike, likeRec=null, btn=null){
    try {
      btn?.setAttribute('disabled','disabled');
      if (wantLike) await call('like', { uri, cid });
      else          await call('deleteLike', { uri: likeRec || '' });
      await this.refreshOnePost(uri);
      this.render();
    } catch (e) {
      alert((wantLike?'Like':'Unlike') + ' failed: ' + e.message);
    } finally {
      btn?.removeAttribute('disabled');
    }
  }

  async toggleRepost(uri, cid, wantRepost, repostRec=null, btn=null){
    try {
      btn?.setAttribute('disabled','disabled');
      if (wantRepost) await call('repost', { uri, cid });
      else            await call('deleteRepost', { uri: repostRec || '' });
      await this.refreshOnePost(uri);
      this.render();
    } catch (e) {
      alert((wantRepost?'Repost':'Unrepost') + ' failed: ' + e.message);
    } finally {
      btn?.removeAttribute('disabled');
    }
  }

  // ---------- rendering ----------
  labelFor(item){
    const who = item.actor?.displayName || item.actor?.handle || item.actor?.did || 'Someone';
    switch (item.type) {
      case 'like':   return `${who} liked your post`;
      case 'repost': return `${who} reposted your post`;
      case 'reply':  return `${who} replied`;
      default:       return `${who}`;
    }
  }

  // per-post actions (reply/like/repost + inline composer)
  renderActions(p){
    const uri = p?.uri || '';
    const cid = p?.cid || '';
    const viewer = p?.viewer || {};
    const liked = !!viewer?.like;
    const reposted = !!viewer?.repost;
    const likeRec = viewer?.like || '';
    const repostRec = viewer?.repost || '';
    return `
      <div class="actions">
        <button class="act-btn" data-reply-toggle-uri="${esc(uri)}">Reply</button>
        <button class="act-btn" data-action="${liked?'unlike':'like'}" data-uri="${esc(uri)}" data-cid="${esc(cid)}" ${likeRec?`data-like-rec="${esc(likeRec)}"`:''}>
          ${liked ? 'Liked ❤️' : 'Like'}
        </button>
        <button class="act-btn" data-action="${reposted?'unrepost':'repost'}" data-uri="${esc(uri)}" data-cid="${esc(cid)}" ${reposted?`data-repost-rec="${esc(repostRec)}"`:''}>
          ${reposted ? 'Reposted 🔁' : 'Repost'}
        </button>
        <a class="open small" target="_blank" rel="noopener" href="${esc(atUriToWebPost(uri))}">Open</a>
      </div>
      ${this.state.openComposers.has(uri) ? `
        <div class="reply-box inline">
          <textarea data-reply-textarea-for="${esc(uri)}" placeholder="Write a reply…"></textarea>
          <div style="margin-top:8px">
            <button data-reply-send-uri="${esc(uri)}" data-reply-send-cid="${esc(cid)}">Reply</button>
            <button data-reply-cancel-uri="${esc(uri)}">Cancel</button>
          </div>
        </div>
      ` : ''}
    `;
  }

  // other replies list (filters: sort, hours, search; mine pinned)
  buildOtherRepliesHTML(parentThread, subject, meDid){
    if (!parentThread) return '';

    const now = Date.now();
    const cutoff = this.state.otherHours > 0 ? (now - this.state.otherHours*3600*1000) : 0;
    const search = (this.state.otherSearch || '').trim();

    let children = Array.isArray(parentThread.replies) ? parentThread.replies.slice() : [];
    children = children.filter(n => (n?.post?.uri || '') !== (subject?.uri || ''));

    if (cutoff) {
      children = children.filter(n => {
        const iso = n?.post?.record?.createdAt || n?.post?.indexedAt || '';
        const ts = new Date(iso).getTime();
        return !Number.isNaN(ts) && ts >= cutoff;
      });
    }

    const parentMatches = nodeHasKeyword(parentThread, search);
    if (search && !parentMatches) {
      children = children.filter(n => nodeHasKeyword(n, search));
    }

    const withMeta = children.map(n => {
      const p = n?.post || {};
      const c = countsOf(p);
      return { node: n, post: p, reach: c.reach, time: new Date(p?.record?.createdAt || p?.indexedAt || 0).getTime() || 0 };
    });

    const mine   = withMeta.filter(x => (x.post?.author?.did || '') === (meDid || ''));
    const others = withMeta.filter(x => (x.post?.author?.did || '') !== (meDid || ''));

    const sortFn = (a,b) => {
      if (this.state.otherSort === 'reach') return (b.reach - a.reach) || (b.time - a.time);
      return (b.time - a.time) || (b.reach - a.reach);
    };

    mine.sort(sortFn);
    others.sort(sortFn);
    const ordered = [...mine, ...others].map(x => x.node);

    const list = ordered.map(n => renderThreadTree(n, 1, this.renderActions.bind(this))).join('');
    return `
      <div class="sub-controls">
        <div class="left">
          <label>Sort
            <select data-ctrl="sort" value="${esc(this.state.otherSort)}">
              <option value="chrono" ${this.state.otherSort==='chrono'?'selected':''}>Chronological</option>
              <option value="reach"  ${this.state.otherSort==='reach' ?'selected':''}>Reach</option>
            </select>
          </label>
          <label>Range
            <select data-ctrl="hours">
              <option value="24"  ${this.state.otherHours===24?'selected':''}>Last 24h</option>
              <option value="72"  ${this.state.otherHours===72?'selected':''}>Last 3 days</option>
              <option value="168" ${this.state.otherHours===168?'selected':''}>Last 7 days</option>
              <option value="720" ${this.state.otherHours===720?'selected':''}>Last 30 days</option>
              <option value="0"   ${this.state.otherHours===0?'selected':''}>All</option>
            </select>
          </label>
        </div>
        <div class="right">
          <input data-ctrl="search" type="search" placeholder="Search keyword…" value="${esc(this.state.otherSearch)}">
        </div>
      </div>
      ${list || '<div class="muted">No matching replies in this range.</div>'}
    `;
  }

  // details block: In reply to → Your post → Conversation → Other replies
  buildDetailsHTML(){
    const subject  = this.state.subject;
    const parent   = this.state.parent;
    const sThread  = this.state.subjectThread;
    const pThread  = this.state.parentThread;

    const parentBlock  = (parent ? renderPostFull(parent) : '<div class="muted">No parent post.</div>') + (parent ? this.renderActions(parent) : '');
    const subjectBlock = (renderPostFull(subject) || '<div class="muted">Unavailable</div>') + this.renderActions(subject);

    const yourReplyBox = (subject?.uri && subject?.cid) ? `
      <div class="reply-box">
        <textarea id="reply-subject-text" placeholder="Write a reply…"></textarea>
        <div style="margin-top:8px"><button id="reply-subject">Reply</button></div>
      </div>
    ` : '';

    const fullTree = sThread ? `
      <div class="ctx-title">Conversation</div>
      ${renderThreadTree(sThread, 0, this.renderActions.bind(this))}
    ` : '';

    const others = this.buildOtherRepliesHTML(pThread, subject, this.state.meDid);

    return `
      <div class="details">
        <div class="ctx">
          <div class="ctx-title">In reply to</div>
          ${parentBlock}
        </div>

        <div class="ctx">
          <div class="ctx-title">Your post</div>
          ${subjectBlock}
          ${yourReplyBox}
        </div>

        <div class="ctx">
          ${fullTree}
        </div>

        <!-- stable id so we can refresh just this chunk -->
        <div class="ctx" id="other-replies">
          <div class="ctx-title">Other replies to that post</div>
          ${others}
        </div>
      </div>
    `;
  }

  // 🔧 targeted refresh for "Other replies" with focus/caret preservation
  updateOtherRepliesOnly(focusedEl=null){
    const wrap = this.shadowRoot.getElementById('other-replies');
    if (!wrap) { this.render(); return; } // fallback if not mounted

    // capture caret if the focused element is our search input
    let selStart = null, selEnd = null, shouldRestore = false;
    if (focusedEl && focusedEl.getAttribute?.('data-ctrl') === 'search') {
      shouldRestore = true;
      try {
        selStart = focusedEl.selectionStart;
        selEnd   = focusedEl.selectionEnd;
      } catch {}
    }

    const others = this.buildOtherRepliesHTML(this.state.parentThread, this.state.subject, this.state.meDid);
    // Rebuild only the internals of the section
    wrap.innerHTML = `
      <div class="ctx-title">Other replies to that post</div>
      ${others}
    `;

    // restore focus & caret to the new input
    if (shouldRestore) {
      const input = this.shadowRoot.querySelector('[data-ctrl="search"]');
      if (input) {
        input.focus();
        try { if (selStart != null && selEnd != null) input.setSelectionRange(selStart, selEnd); } catch {}
      }
    }
  }

  render(){
    if (!this.state.open) { this.shadowRoot.innerHTML = ''; return; }

    // preserve scroll (avoid jumping to top)
    const prevModal = this.shadowRoot.querySelector('.modal');
    const prevY = prevModal ? prevModal.scrollTop : 0;

    // preserve search focus/caret if we end up doing a full rerender
    const ae = this.shadowRoot.activeElement;
    const wasOnSearch = !!ae && ae.getAttribute?.('data-ctrl') === 'search';
    let sStart=null, sEnd=null;
    if (wasOnSearch) { try { sStart = ae.selectionStart; sEnd = ae.selectionEnd; } catch {} }

    const visible = this.state.timeline.filter(x => this.state.filters.has(x.type));
    const detailsHTML = this.buildDetailsHTML();

    const subjCountsHtml = renderCounts(countsOf(this.state.subject));

    const rows = visible.map((it, i) => {
      const t   = fmtTime(it.ts?.toISOString?.() || it.ts || '');
      const txt = it.type === 'reply' ? esc(it.replyPost?.record?.text || '') : '';

      const collapsed = this.state.collapseAll || this.state.collapsedRows.has(i);
      const countsHtml = it.type === 'reply' ? renderCounts(countsOf(it.replyPost || {})) : subjCountsHtml;

      // actions for reply rows (like/repost/reply directly)
      const actionsHtml = it.type === 'reply' ? this.renderActions(it.replyPost || {}) : '';

      return `
        <div class="row" data-row="${i}" data-collapsed="${collapsed ? 'true' : 'false'}">
          <div class="meta">
            <div class="line">
              <span class="badge ${esc(it.type)}">${esc(it.type)}</span>
              <span class="lbl">${esc(this.labelFor(it))}</span>
              <span class="time">${esc(t)}</span>
            </div>
            ${countsHtml}
            ${txt ? `<div class="reply-text">${txt}</div>` : ''}
            ${actionsHtml}
          </div>
          <div class="act">
            <button class="toggle-btn" data-toggle-row="${i}">${collapsed ? 'Show' : 'Hide'}</button>
          </div>
          ${detailsHTML}
        </div>
      `;
    }).join('');

    this.shadowRoot.innerHTML = `
      <style>
        :host{ all: initial; }
        #overlay{ position:fixed; inset:0; background:rgba(0,0,0,.6); display:flex; align-items:center; justify-content:center; z-index:999999; }
        .modal{ background:#0b0b0b; color:#fff; border:1px solid #444; border-radius:12px; width:min(1100px, 96vw); max-height:92vh; overflow:auto; box-shadow:0 10px 40px rgba(0,0,0,.6); }
        .head{ display:flex; align-items:center; justify-content:space-between; padding:12px 14px; border-bottom:1px solid #333; position:sticky; top:0; background:#0b0b0b; }
        .title{ font-weight:700 }
        #close{ background:#111; border:1px solid #555; color:#fff; padding:6px 10px; border-radius:8px; cursor:pointer }
        .body{ padding:12px 14px; }
        .muted{ color:#aaa; }
        .err{ color:#f88; margin-bottom:10px; }

        .controls{ display:flex; gap:12px; align-items:center; justify-content:space-between; margin:10px 0 12px; }
        .filters{ display:flex; gap:12px; align-items:center; color:#ddd }
        .bulk button{ background:#111; border:1px solid #555; color:#fff; padding:6px 10px; border-radius:8px; cursor:pointer }

        .row{ display:flex; flex-direction:column; gap:8px; border:1px solid #333; border-radius:10px; padding:10px; margin:10px 0; background:#0f0f0f }

        .meta{ display:flex; gap:10px; align-items:flex-start; flex-direction:column }
        .line{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; width:100% }
        .badge{ text-transform:capitalize; font-size:.85rem; border:1px solid #444; background:#111; border-radius:999px; padding:1px 8px; }
        .badge.like{   border-color:#4a7; }
        .badge.repost{ border-color:#7a7; }
        .badge.reply{  border-color:#77a; }
        .time{ color:#bbb; margin-left:auto; font-size:.9rem }
        .reply-text{ white-space:pre-wrap; line-height:1.35 }

        .act{ display:flex; gap:8px; align-items:center; justify-content:flex-end }
        .toggle-btn{ background:#111; border:1px solid #555; color:#fff; padding:6px 10px; border-radius:8px; cursor:pointer }

        /* counts */
        .counts{ display:flex; gap:10px; color:#ddd; font-size:.95rem }
        .counts .c{ display:inline-flex; gap:6px; align-items:center; padding:2px 8px; border:1px solid #333; border-radius:999px; background:#0b0b0b }

        /* actions */
        .actions{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:6px }
        .act-btn{ background:#111; border:1px solid #555; color:#fff; padding:6px 10px; border-radius:8px; cursor:pointer }
        .open.small{ color:#9cd3ff; margin-left:4px }

        /* details visibility */
        .row[data-collapsed="true"] > .details{ display:none; }

        /* details / context blocks */
        .details{ border-top:1px dashed #333; padding-top:8px }
        .ctx{ border:1px solid #333; border-radius:10px; padding:10px; background:#0f0f0f }
        .ctx + .ctx{ margin-top:10px }
        .ctx-title{ color:#bbb; font-size:.95rem; margin:4px 0 10px; font-weight:600 }

        /* sub-controls inside "Other replies" */
        .sub-controls{ display:flex; gap:12px; align-items:center; justify-content:space-between; margin:0 0 8px; }
        .sub-controls label{ color:#ddd; display:inline-flex; gap:6px; align-items:center }
        .sub-controls select, .sub-controls input[type="search"]{
          background:#0e0e0e; color:#fff; border:1px solid #444; border-radius:8px; padding:6px 8px;
        }

        /* post block */
        .post{ border:1px solid #333; border-radius:10px; padding:10px; background:#0b0b0b; }
        .post + .post{ margin-top:8px }
        .post .meta{ display:flex; align-items:center; gap:10px; flex-direction:row }
        .post .meta .who{ flex:1 1 auto; min-width:0 }
        .post .meta .open{ color:#9cd3ff; margin-left:auto }
        .post .av{ width:32px; height:32px; border-radius:50%; background:#222; object-fit:cover }
        .post .text{ white-space:pre-wrap; line-height:1.35; margin-top:6px }

        /* embeds */
        .embeds{ margin-top:8px }
        .ext-card{ display:block; border:1px solid #333; border-radius:10px; overflow:hidden; background:#0f0f0f; width:100%; }
        .ext-card.link{ text-decoration:none; color:#fff; display:flex; gap:0; }
        .ext-card .thumb{ position:relative; width:40%; min-width:140px; background:#111; }
        .ext-card .thumb-img{ width:100%; height:100%; object-fit:cover; display:block }
        .ext-card .meta{ padding:10px; display:flex; flex-direction:column; gap:6px; width:60%; }
        .ext-card .title{ font-weight:700; line-height:1.2 }
        .ext-card .desc{ color:#ccc; font-size:.95rem; line-height:1.3; max-height:3.2em; overflow:hidden }

        .images-grid{ display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:6px; width:100%; }
        .img-wrap{ margin:0; padding:0; background:#111; border-radius:8px; overflow:hidden }
        .img-wrap img{ display:block; width:100%; height:100%; object-fit:cover }

        .ext-card.yt{ cursor:pointer; }
        .ext-card.yt .thumb{ aspect-ratio: 16 / 9; width:100%; background:#111; }
        .ext-card.yt .thumb img{ width:100%; height:100%; object-fit:cover; display:block }
        .ext-card.yt .play{
          position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
          background:rgba(0,0,0,.55); border:2px solid #fff; border-radius:9999px; padding:8px 14px; font-weight:700;
        }
        .ext-card.yt.iframe .yt-16x9{ position:relative; width:100%; }
        .ext-card.yt.iframe .yt-16x9::before{ content:""; display:block; padding-top:56.25%; }
        .ext-card.yt.iframe iframe{ position:absolute; inset:0; width:100%; height:100%; border:0; }

        .ext-card.video{ text-decoration:none; color:#fff; display:flex; gap:0; }
        .ext-card.video .thumb{ position:relative; width:40%; min-width:140px; background:#111; display:flex; align-items:center; justify-content:center }
        .ext-card.video .thumb img{ width:100%; height:100%; object-fit:cover; display:block }
        .ext-card.video .play{
          position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
          background:rgba(0,0,0,.55); border:2px solid #fff; border-radius:9999px; padding:8px 14px; font-weight:700;
        }

        /* thread tree */
        .thread-node{ margin-top:8px; }
        .thread-node .post{ margin-left: calc(var(--indent, 0) * 12px); }
        .thread-children{ margin-left: 12px; }

        /* reply box inside details */
        .reply-box textarea{ width:100%; min-height:80px; background:#0e0e0e; color:#fff; border:1px solid #444; border-radius:8px; padding:8px; margin-top:6px }
        .reply-box button{ background:#111; border:1px solid #555; color:#fff; padding:6px 10px; border-radius:8px; cursor:pointer }
      </style>

      <div id="overlay">
        <div class="modal" role="dialog" aria-modal="true">
          <div class="head">
            <div class="title">Interactions</div>
            <button id="close">✕</button>
          </div>
          <div class="body">
            ${this.state.loading ? '<div class="muted">Loading…</div>' : '' }
            ${this.state.error ? `<div class="err">Error: ${esc(this.state.error)}</div>` : '' }

            <div class="controls">
              <div class="filters">
                <label class="f"><input type="checkbox" data-filter="like"   ${this.state.filters.has('like')?'checked':''}> Likes</label>
                <label class="f"><input type="checkbox" data-filter="repost" ${this.state.filters.has('repost')?'checked':''}> Reposts</label>
                <label class="f"><input type="checkbox" data-filter="reply"  ${this.state.filters.has('reply')?'checked':''}> Replies</label>
              </div>
              <div class="bulk">
                <button id="expand-all">Expand all</button>
                <button id="collapse-all">Collapse all</button>
              </div>
            </div>

            ${(!this.state.loading && !visible.length) ? '<div class="muted">No activity yet.</div>' : ''}
            ${rows}
          </div>
        </div>
      </div>
    `;

    // restore scroll
    const newModal = this.shadowRoot.querySelector('.modal');
    if (newModal && Number.isFinite(prevY)) newModal.scrollTop = prevY;

    // restore search focus/caret if we did a full rerender while typing
    if (wasOnSearch) {
      const input = this.shadowRoot.querySelector('[data-ctrl="search"]');
      if (input) {
        input.focus();
        try { if (sStart != null && sEnd != null) input.setSelectionRange(sStart, sEnd); } catch {}
      }
    }
  }
}

customElements.define('bsky-interactions', BskyInteractions);
