class BskyPanelShell extends HTMLElement {
  static get observedAttributes() {
    return ['title', 'dense'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    this.render();
  }

  getScroller() {
    return this.shadowRoot?.querySelector?.('.scroller') || null;
  }

  render() {
    const title = this.getAttribute('title') || '';
    const dense = this.hasAttribute('dense');

    this.shadowRoot.innerHTML = `
      <style>
        :host, *, *::before, *::after{box-sizing:border-box}
        :host{
          display:block;
          color: var(--bsky-panel-fg, #fff);
          background: var(--bsky-panel-bg, #070707);
          border: 1px solid var(--bsky-panel-border, #333);
          border-radius: var(--bsky-panel-radius, 0px);

          --_pad: var(--bsky-panel-pad, 0px);
          --_gap: var(--bsky-panel-gap, 0px);
          --_ctrl-gap: var(--bsky-panel-control-gap, 8px);
        }
        :host([dense]){
          --_pad: var(--bsky-panel-pad-dense, 0px);
          --_gap: var(--bsky-panel-gap-dense, 0px);
          --_ctrl-gap: var(--bsky-panel-control-gap-dense, 6px);
        }

        .wrap{padding:var(--_pad); width:100%; min-width:0}
        .head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 var(--_gap) 0}
        .title{font-weight:800; min-width:0}
        .headRight{display:flex;align-items:center;gap:var(--_ctrl-gap);flex-wrap:wrap;min-width:0;justify-content:flex-end}

        .toolbar{display:flex;align-items:center;gap:var(--_ctrl-gap);flex-wrap:wrap;margin:0 0 var(--_gap) 0}
        .toolbar:empty{display:none}

        .scroller{
          width:100%;
          min-width:0;
          overflow:auto;
          max-height: calc(100vh - var(--bsky-panel-ui-offset, 290px));
        }

        .footer{margin-top:var(--_gap)}
        .footer:empty{display:none}
      </style>

      <div class="wrap">
        <div class="head">
          <div class="title">${title}</div>
          <div class="headRight"><slot name="head-right"></slot></div>
        </div>

        <div class="toolbar"><slot name="toolbar"></slot></div>

        <div class="scroller" part="scroller"><slot></slot></div>

        <div class="footer"><slot name="footer"></slot></div>
      </div>
    `;
  }
}

customElements.define('bsky-panel-shell', BskyPanelShell);
