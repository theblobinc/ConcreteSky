# Panels TODO

## Planned features

- Panel API docs: keep `API.md` current as new hooks are added.
- Standardize stable keys: all list-like components should use `data-k` for scroll anchoring.
- Virtualization for long lists (connections/notifications/posts) to reduce DOM size.
- Better “exhausted” UX for infinite scroll (explicit end-of-feed states per panel).
- Centralized error/toast reporting for load failures (common hook).
- Persist per-panel scroll position across tab switches (opt-in).

This is the roadmap for improving the ConcreteSky panel system and adding upcoming UI features (notifications, commenting, threaded rendering, and a content/details panel).

## Goals

- Keep the SPA within 100% viewport width at all times (no horizontal overflow).
- Panels should reduce columns as space shrinks, down to a single primary column.
- On mobile, users should swipe horizontally between panels.
- Panels should be modular: shared layout, shared UX APIs, pluggable menus/controls.
- Support adding new panels later by dropping in a template module.

## Panel System Stabilization (Do First)

### 1) Make sizing rules consistent and predictable
- Ensure a single source of truth for:
  - card width: `--bsky-card-w`
  - card gap: `--bsky-card-gap`
  - panel density: `--bsky-panel-pad(-dense)` etc
- Verify panel sizing logic aligns with the new `<bsky-panel-shell dense>` (avoid “extra padding models” drifting).

### 2) Mobile behavior (no overflow)
- Mobile mode is “one panel per screen”:
  - `.panel { flex: 0 0 100%; min-width: 100%; }`
  - horizontal scroll + `scroll-snap`
- Ensure stored panel widths never apply on mobile.

### 3) Reduce “layout regression” risk
- Add a small debug helper (optional) to log:
  - panelsWrap width
  - each panel’s flex-basis + measured width
  - card width/gap
- Add a single “reset layout” escape hatch (already exists) and confirm it also resets any new panel keys.

## Panel Templates / Registry (Foundation)

### 4) Standardize panel templates
- Templates live in: `packages/concretesky/js/panels/templates/`
- Each template exports:
  - `name` (must match `data-tab` / `data-panel`)
  - `title` (tab label)
  - `mountHtml` (rendered when active)
  - optional `defaultActive`

Example template:

```js
// packages/concretesky/js/panels/templates/notifications.js
export default {
  name: 'notifications',
  title: 'Notifications',
  mountHtml: '<bsky-notifications></bsky-notifications>',
  defaultActive: false,
};
```

### 5) Standardize panel utilities
- Shared utilities live in: `packages/concretesky/js/panels/panel_api.js`
- Keep it framework-free; provide small helpers panels can share:
  - `registerPanelTemplate()` / `getPanelTemplates()`
  - `getDefaultActiveTabs()`
  - `debounce(fn, ms)`
  - `bindNearBottom(scroller, cb, { threshold, enabled })`
  - `isMobilePanelsViewport()`

Example usage:

```js
// inside a panel that uses <bsky-panel-shell>
import { bindNearBottom } from '../panels/panel_api.js';

const scroller = this.shadowRoot.querySelector('bsky-panel-shell')?.getScroller?.();
this._unbindNearBottom?.();
this._unbindNearBottom = bindNearBottom(scroller, () => this.load(false), {
  threshold: 220,
  enabled: () => !this.loading && this.hasMore,
});
```

## Notifications Panel (High Priority)

### 6) Add a Notifications panel template
- Add: `packages/concretesky/js/panels/templates/notifications.js`
- Register in `panel_api.js`

Code:

```js
// packages/concretesky/js/panels/panel_api.js
import notifications from './templates/notifications.js';
registerPanelTemplate(notifications);
```

### 7) Implement `<bsky-notifications>` component
- File: `packages/concretesky/js/components/notifications.js` (already exists but needs “panel shell parity” and UX).
- Requirements:
  - Display grouped/filtered notifications (mentions, replies, likes, reposts, follows).
  - Mark as read/unread.
  - Click notification -> open associated post/thread in content panel.
  - Pagination + infinite scroll.
  - Optional polling interval or manual refresh.

Skeleton:

