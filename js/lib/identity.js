// Shared identity rendering (displayName + handle links + copy-DID)

const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));

export function normalizeHandle(handle) {
  const h = String(handle || '').trim();
  return h.replace(/^@+/, '');
}

export function toProfileUrl({ handle, did } = {}) {
  const h = normalizeHandle(handle);
  const id = h || String(did || '').trim();
  return id ? `https://bsky.app/profile/${encodeURIComponent(id)}` : '#';
}

export async function copyToClipboard(text) {
  const value = String(text || '');
  if (!value) return false;

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fallback below
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch {
    return false;
  }
}

export function bindCopyClicks(root, { toast = true } = {}) {
  if (!root || root.__bskyCopyBound) return;
  root.__bskyCopyBound = true;

  root.addEventListener('click', async (e) => {
    const el = e.target?.closest?.('[data-copy-text]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();

    const text = el.getAttribute('data-copy-text') || '';
    const ok = await copyToClipboard(text);

    if (!toast) return;
    try {
      el.setAttribute('data-copied', ok ? '1' : '0');
      clearTimeout(el.__bskyCopyT);
      el.__bskyCopyT = setTimeout(() => {
        try { el.removeAttribute('data-copied'); } catch {}
      }, 900);
    } catch {}
  });
}

/**
 * Renders displayName + handle as profile links, plus a copy button for DID.
 *
 * - If displayName exists: show it as the primary link.
 * - Always show handle (if available) as a secondary link.
 * - Never display the DID as main text (only via copy button + optional title).
 */
export function identityHtml(actor, { showHandle = true, showCopyDid = true } = {}) {
  const did = actor?.did ? String(actor.did) : '';
  const handle = normalizeHandle(actor?.handle);
  const displayName = actor?.displayName ? String(actor.displayName) : '';

  const url = toProfileUrl({ handle, did });

  const nameText = displayName || (handle ? `@${handle}` : '') || '';
  const handleText = handle ? `@${handle}` : '';

  const namePart = nameText
    ? `<a class="bsky-id-name" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(nameText)}</a>`
    : '';

  const handlePart = (showHandle && handleText && (displayName || showHandle))
    ? `<a class="bsky-id-handle" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(handleText)}</a>`
    : '';

  const copyPart = (showCopyDid && did)
    ? `<button class="bsky-id-copy" type="button" title="Copy DID" data-copy-text="${esc(did)}" aria-label="Copy DID">⧉</button>`
    : '';

  const title = did ? ` title="${esc(did)}"` : '';

  return `<span class="bsky-id"${title}>${namePart}${handlePart}${copyPart}</span>`;
}

export const identityCss = `
  .bsky-id{display:inline-flex;align-items:center;gap:8px;min-width:0}
  .bsky-id-name{color:#fff;text-decoration:underline;font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bsky-id-handle{color:#bbb;text-decoration:underline;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bsky-id-copy{appearance:none;border:1px solid rgba(255,255,255,.18);background:transparent;color:#ddd;border-radius: var(--bsky-radius, 0px);padding:2px 6px;cursor:pointer;line-height:1}
  .bsky-id-copy:hover{background:rgba(255,255,255,.06)}
  .bsky-id-copy[data-copied="1"]{border-color:#2e5a3a;color:#89f0a2}
  .bsky-id-copy[data-copied="0"]{border-color:#7a2f2f;color:#f0a2a2}
`;
