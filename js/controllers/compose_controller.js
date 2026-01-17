import { call } from '../api.js';
import { extractMentionHandles, extractUrls, buildFacets } from '../lib/richtext_facets.js';

export function defaultLangs() {
  try {
    const langs = Array.isArray(navigator?.languages) && navigator.languages.length
      ? navigator.languages
      : (navigator?.language ? [navigator.language] : []);
    return langs.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 3);
  } catch {
    return [];
  }
}

export async function resolveMentionDidsFromTexts(texts = []) {
  try {
    const arr = Array.isArray(texts) ? texts : [texts];
    const allHandles = Array.from(new Set(arr.flatMap((t) => extractMentionHandles(String(t || '')))));
    if (!allHandles.length) return {};
    const r = await call('resolveHandles', { handles: allHandles });
    const dids = r?.dids || {};
    return (dids && typeof dids === 'object') ? dids : {};
  } catch {
    return {};
  }
}

export function buildFacetsSafe(text, didByHandle = {}) {
  try {
    const facets = buildFacets(String(text || ''), didByHandle || {});
    return (Array.isArray(facets) && facets.length) ? facets : null;
  } catch {
    return null;
  }
}

export async function buildFacetsWithAutoResolve(text) {
  const txt = String(text || '');
  const didByHandle = await resolveMentionDidsFromTexts([txt]);
  return buildFacetsSafe(txt, didByHandle);
}

export async function uploadImagesToEmbed(images) {
  const uploaded = [];
  try {
    const list = Array.isArray(images) ? images : [];
    for (const img of list) {
      const mime = String(img?.mime || '');
      const dataBase64 = String(img?.dataBase64 || '');
      if (!mime || !dataBase64) continue;
      const res = await call('uploadBlob', { mime, dataBase64 });
      const blob = res?.blob || res?.data?.blob || res?.data || null;
      if (blob) uploaded.push({ alt: String(img?.alt || ''), image: blob });
    }
  } catch {
    // ignore
  }
  return uploaded.length ? { $type: 'app.bsky.embed.images', images: uploaded } : null;
}

export async function unfurlEmbedFromText(text, { thumb = true } = {}) {
  try {
    const urls = extractUrls(String(text || ''));
    if (!urls.length) return null;
    const url = String(urls[0] || '').trim();
    if (!url) return null;
    const out = await call('unfurlUrl', { url, thumb: !!thumb });
    const embed = out?.embed || null;
    return (embed && typeof embed === 'object') ? embed : null;
  } catch {
    return null;
  }
}

export function buildQuoteEmbed({ quote, mediaEmbed }) {
  const uri = String(quote?.uri || '').trim();
  if (!uri) return null;
  const cid = String(quote?.cid || '').trim();
  const ref = { uri, cid };

  if (mediaEmbed) {
    return {
      $type: 'app.bsky.embed.recordWithMedia',
      record: { $type: 'app.bsky.embed.record', record: ref },
      media: mediaEmbed,
    };
  }

  return { $type: 'app.bsky.embed.record', record: ref };
}

export async function selectEmbed({ text, images, quote }) {
  const mediaEmbed = await uploadImagesToEmbed(images);
  if (quote?.uri) return buildQuoteEmbed({ quote, mediaEmbed });
  if (mediaEmbed) return mediaEmbed;
  return await unfurlEmbedFromText(text);
}

export async function applyInteractionGates(createdUri, interactions, { isRootPost = false } = {}) {
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
