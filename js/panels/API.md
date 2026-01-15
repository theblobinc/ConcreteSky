# Panels API

This folder defines the ConcreteSky “panel system”: a small framework-free set of utilities + templates that mount Web Components inside a consistent panel shell.

## Concepts

### Panel
A “panel” is a tabbed container managed by the panels controller. Each panel mounts a single Web Component (usually wrapped in `<bsky-panel-shell dense>`).

### Panel scroller
Panels should treat the `<bsky-panel-shell>` scroller as the canonical scroll container:

- Get it with: `this.shadowRoot.querySelector('bsky-panel-shell')?.getScroller?.()`
- For nested components embedded inside a panel (component inside component), use `resolvePanelScroller(this)`.

### Stable item keys (`data-k`)
If a list re-renders and you want to preserve scroll position, list items should carry a stable key attribute:

- Use `data-k="..."` on each list/card row.
- The key should be stable for the lifetime of the item (examples: `uri`, `did`, `notifKey`, etc.).

This is the contract used by `captureScrollAnchor()` / `applyScrollAnchor()`.

## Templates / Registry

Templates live in `packages/concretesky/js/panels/templates/`.

Each template is a small object:

- `name`: unique id (also used for `[data-tab]` and `[data-panel]`)
- `title`: tab label
- `mountHtml`: inserted when active
- `defaultActive` (optional)
- `showInTabs` (optional; set false for aux/side panels)

Registry helpers (from `panel_api.js`):

- `registerPanelTemplate(tpl)`
- `getPanelTemplates()`
- `getDefaultActiveTabs()`

## Scrolling utilities

### `bindNearBottom(scroller, onNearBottom, opts)`
Binds a passive scroll listener and fires `onNearBottom` when within `threshold` pixels from the end.

Options:
- `threshold` (default `220`)
- `enabled: () => boolean`

### `bindInfiniteScroll(scroller, loadMore, opts)`
Standard infinite scrolling used across panels. It prevents accidental double-triggering during rapid re-renders.

Options:
- `threshold` (default `220`)
- `enabled: () => boolean`
- `isLoading: () => boolean`
- `hasMore: () => boolean`
- `onExhausted: async () => void` (optional)
- `cooldownMs` (default `250`)
- `exhaustedCooldownMs` (default `5000`)
- `initialTick` (default `true`)

Return value:
- Returns an `unbind()` function.

## Lazy media helpers

Some panels render large amounts of media (avatars, thumbnails, image grids). To keep scroll smooth and memory stable, panels can render media as placeholders and only load the real assets when they’re near the viewport.

### Preferred: `<bsky-lazy-img>`

Use the built-in web component for scroller-aware loading/unloading:

- Example:
	- `<bsky-lazy-img src="https://.../thumb.jpg" aspect="16/9"></bsky-lazy-img>`
- Attributes:
	- `src`, `srcset`, `alt`
	- `aspect` (example `16/9` or `1/1`)
	- `root-margin` (default `1000px 0px`)
	- `unload-delay` (ms, default `2500`)
	- `keep` (present = never unload)

### `initLazyMedia({ scroller, root, selector, rootMargin, unloadDelayMs })`

Behavior:
- Observes elements (usually `<img>`) matching `selector` inside `root`.
- When an element is near the viewport, sets `src` from `data-media-src` (and `srcset` from `data-media-srcset` if present).
- When an element is far away, it can unload back to `MEDIA_PLACEHOLDER_SRC` after `unloadDelayMs`.

Conventions:
- Render images like:
	- `src="MEDIA_PLACEHOLDER_SRC"`
	- `data-media-src="https://..."`
- Set an `aspect-ratio` style to preserve layout while media is unloaded.

Return value:
- Returns a `cleanup()` function that disconnects observers/timeouts.

## Scroll stability helpers (shared hooks)

These are used to prevent “scroll jumps” when a component re-renders and re-parents DOM (masonry, grids, etc.).

### `resolvePanelScroller(scope)`
Finds the nearest `<bsky-panel-shell>` scroller even across nested shadow roots.

Use this when a component is embedded inside a panel component.

### `captureScrollAnchor({ scroller, root, itemSelector, keyAttr })`
Captures the top-most visible item and its offset within the scroller.

Parameters:
- `scroller`: the scroll container element
- `root`: the query root that contains items (usually `this.shadowRoot`)
- `itemSelector`: selector to find items (example: `.entry[data-k]`)
- `keyAttr`: attribute used as stable key (example: `data-k`)

Returns:
- `{ key, offsetY, scrollTop }` or `null`

### `applyScrollAnchor({ scroller, root, anchor, keyAttr })`
Restores scroll position by finding the item with the same key and adjusting scrollTop by the delta.

Returns:
- `true` if applied, `false` otherwise.

### `createStableWorkQueue({ getScroller, getRoot, itemSelector, keyAttr })`
Creates a debounced “layout work” queue:

- Coalesces multiple triggers into a single `requestAnimationFrame`.
- Captures the scroll anchor, runs `work()`, then reapplies the anchor.

Recommended use cases:
- ResizeObserver-driven relayout
- Masonry/grid reflow
- Late-loading images causing re-measure/repack

## Tabs + panel control helpers

These helpers let panels open/close/position other panels without hard-coding the controller:

- `getTabsApi(scope)`
- `activatePanel(name, scope)`
- `deactivatePanel(name, scope)`
- `placePanelAfter(name, afterName, scope)`

## Content panel helpers

These helpers dispatch events that the app shell listens for:

- `openContentPanel(detail, scope)` → dispatches `bsky-open-content`
- `closeContentPanel(scope)` → dispatches `bsky-close-content`

## Conventions

- Prefer DB/server-side filtering so `limit/offset` match visible rows.
- If your UI re-renders a list, use stable `data-k` keys and anchor scroll.
- Use `bindInfiniteScroll()` instead of ad-hoc scroll listeners.
