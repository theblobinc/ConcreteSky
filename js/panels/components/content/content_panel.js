import { call } from '../../../api.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));

// Convert at://did/app.bsky.feed.post/rkey → https://bsky.app/profile/did/post/rkey
const atUriToWebPost = (uri) => {
  const m = String(uri || '').match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)/);
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : '';
};

export class BskyContentPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this._selection = null; // { uri, cid }
    this._loading = false;
    this._error = null;
    this._thread = null; // getPostThread().thread
    this._replyTo = null; // { uri, author }
  }

  setSelection(sel) {
    const uri = String(sel?.uri || '');
    const cid = String(sel?.cid || '');
    this._selection = uri ? { uri, cid } : null;
    this._replyTo = null;
    this._thread = null;
    this._error = null;
    this.render();
    if (this._selection) this.load();
  }

  connectedCallback() {
    this.render();
    this.shadowRoot.addEventListener('click', (e) => this.onClick(e));
    this.shadowRoot.addEventListener('bsky-reply-to', (e) => {
      const d = e?.detail || null;
      this._replyTo = d?.uri ? { uri: String(d.uri), author: String(d.author || '') } : null;
      const composer = this.shadowRoot.querySelector('bsky-comment-composer');
      composer?.setReplyTo?.(this._replyTo);
    });
    this.shadowRoot.addEventListener('bsky-submit-comment', (e) => {
      // Scaffold only; we don't have a write endpoint yet.
      const text = String(e?.detail?.text || '').trim();
      if (!text) return;
      alert('Reply posting is not wired yet.');
    });
  }

  onClick(e) {
    if (e.target?.closest?.('[data-close]')) {
      this.dispatchEvent(new CustomEvent('bsky-close-content', { bubbles: true, composed: true }));
      return;
    }
  }

  async load() {
    if (!this._selection?.uri || this._loading) return;
    this._loading = true;
    this._error = null;
    this.render();

    try {
      const out = await call('getPostThread', { uri: this._selection.uri, depth: 10, parentHeight: 6 });
      this._thread = out?.thread || null;
    } catch (e) {
      this._error = e?.message || String(e || 'Failed to load thread');
      this._thread = null;
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    const uri = this._selection?.uri || '';
    const open = uri ? atUriToWebPost(uri) : '';

    this.shadowRoot.innerHTML = `
      <style>
        :host, *, *::before, *::after{box-sizing:border-box}
        :host{display:block}
        .topRight{display:flex; gap:6px; align-items:center}
        .btn{appearance:none; border:1px solid #333; background:#111; color:#fff; border-radius: var(--bsky-radius, 0px); padding:6px 10px; cursor:pointer}
        .btn:hover{border-color:#3b5a8f}
        .btn.link{color:#9cd3ff; text-decoration:none}
        .muted{color:#aaa}
        .err{color:#f88}
        .section{margin-bottom:10px}
      </style>

      <bsky-panel-shell dense title="Content">
        <div slot="head-right" class="topRight">
          ${open ? `<a class="btn link" href="${esc(open)}" target="_blank" rel="noopener">Open</a>` : ''}
          <button class="btn" type="button" data-close>Close</button>
        </div>

        <div class="section">
          ${this._loading ? '<div class="muted">Loading thread…</div>' : ''}
          ${this._error ? `<div class="err">Error: ${esc(this._error)}</div>` : ''}
        </div>

        <div class="section">
          <bsky-thread-tree></bsky-thread-tree>
        </div>

        <div class="section">
          <bsky-comment-composer></bsky-comment-composer>
        </div>
      </bsky-panel-shell>
    `;

    const tree = this.shadowRoot.querySelector('bsky-thread-tree');
    tree?.setThread?.(this._thread);

    const composer = this.shadowRoot.querySelector('bsky-comment-composer');
    composer?.setReplyTo?.(this._replyTo);
  }
}

customElements.define('bsky-content-panel', BskyContentPanel);
