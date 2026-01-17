// Richtext facet builder for Bluesky posts.
// Detects URLs, @mentions, and #hashtags and produces `app.bsky.richtext.facet` records
// with UTF-8 byte indices.

const encoder = new TextEncoder();

function buildByteMap(text) {
  const map = new Array(text.length + 1);
  let byteOffset = 0;
  let i = 0;
  while (i < text.length) {
    map[i] = byteOffset;
    const cp = text.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const b = encoder.encode(ch).length;
    byteOffset += b;
    i += ch.length; // 1 for BMP, 2 for surrogate pair
  }
  map[text.length] = byteOffset;
  return map;
}

function isWordChar(ch) {
  return /[A-Za-z0-9_]/.test(ch);
}

function pushIfNoOverlap(out, item) {
  for (const e of out) {
    if (item.start < e.end && item.end > e.start) return;
  }
  out.push(item);
}

function collectEntities(text) {
  const entities = [];
  const s = String(text || '');

  // URLs (basic; prefers http/https)
  // Stop at whitespace or common trailing punctuation.
  const urlRe = /https?:\/\/[^\s<>()]+/gi;
  for (const m of s.matchAll(urlRe)) {
    const raw = String(m[0] || '');
    const start = m.index ?? -1;
    if (start < 0) continue;
    let end = start + raw.length;

    // trim trailing punctuation that isn't usually part of the URL
    while (end > start && /[\]\[\)\(\.,!?:;"'”’]+$/.test(s.slice(start, end))) {
      end -= 1;
    }
    const uri = s.slice(start, end);
    if (!uri) continue;
    pushIfNoOverlap(entities, { type: 'link', start, end, uri });
  }

  // Mentions (@handle.tld)
  // Avoid emails by requiring boundary before '@'.
  const mentionRe = /@([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z0-9.-]+)/g;
  for (const m of s.matchAll(mentionRe)) {
    const handle = String(m[1] || '');
    const at = m.index ?? -1;
    if (at < 0) continue;

    const prev = at > 0 ? s[at - 1] : '';
    if (prev && isWordChar(prev)) continue;

    const start = at;
    const end = at + String(m[0] || '').length;
    pushIfNoOverlap(entities, { type: 'mention', start, end, handle });
  }

  // Hashtags (#tag)
  const tagRe = /#([A-Za-z][A-Za-z0-9_]{0,63})/g;
  for (const m of s.matchAll(tagRe)) {
    const tag = String(m[1] || '');
    const hash = m.index ?? -1;
    if (hash < 0) continue;

    const prev = hash > 0 ? s[hash - 1] : '';
    if (prev && isWordChar(prev)) continue;

    const start = hash;
    const end = hash + String(m[0] || '').length;
    pushIfNoOverlap(entities, { type: 'tag', start, end, tag });
  }

  entities.sort((a, b) => a.start - b.start || a.end - b.end);
  return entities;
}

export function extractMentionHandles(text) {
  const ents = collectEntities(text).filter((e) => e.type === 'mention');
  return Array.from(new Set(ents.map((e) => e.handle)));
}

export function extractUrls(text) {
  const ents = collectEntities(text).filter((e) => e.type === 'link');
  return Array.from(new Set(ents.map((e) => e.uri)));
}

export function buildFacets(text, didByHandle = {}) {
  const s = String(text || '');
  if (!s) return null;

  const entities = collectEntities(s);
  if (!entities.length) return null;

  const byteMap = buildByteMap(s);
  const facets = [];

  for (const e of entities) {
    const byteStart = byteMap[e.start] ?? 0;
    const byteEnd = byteMap[e.end] ?? byteStart;

    if (e.type === 'link') {
      facets.push({
        index: { byteStart, byteEnd },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: e.uri }],
      });
      continue;
    }

    if (e.type === 'mention') {
      const did = didByHandle?.[e.handle] || didByHandle?.[String(e.handle).toLowerCase()];
      if (!did) continue;
      facets.push({
        index: { byteStart, byteEnd },
        features: [{ $type: 'app.bsky.richtext.facet#mention', did: String(did) }],
      });
      continue;
    }

    if (e.type === 'tag') {
      facets.push({
        index: { byteStart, byteEnd },
        features: [{ $type: 'app.bsky.richtext.facet#tag', tag: e.tag }],
      });
      continue;
    }
  }

  return facets.length ? facets : null;
}
