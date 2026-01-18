# ConcreteSky UI API

This document describes the public UI/web-component API for the ConcreteSky SPA.

Related docs:

- Panel-system contract helpers: `PANELS_API.md`
- Search router (HUD query language + event bus): `SEARCH.md`

## Component Hierarchy

Top-level:

- `<bsky-app>` (Shell)
  - Tabs + panel layout (multi-column)
  - Mounts panels dynamically based on selected tabs
  - Defines global CSS variables for card sizing + density

Panels (mounted inside `<bsky-app>`):

- `<bsky-my-posts>` (Posts)
- `<bsky-connections>` (Connections)
- `<bsky-people-search>` (Search)

Shared layout primitive:

- `<bsky-panel-shell>`
  - Used internally by the panels above to standardize layout and spacing.

Panel templates/registry:

- Panel definitions live in `js/panels/templates/`.
- `js/panels/panel_api.js` registers these templates and exposes a small API for future panels.

## `<bsky-app>`

### Purpose

- Provides the SPA shell: tabs, panel container, and global sizing variables.
- Keeps the app portable: most layout CSS lives in the component shadow DOM.

### Mounting behavior

- Panels are mounted into their containers when their tab is active.
- Multiple tabs can be active to show multiple panels side-by-side.

### Templates

`<bsky-app>` renders its tabs and panel sections from the panel template registry.

Add a new panel by creating a module in `js/panels/templates/` that exports:

- `name` (used for `data-tab` + `data-panel`)
- `title` (tab label)
- `mountHtml` (what to mount when active)
- optional `defaultActive`

### CSS Variables

These are defined on `<bsky-app>` and inherited by panel components.

Card sizing (used by MagicGrid + panel sizing logic):

- `--bsky-card-w` (default `320px`): card width used for grid column math
- `--bsky-card-min-w` (default `260px`): minimum width used for panel sizing logic
- `--bsky-card-gap` (default `8px`): horizontal/vertical spacing between cards
- `--bsky-panels-gap` (default `6px`): spacing between visible panels

Panel spacing defaults (used by `<bsky-panel-shell>`):

- `--bsky-panel-pad` / `--bsky-panel-pad-dense`
- `--bsky-panel-gap` / `--bsky-panel-gap-dense`
- `--bsky-panel-control-gap` / `--bsky-panel-control-gap-dense`

## `<bsky-panel-shell>`

### Purpose

A small layout component that standardizes:

- Header + right-side header area
- Optional toolbar row
- Scrollable body
- Optional footer row


### Attributes

- `title` (string): header title text
- `dense` (boolean): enables compact spacing (recommended for the panel area)

### Slots

- `head-right`: content on the right side of the header (e.g. counters)
- `toolbar`: optional controls row below the header
- default slot: panel body content (rendered inside the scroll region)
- `footer`: optional footer row


### Methods

- `getScroller(): HTMLElement | null`
  - Returns the internal scroll container. Panels use this for:
    - infinite-scroll triggers
    - MagicGrid column sizing based on the actual usable width

### CSS Variables

- `--bsky-panel-ui-offset` (default `290px`)
  - Used to compute `max-height: calc(100vh - var(--bsky-panel-ui-offset))` for the panel body.

You can also override visual variables:

- `--bsky-panel-bg`, `--bsky-panel-fg`, `--bsky-panel-border`, `--bsky-panel-radius`


## `<bsky-my-posts>`

### Purpose

- Renders cached posts in a Masonry-like grid using MagicGrid.
- Provides filters (range + type toggles), and infinite scroll pagination.

### Data behavior

- Loads in pages (typically `limit=100`).
- Preserves stable ordering (does not re-sort already loaded entries on the client).
- When new items are prepended (e.g. background refresh), existing loaded items keep their relative order.

### Events listened to

- `bsky-auth-changed` (window): resets / reloads when auth connects or disconnects.
- `bsky-refresh-recent` (window): opportunistically fetches newer items and prepends them.

### UI

- Uses `<bsky-panel-shell dense>` internally.
- Uses MagicGrid and clamps the grid container width to exactly the used columns.

## `<bsky-connections>`

### Purpose

- Renders cached followers/following profiles in a MagicGrid layout.
- Provides controls for filtering and sorting, and infinite scroll pagination.

### Notes

- Uses `<bsky-panel-shell dense>` internally.
- Includes a "Sync cache" action to update the local cache.

## `<bsky-people-search>`

### Purpose

- Search UI for accounts.

### Modes

- Local cache mode: instant local filtering.
- Network mode: queries live data (paginates via cursor).

### Notes

- Uses `<bsky-panel-shell dense>` internally.

## MagicGrid + Sizing Contract

The grid layout depends on a simple contract:

- Card width is fixed and comes from `--bsky-card-w`.
- Spacing comes from `--bsky-card-gap`.
- The grid container width is set to: `numCols * (cardW + gap) - gap`.

This prevents a “phantom column” gap and keeps columns stable across shadow roots.

## Backend API (`call()`)

ConcreteSky uses a single JSON endpoint (ConcreteCMS controller) that behaves like a lightweight JSON-RPC.

- Client wrapper: `js/api.js`
- Server router: `controllers/single_page/concretesky/api.php`


### Transport

- **URL**: `window.BSKY.apiPath` (defaults to `/api`)
- **Method**: `POST`
- **Body**: `{ "method": "<name>", "params": { ... } }`
- **Errors**: server returns JSON with `error`/`message`; the client throws.

### Methods (current)

**Identity / profiles**: `getProfile`, `getProfiles`, `profilesHydrate`, `cacheGetProfiles`, `searchActors`