```js
// packages/concretesky/js/components/notifications.js
import { call } from '../api.js';
import { bindNearBottom, debounce } from '../panels/panel_api.js';

class BskyNotifications extends HTMLElement {
  constructor(){
    super();
    this.attachShadow({ mode: 'open' });
    this.items = [];
    this.loading = false;
    this.cursor = null;
    this.hasMore = false;
    this.filters = { q: '', types: new Set(['all']) };
    this._unbindNearBottom = null;
  }

  connectedCallback(){
    this.render();
    this.load(true);
  }

  async load(reset){
    // TODO: implement via ConcreteSky API (cache + network modes as needed)
    // const out = await call('cacheQueryNotifications', { ... })
  }

  openItem(item){
    const uri = item?.uri;
    if (!uri) return;
    this.dispatchEvent(new CustomEvent('bsky-open-content', {
      detail: { kind: 'post', uri },
      bubbles: true,
      composed: true,
    }));
  }

  render(){
    this.shadowRoot.innerHTML = `
      <bsky-panel-shell title="Notifications" dense>
        <div slot="toolbar">TODO filters/search</div>
        <div>TODO list</div>
      </bsky-panel-shell>
    `;

    const scroller = this.shadowRoot.querySelector('bsky-panel-shell')?.getScroller?.();
    this._unbindNearBottom?.();
    this._unbindNearBottom = bindNearBottom(scroller, () => this.load(false), {
      enabled: () => !this.loading && this.hasMore,
    });
  }
}

customElements.define('bsky-notifications', BskyNotifications);
```

Acceptance criteria:
- Loads fast from cache/DB.
- Does not reflow panels unexpectedly.
- Works as a single swipe panel on mobile.

## Content Panel (Post Details) (High Priority)

### 8) Add a “content” panel template
- Template: `packages/concretesky/js/panels/templates/content.js`
- Mounted component: `<bsky-content-panel>` (new).

Template:

```js
// packages/concretesky/js/panels/templates/content.js
export default {
  name: 'content',
  title: 'Content',
  mountHtml: '<bsky-content-panel></bsky-content-panel>',
  defaultActive: false,
};
```

### 9) Behavior: click a post -> open content panel
- In Posts panel:
  - Clicking a post (excluding links/buttons) selects it.
  - Emits an event (suggested): `bsky-open-content`
    - detail: `{ uri, cid, kind: 'post' }`
- In App shell / panels controller:
  - If the content panel is not visible, activate it.
  - Ensure layout makes room by reducing the posts panel by exactly 1 column when possible.

Posts click emission (pattern):

```js
// inside bsky-my-posts
onClickPost(uri, cid){
  this.dispatchEvent(new CustomEvent('bsky-open-content', {
    detail: { kind: 'post', uri, cid },
    bubbles: true,
    composed: true,
  }));
}
```

App-side handler (suggested location: inside bsky-app after bootTabs):

```js
// inside bsky-app connectedCallback()
this.shadowRoot.addEventListener('bsky-open-content', (e) => {
  const { uri, cid } = e?.detail || {};
  if (!uri && !cid) return;

  // 1) make content panel visible
  // 2) pass selected uri/cid to <bsky-content-panel>
  // 3) reduce posts panel by exactly 1 column if possible
});
```

Content panel skeleton:

```js
// packages/concretesky/js/components/content_panel.js
import { call } from '../api.js';

class BskyContentPanel extends HTMLElement {
  constructor(){
    super();
    this.attachShadow({ mode: 'open' });
    this.selection = null; // { uri, cid }
  }

  setSelection(sel){
    this.selection = sel;
    this.load();
  }

  async load(){
    // TODO: fetch post + thread + likes/reposts/replies
    // const out = await call('cacheGetPostDetails', { uri: this.selection.uri })
    this.render();
  }

  render(){
    this.shadowRoot.innerHTML = `
      <bsky-panel-shell title="Content" dense>
        <div slot="toolbar">TODO actions (reply/like/repost)</div>
        <div>TODO post details + thread tree</div>
      </bsky-panel-shell>
    `;
  }
}

customElements.define('bsky-content-panel', BskyContentPanel);
```

Acceptance criteria:
- Content panel is exactly 1 column wide (card width based).
- Posts panel loses exactly 1 column, not more.
- Closing the content panel restores the previous layout.
- On mobile: content panel becomes a swipeable panel.

## Commenting + Interactions (High Priority)

### 10) Add a comment composer web component
- New component: `<bsky-comment-composer>`
- Requirements:
  - Reply-to context
  - character count
  - submit + disabled states
  - emits event on successful post/reply

Skeleton:

