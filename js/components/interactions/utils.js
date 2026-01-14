// application/single_pages/bluesky_feed/js/components/interactions/utils.js
import { identityHtml } from '../../lib/identity.js';

export const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) =>
  ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[m])
);
export const fmtTime = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return ''; } };
export const safeHost = (url) => { try { return new URL(url).host; } catch { return ''; } };

export function countsOf(post) {
  if (!post) return { replies: 0, likes: 0, reposts: 0, reach: 0 };
  const r = Number(post.replyCount ?? 0);
  const l = Number(post.likeCount ?? 0);
  const rp = Number(post.repostCount ?? 0);
  return { replies: r, likes: l, reposts: rp, reach: r + l + rp };
}

export function renderCountsClickable(c){
  // add data-open-engagement attributes so the modal can listen
  return `
    <div class="counts">
      <button class="c c-replies" data-open-engagement="replies"  title="Comments">💬 ${c.replies}</button>
      <button class="c c-likes"   data-open-engagement="likes"    title="Likes">❤️ ${c.likes}</button>
      <button class="c c-reposts" data-open-engagement="reposts"  title="Reposts">🔁 ${c.reposts}</button>
    </div>
  `;
}

export function atUriToWebPost(uri){
  const m = String(uri || '').match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)/);
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : '';
}

// ---- minimal embed helpers for post card ----
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
function extractImagesFromEmbed(embed) {
  if (!embed) return null;
  const t = String(embed.$type || '');
  if (t.includes('embed.images') && Array.isArray(embed.images) && embed.images.length) {
    return embed.images.map(img => ({ src: img.fullsize || img.thumb || '', alt: img.alt || '' })).filter(i => i.src);
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
function renderImagesGrid(images) {
  const items = images.map(i => `
    <figure class="img-wrap">
      <img loading="lazy" src="${esc(i.src)}" alt="${esc(i.alt)}">
    </figure>
  `).join('');
  return `<div class="images-grid">${items}</div>`;
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

export function renderPostCard(p){
  if (!p) return '';
  const a   = p.author || {};
  const rec = p.record || {};
  const when = fmtTime(rec.createdAt || p.indexedAt || '');
  const open = atUriToWebPost(p.uri);
  const text = esc(rec.text || '');

  const imgs  = extractImagesFromEmbed(p.embed);
  const vid   = extractVideoFromEmbed(p.embed);
  const ext   = extractExternalFromEmbed(p.embed);
  const links = linksFromFacets(rec);

  let embeds = '';
  if (imgs?.length) embeds = renderImagesGrid(imgs);
  else if (vid && (vid.thumb || vid.playlist)) embeds = renderVideoPoster(vid, open);
  else if (ext) {
    const ytId = getYouTubeId(ext.uri || '');
    embeds = ytId ? '' /* yt thumb omitted in compact card */ : renderExternalCard(ext);
  } else if (links.length) {
    const id = links.map(getYouTubeId).find(Boolean);
    embeds = id ? '' : renderExternalCard({ uri: links[0] });
  }

  return `
    <article class="post">
      <header class="meta">
        <img class="av" src="${esc(a.avatar||'')}" alt="" onerror="this.style.display='none'">
        <div class="who">
          <div class="name">${identityHtml({ did: a.did, handle: a.handle, displayName: a.displayName }, { showHandle: true, showCopyDid: true })}</div>
          <div class="sub">@${esc(a.handle||'')} • ${esc(when)}</div>
        </div>
        ${open ? `<a class="open" target="_blank" rel="noopener" href="${esc(open)}">Open</a>` : ''}
      </header>
      ${text ? `<div class="text">${text}</div>` : ''}
      ${embeds ? `<div class="embeds">${embeds}</div>` : ''}
    </article>
  `;
}