**Feeds / timelines**: `getTimeline`, `getAuthorFeed`, `getFeed`, `searchPosts`

**Posts / threads**: `getPosts`, `getPostThread`, `createPost`, `deletePost`

**Media**: `uploadBlob`

**Engagement**: `like`, `unlike`, `repost`, `unrepost`, `getLikes`, `getRepostedBy`, `getQuotes`

**Relationships**: `getFollowers`, `getFollows`, `getRelationships`, `follow`, `unfollow`, `followMany`, `queueFollows`, `followQueueStatus`, `processFollowQueue`

**Moderation / graph**: `getBlocks`, `block`, `unblock`, `getMutes`, `mute`, `unmute`

**Lists**: `getLists`

**Bluesky parity: gates**: `createThreadGate`, `createPostGate`

**Rich-text helpers**: `resolveHandles`, `unfurlUrl`

**Notifications**: `listNotifications`, `updateSeenNotifications`, `listNotificationsSince`

**Cache/backfill (optional)**: all methods starting with `cache*`

## Background follow-queue draining (no browser needed)

Bulk follow actions are enqueued into SQLite (`follow_queue`). To ensure the queue keeps draining even when no user has the UI open, ConcreteSky includes a ConcreteCMS job:

- Job file: `jobs/concretesky_follow_queue_processor.php`
- Behavior: finds actors with pending follows due now, refreshes their stored auth sessions, and calls the same internal queue-draining logic used by the API (rate-limit aware).


### Scheduling

- Dashboard: **System & Settings → Optimization → Automated Jobs** (enable + set your preferred schedule)
- CLI (cron-friendly): `php concrete/bin/concrete5 c5:job concretesky_follow_queue_processor`
  - To list jobs: `php concrete/bin/concrete5 c5:job --list`

### Environment knobs

These apply to both UI-triggered and job-triggered processing:

- `CONCRETESKY_FOLLOW_MAX_PER_HOUR` (default `2500`)
- `CONCRETESKY_FOLLOW_MAX_PER_RUN` (default `100`)

These apply to the background job runner:

- `CONCRETESKY_FOLLOW_JOB_MAX_ACTORS` (default `10`) — how many distinct actors to process per job run
- `CONCRETESKY_FOLLOW_JOB_MAX_PER_ACTOR` (default `100`) — requested per-actor cap for a job run (still clamped by `CONCRETESKY_FOLLOW_MAX_PER_RUN`)
- `CONCRETESKY_FOLLOW_JOB_LOCK_SECONDS` (default `300`) — coarse lock to avoid overlapping job runs

## Shared controllers (modular behavior)

To keep panels small and reusable, cross-panel behaviors should live in `js/controllers/*`.

Current shared controller(s):

- Compose/posting controller: `js/controllers/compose_controller.js`
  - `defaultLangs()`
  - `resolveMentionDidsFromTexts()` + `buildFacetsSafe()`
  - `selectEmbed()` (quote + media + link-unfurl selection)
  - `applyInteractionGates()`

- Lists controller: `js/controllers/lists_controller.js`
  - `fetchLists()`
  - `bindListsRequest()` (handles the `bsky-request-lists` event for composers)

- Cache sync controller: `js/controllers/cache_sync_controller.js`
  - `syncRecent()` (prefers `bsky-sync-recent` when `<bsky-notification-bar>` is present)
    - default: falls back to `cacheSyncRecent` + `bsky-refresh-recent`
    - set `allowDirectFallback:false` for event-only usage (no direct sync)

- Follow queue controller: `js/controllers/follow_queue_controller.js`
  - `queueFollows(dids, { processNow, maxNow, maxPerTick })` (rate-limit friendly bulk follow)
  - `startFollowQueueProcessor({ maxPerTick })` / `stopFollowQueueProcessor()`
  - Emits window events:
    - `bsky-follow-queue-enqueued`
    - `bsky-follow-queue-processed`
    - `bsky-follow-queue-status`

Backend knobs (env):

- `CONCRETESKY_FOLLOW_MAX_PER_HOUR` (default `2500`)
- `CONCRETESKY_FOLLOW_MAX_PER_RUN` (default `100`)


## Adding new panels/bars (recommended pattern)

1. Create a web component under `js/panels/components/<name>/...`.
2. Register it via the panel template registry (`js/panels/templates/*`).
3. Keep feature logic modular:
  - "Behavior" modules in `js/controllers/*`
  - "Pure utilities" in `js/lib/*`
  - UI as small web components that compose those modules.
4. If your surface can post, always use the shared compose controller for facets/unfurl/embeds/gates.

## Panel API (`panel_api.js`)

File: `js/panels/panel_api.js`

- `registerPanelTemplate(template)` / `getPanelTemplates()`
  - Registry used by `<bsky-app>` to render tabs and sections.
- `debounce(fn, ms)`
  - Utility for debounced inputs (used by panels).
- `bindNearBottom(scroller, onNearBottom, { threshold, enabled })`
  - Utility to implement infinite scroll consistently.
- `isMobilePanelsViewport()`
  - Helper for mobile sizing decisions.

Example usage (panel component):

```js
import { bindNearBottom } from './panels/panel_api.js';

const shell = this.shadowRoot.querySelector('bsky-panel-shell');
const scroller = shell?.getScroller?.();

this._unbindNearBottom?.();
this._unbindNearBottom = bindNearBottom(scroller, () => this.load(false), {
  threshold: 240,
  enabled: () => !this.loading && this.hasMore,
});
```
