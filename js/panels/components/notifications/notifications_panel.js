import './notifications.js';

export class BskyNotificationsPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
  }

  disconnectedCallback() {
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host, *, *::before, *::after{box-sizing:border-box}
        :host{display:block}
      </style>

      <bsky-panel-shell dense title="Notifications" persist-key="notifications">
        <bsky-notifications embedded></bsky-notifications>
      </bsky-panel-shell>
    `;
  }
}

customElements.define('bsky-notifications-panel', BskyNotificationsPanel);
