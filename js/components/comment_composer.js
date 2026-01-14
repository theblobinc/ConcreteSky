const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));

export class BskyCommentComposer extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._replyTo = null; // { uri, author }
    this._submitting = false;
  }

  setReplyTo(replyTo) {
    this._replyTo = replyTo || null;
    this.render();
  }

  connectedCallback() {
    this.render();
    this.shadowRoot.addEventListener('click', (e) => this.onClick(e));
  }

  onClick(e) {
    if (e.target?.closest?.('[data-clear]')) {
      this.setReplyTo(null);
      this.dispatchEvent(new CustomEvent('bsky-reply-to', { detail: null, bubbles: true, composed: true }));
      return;
    }

    if (e.target?.closest?.('[data-submit]')) {
      const ta = this.shadowRoot.querySelector('textarea');
      const text = String(ta?.value || '').trim();
      if (!text) return;

      this.dispatchEvent(new CustomEvent('bsky-submit-comment', {
        detail: { text, replyTo: this._replyTo },
        bubbles: true,
        composed: true,
      }));

      if (ta) ta.value = '';
    }
  }

  render() {
    const who = this._replyTo?.author ? `Replying to ${this._replyTo.author}` : 'Write a reply';

    this.shadowRoot.innerHTML = `
      <style>
        :host, *, *::before, *::after{box-sizing:border-box}
        :host{display:block}
        .bar{display:flex; align-items:center; gap:8px; margin-bottom:6px; color:#bbb}
        .bar .who{font-weight:700; color:#eaeaea; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
        .bar button{margin-left:auto}

        textarea{width:100%; min-height:80px; resize:vertical; border-radius:10px; border:1px solid #222; background:#0b0b0b; color:#fff; padding:8px; outline:none}
        textarea:focus{border-color:#2f4b7a; box-shadow:0 0 0 2px rgba(47,75,122,.25)}

        .actions{display:flex; justify-content:flex-end; gap:8px; margin-top:8px}
        button{appearance:none; border:1px solid #333; background:#111; color:#fff; border-radius:10px; padding:6px 10px; cursor:pointer}
        button:hover{border-color:#3b5a8f}
        .muted{color:#aaa}
      </style>

      <div class="bar">
        <div class="who">${esc(who)}</div>
        ${this._replyTo ? `<button type="button" data-clear title="Clear reply target">Clear</button>` : ''}
      </div>

      <textarea placeholder="${esc(who)}..."></textarea>

      <div class="actions">
        <button type="button" data-submit>Send</button>
      </div>

      <div class="muted" style="margin-top:6px">Posting replies is scaffolded; backend write API not wired yet.</div>
    `;
  }
}

customElements.define('bsky-comment-composer', BskyCommentComposer);
