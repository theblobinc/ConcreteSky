const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));

export class BskyCommentComposer extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._replyTo = null; // { uri, cid, author }
    this._submitting = false;
    this._images = []; // [{ name, mime, dataBase64, alt }]
  }

  setReplyTo(replyTo) {
    this._replyTo = replyTo || null;
    this.render();
  }

  connectedCallback() {
    this.render();
    this.shadowRoot.addEventListener('click', (e) => this.onClick(e));
    this.shadowRoot.addEventListener('change', (e) => this.onChange(e));
    this.shadowRoot.addEventListener('input', (e) => this.onInput(e));
  }

  onClick(e) {
    if (e.target?.closest?.('[data-clear]')) {
      this.setReplyTo(null);
      this.dispatchEvent(new CustomEvent('bsky-reply-to', { detail: null, bubbles: true, composed: true }));
      return;
    }

    if (e.target?.closest?.('[data-add-images]')) {
      const inp = this.shadowRoot.getElementById('imgs');
      inp?.click?.();
      return;
    }

    const rm = e.target?.closest?.('[data-remove-img]');
    if (rm) {
      const idx = Number(rm.getAttribute('data-remove-img') || -1);
      if (Number.isFinite(idx) && idx >= 0 && idx < this._images.length) {
        this._images.splice(idx, 1);
        this.render();
      }
      return;
    }

    if (e.target?.closest?.('[data-submit]')) {
      const ta = this.shadowRoot.querySelector('textarea');
      const text = String(ta?.value || '').trim();
      if (!text) return;

      this.dispatchEvent(new CustomEvent('bsky-submit-comment', {
        detail: {
          text,
          replyTo: this._replyTo,
          media: {
            images: this._images.map((i) => ({
              name: i.name || '',
              mime: i.mime || '',
              dataBase64: i.dataBase64 || '',
              alt: i.alt || '',
            })),
          },
        },
        bubbles: true,
        composed: true,
      }));

      if (ta) ta.value = '';
      this._images = [];
      this.render();
    }
  }

  async onChange(e) {
    const inp = e.target;
    if (inp?.id !== 'imgs') return;

    const files = Array.from(inp.files || []);
    if (!files.length) return;

    // Limit to 4 images per Bluesky embed.images.
    const remaining = Math.max(0, 4 - this._images.length);
    const take = files.slice(0, remaining);

    const readOne = (file) => new Promise((resolve) => {
      try {
        const r = new FileReader();
        r.onload = () => {
          const url = String(r.result || '');
          const m = url.match(/^data:([^;]+);base64,(.*)$/);
          if (!m) return resolve(null);
          resolve({
            name: String(file?.name || ''),
            mime: String(m[1] || ''),
            dataBase64: String(m[2] || ''),
            alt: '',
          });
        };
        r.onerror = () => resolve(null);
        r.readAsDataURL(file);
      } catch {
        resolve(null);
      }
    });

    const added = [];
    for (const f of take) {
      // Basic type guard.
      const mt = String(f?.type || '');
      if (!mt.startsWith('image/')) continue;
      // Keep conservative client-side size checks.
      if (Number(f?.size || 0) > (2 * 1024 * 1024)) continue;
      const item = await readOne(f);
      if (item && item.mime && item.dataBase64) added.push(item);
    }

    if (added.length) {
      this._images = [...this._images, ...added].slice(0, 4);
      this.render();
    }

    try { inp.value = ''; } catch {}
  }

  onInput(e) {
    const el = e.target;
    if (!el) return;
    const idxAttr = el.getAttribute?.('data-alt-idx');
    if (idxAttr == null) return;
    const idx = Number(idxAttr);
    if (!Number.isFinite(idx) || idx < 0 || idx >= this._images.length) return;
    this._images[idx].alt = String(el.value || '');
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

        .media{margin-top:8px}
        .thumbs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:6px}
        .thumb{border:1px solid #222;background:#0b0b0b;padding:6px}
        .thumb img{width:100%;height:auto;display:block;background:#111}
        .thumb input{width:100%;margin-top:6px;background:#0b0b0b;color:#fff;border:1px solid #222;padding:6px}
        .thumb .rm{margin-top:6px;width:100%}

        textarea{width:100%; min-height:80px; resize:vertical; border-radius: var(--bsky-radius, 0px); border:1px solid #222; background:#0b0b0b; color:#fff; padding:8px; outline:none}
        textarea:focus{border-color:#2f4b7a; box-shadow:0 0 0 2px rgba(47,75,122,.25)}

        .actions{display:flex; justify-content:flex-end; gap:8px; margin-top:8px}
        button{appearance:none; border:1px solid #333; background:#111; color:#fff; border-radius: var(--bsky-radius, 0px); padding:6px 10px; cursor:pointer}
        button:hover{border-color:#3b5a8f}
        .muted{color:#aaa}
      </style>

      <div class="bar">
        <div class="who">${esc(who)}</div>
        ${this._replyTo ? `<button type="button" data-clear title="Clear reply target">Clear</button>` : ''}
      </div>

      <textarea placeholder="${esc(who)}..."></textarea>

      <div class="media">
        <div class="bar" style="margin:6px 0 0 0">
          <div class="who">Media</div>
          <button type="button" data-add-images ${this._images.length >= 4 ? 'disabled' : ''}>Add images</button>
        </div>
        <input id="imgs" type="file" accept="image/*" multiple hidden>

        ${this._images.length ? `
          <div class="thumbs">
            ${this._images.map((img, i) => {
              const src = img.mime && img.dataBase64 ? `data:${img.mime};base64,${img.dataBase64}` : '';
              return `
                <div class="thumb">
                  ${src ? `<img src="${esc(src)}" alt="">` : ''}
                  <input type="text" placeholder="Alt text" value="${esc(img.alt || '')}" data-alt-idx="${i}">
                  <button class="rm" type="button" data-remove-img="${i}">Remove</button>
                </div>
              `;
            }).join('')}
          </div>
        ` : '<div class="muted" style="margin-top:6px">(Optional) Attach up to 4 images.</div>'}
      </div>

      <div class="actions">
        <button type="button" data-submit>Send</button>
      </div>
    `;
  }
}

customElements.define('bsky-comment-composer', BskyCommentComposer);