```js
// packages/concretesky/js/components/comment_composer.js
import { call } from '../api.js';

class BskyCommentComposer extends HTMLElement {
  constructor(){
    super();
    this.attachShadow({ mode: 'open' });
    this.replyTo = null; // { uri }
    this.text = '';
    this.loading = false;
  }

  setReplyTo(uri){
    this.replyTo = uri ? { uri } : null;
    this.render();
  }

  async submit(){
    if (this.loading) return;
    const text = String(this.text || '').trim();
    if (!text) return;

    this.loading = true;
    this.render();
    try {
      // TODO: wire to create-post / create-reply endpoint
      // const out = await call('createReply', { parentUri: this.replyTo?.uri, text })
      this.text = '';
      this.dispatchEvent(new CustomEvent('bsky-post-created', { bubbles: true, composed: true }));
    } finally {
      this.loading = false;
      this.render();
    }
  }

  render(){
    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block}
        textarea{width:100%;min-height:90px;background:#0b0b0b;color:#fff;border:1px solid #333;border-radius:10px;padding:8px}
        .row{display:flex;justify-content:space-between;align-items:center;margin-top:6px;gap:8px}
        button{background:#111;border:1px solid #555;color:#fff;padding:8px 10px;border-radius:10px;cursor:pointer}
        button:disabled{opacity:.6;cursor:not-allowed}
        .muted{color:#aaa}
      </style>
      <textarea placeholder="Write a reply…">${this.text || ''}</textarea>
      <div class="row">
        <div class="muted">${(this.text || '').length}/300</div>
        <button ${this.loading ? 'disabled' : ''}>${this.replyTo ? 'Reply' : 'Post'}</button>
      </div>
    `;

    const ta = this.shadowRoot.querySelector('textarea');
    ta?.addEventListener('input', () => { this.text = ta.value; });
    const btn = this.shadowRoot.querySelector('button');
    btn?.addEventListener('click', () => this.submit());
  }
}

customElements.define('bsky-comment-composer', BskyCommentComposer);
```

### 11) Implement post details interactions
- In content panel:
  - show likes
  - show reposts
  - show replies
  - actions: like/repost/reply (as permitted)

## Thread/Comment Tree Rendering (High Priority)

### 12) Add a thread tree renderer
- New component: `<bsky-thread-tree>`
- Requirements:
  - Render replies in a tree (parent -> children).
  - Collapse/expand branches.
  - Lazy-load deeper replies if needed.
  - Visual connectors and indentation.

  Skeleton:

  ```js
  // packages/concretesky/js/components/thread_tree.js
  class BskyThreadTree extends HTMLElement {
    constructor(){
      super();
      this.attachShadow({ mode: 'open' });
      this.root = null; // tree node
      this.collapsed = new Set();
    }

    setThreadTree(rootNode){
      this.root = rootNode;
      this.render();
    }

    toggle(uri){
      if (!uri) return;
      if (this.collapsed.has(uri)) this.collapsed.delete(uri);
      else this.collapsed.add(uri);
      this.render();
    }

    renderNode(node, depth){
      const kids = Array.isArray(node?.replies) ? node.replies : [];
      const isCollapsed = this.collapsed.has(node?.uri);
      return `
        <div class="node" style="--d:${depth}">
          <div class="card">
            <div class="meta">${node?.author?.handle ? '@' + node.author.handle : ''}</div>
            <div class="text">${node?.text || ''}</div>
          </div>
          ${(!isCollapsed && kids.length)
            ? `<div class="kids">${kids.map((k) => this.renderNode(k, depth + 1)).join('')}</div>`
            : ''
          }
        </div>
      `;
    }

    render(){
      this.shadowRoot.innerHTML = `
        <style>
          :host{display:block}
          .node{margin-left:calc(var(--d) * 16px)}
          .card{border:1px solid #333;border-radius:10px;padding:8px;background:#0b0b0b;margin:6px 0}
          .meta{color:#aaa;font-size:.9rem}
          .text{white-space:pre-wrap}
        </style>
        ${this.root ? this.renderNode(this.root, 0) : '<div class="muted">No thread.</div>'}
      `;
    }
  }

  customElements.define('bsky-thread-tree', BskyThreadTree);
  ```

Acceptance criteria:
- Stable ordering within a thread.
- Does not cause panel overflow.

## Backend/API Tasks (Needed for the above)

### 13) Add endpoints for post details + thread data
- Add/extend API calls for:
  - post details by URI
  - thread fetch by URI
  - likes list
  - reposts list
  - replies list
  - create reply

### 14) Cache strategy
- Cache post details + thread responses to reduce repeated network fetch.
- Consider background hydration (similar to profile hydration).

## UX/Polish

### 15) Keyboard + accessibility
- Focus management when opening content panel.
- Proper `role="region"` and labels.

### 16) Performance
- Virtualize long lists where needed.
- Avoid re-sorting loaded items; preserve stable ordering unless explicitly requested.

## Suggested Implementation Order

1. Stabilize panel sizing (no overflow, reliable mobile swipe).
2. Add Content panel (template + component + open/close flow).
3. Upgrade Notifications panel to use content panel for deep links.
4. Add thread tree rendering inside content panel.
5. Add comment composer and reply flow.
6. Iterate on caching + performance.
