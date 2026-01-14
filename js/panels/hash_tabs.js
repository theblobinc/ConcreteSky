export function getHashTabs() {
  const h = String(window.location.hash || '');
  const m = h.match(/tabs=([^&]+)/i);
  if (!m) return null;
  const raw = decodeURIComponent(m[1] || '');
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

export function setHashTabs(tabs) {
  const url = new URL(window.location.href);
  url.hash = `tabs=${encodeURIComponent(tabs.join(','))}`;
  // avoid adding to history for every click
  window.history.replaceState(null, '', url.toString());
}
