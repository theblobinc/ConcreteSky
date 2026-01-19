# ConcreteSky API Reference

This document covers:

- **Backend JSON API** (the `/concretesky/api` endpoint used by the SPA)
- **UI Web Components API** (the public web-component surface used by the SPA)

Related docs:

- Panel-system contract helpers: `PANELS_API.md`
- Search router (HUD query language + event bus): `SEARCH.md`

## Backend JSON API ("call()")

ConcreteSky uses a single JSON endpoint (ConcreteCMS controller) that behaves like a lightweight JSON-RPC.

- Client wrapper: `packages/concretesky/js/api.js`
- Server router: `packages/concretesky/controllers/single_page/concretesky/api.php`

### Transport

- **URL**: `window.BSKY.apiPath` (normally `/concretesky/api`)
- **Method**: `POST`
- **Cookies**: sent (ConcreteCMS session)
- **Headers**:
  - `Content-Type: application/json`
  - `X-CSRF-Token: <token>` (browser flow)
  - `Authorization: Bearer <jwt>` (optional automation flow; see below)
- **Body**: `{ "method": "<name>", "params": { ... } }`

ConcreteSky's JS client sends requests with `credentials: 'include'` and will retry once if it detects an expired token.

Example (browser JS):

```js
import { call } from './api.js';

const status = await call('authStatus');
console.log(status);
```

Example (curl + JWT automation):

```bash
curl -sS \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${CONCRETESKY_JWT}" \
  -d '{"method":"authStatus","params":{}}' \
  'https://your-site.example/concretesky/api'
```

### Auth modes

#### Browser session + CSRF (default)

- You must be logged into ConcreteCMS.
- Requests must include a valid `X-CSRF-Token` for token handle `bsky_api`.
- The SPA provides `window.BSKY.csrf` and also attempts to read CSRF from the DOM/cookies.

#### JWT automation (optional)

For scripts and automation (including MCP-style tooling), the API can accept `Authorization: Bearer <jwt>`.
When a valid JWT is present:

- CSRF validation is skipped.
- Some admin-only operations still require a superuser (either a superuser JWT or a superuser browser session).

Relevant `.env` keys:

- `CONCRETESKY_JWT_ENABLED` (default `false`)
- `CONCRETESKY_JWT_SECRET` (min length 16)
- `CONCRETESKY_JWT_USERS` / `CONCRETESKY_JWT_USER` (comma-separated ConcreteCMS usernames)
- `CONCRETESKY_JWT_REQUIRE_SUPERUSER` (default `true`)
- `CONCRETESKY_JWT_ENFORCE` (default `false`; when true, all requests require JWT)

### Errors

- Errors are returned as JSON with an `error` string and an HTTP status code.
- Rate limiting uses HTTP `429` with a `Retry-After` header.
- The JS client wraps 429s into a `RateLimitError` (with `retryAfterSeconds`).

### Key methods (documented)

The list below is not exhaustive, but it covers the ConcreteSky-specific integration surface and the methods that are most likely to be called directly.

#### `authStatus`

Returns ConcreteCMS user status and current Bluesky connection status.

- Does **not** require an existing Bluesky session.
- Hardened to never fatal-loop if the cache DB is unavailable.

Response fields (high level):

- `c5.registered`, `c5.userId`, `c5.userName`
- `connected`, `did`, `handle`, `displayName`, `avatar`, `pds`, `updatedAt`
- `activeDid` and `accounts[]` (multi-account support)
- `cacheAvailable` and `cacheError`

#### Cache calendar + catalogue management

These endpoints operate on the local SQLite cache catalogue for the **currently connected account**.

- `cacheCalendarMonth`
  - Returns which days in a given month have cached **posts** and/or **notifications**, including counts.
- `cacheCatalogStatus`
  - High-level catalogue stats: row counts, min/max timestamps, db size info, and relevant meta keys.
- `cacheCatalogPrune`
  - Deletes old cached rows.
  - Params:
    - `kind`: `posts|notifications|all` (default `posts`)
    - `before`: ISO timestamp cutoff (exclusive) *or* `keepDays` (keep last N days)
    - `vacuum`: boolean (default `false`)
- `cacheCatalogResync`
  - Resets backfill state so cache can be re-ingested.
  - Params:
    - `kind`: `posts|notifications|all` (default `posts`)
    - `clear`: boolean (default `true`)
    - `postsFilter`: optional `app.bsky.feed.getAuthorFeed` filter (e.g. `posts_with_replies`)

#### Translation

- `translateText`
  - Params: `text` (required), `to` (default `en`), `from` (default `auto`)
  - Backend is configured via `.env`:
    - `CONCRETESKY_TRANSLATE_BACKEND` (`libretranslate` or `none`)
    - `CONCRETESKY_TRANSLATE_LIBRETRANSLATE_URL`
    - `CONCRETESKY_TRANSLATE_LIBRETRANSLATE_API_KEY` (optional)

#### Post editing

- `editPost`
  - Overwrites an existing post record in your repo (`com.atproto.repo.putRecord`).
  - You can only edit posts owned by the connected DID.
  - Params:
    - `uri` (optional) and/or `rkey` (required if uri not provided)
    - `text` (required)
    - `facets` (optional; to set/clear explicitly)
    - `langs` (optional; to set/clear explicitly)

#### Scheduled posts

Scheduled posts are stored site-locally (SQLite) as ready-to-publish payloads.

- `schedulePost`
  - Params:
    - `scheduledAt` (required; ISO; must be in the future)
    - `kind`: `post|thread` (default `post`)
    - For `post`: `post: { text, langs?, facets?, embed? }`
    - For `thread`: `parts: [{ text, langs?, facets?, embed? }, ...]` (max 10)
    - Optional: `interactions` (gates)
- `listScheduledPosts`
  - Params: `limit` (default 50), `includeDone` (default false)
- `cancelScheduledPost`
  - Params: `id` (required)
- `processScheduledPosts`
  - Params: `max` (default 25)
  - Used by UI buttons and by the scheduled-posts job.

#### MCP login helper (optional)

- `mcpLogin`
  - Converts a valid JWT into a ConcreteCMS logged-in session cookie.
  - Disabled by default; gated by `CONCRETESKY_MCP_LOGIN_ENABLED`.

### Methods (inventory)

This is a quick index of methods currently implemented by the router.

**Identity / profiles**: `getProfile`, `getProfiles`, `profilesHydrate`, `cacheGetProfiles`, `searchActors`

**Feeds / timelines**: `getTimeline`, `getAuthorFeed`, `getFeed`, `searchPosts`

**Posts / threads**: `getPosts`, `getPostThread`, `createPost`, `editPost`, `deletePost`

**Media**: `uploadBlob`

**Engagement**: `like`, `unlike`, `repost`, `unrepost`, `getLikes`, `getRepostedBy`, `getQuotes`

**Relationships**: `getFollowers`, `getFollows`, `getRelationships`, `follow`, `unfollow`, `followMany`, `queueFollows`, `followQueueStatus`, `processFollowQueue`

**Moderation / graph**: `getBlocks`, `block`, `unblock`, `getMutes`, `mute`, `unmute`

**Lists**: `getLists`

**Notifications**: `listNotifications`, `updateSeenNotifications`, `listNotificationsSince`

**Translation**: `translateText`

**Scheduled posts**: `schedulePost`, `listScheduledPosts`, `cancelScheduledPost`, `processScheduledPosts`

**Cache/backfill (optional)**: `cacheCalendarMonth`, `cacheCatalogStatus`, `cacheCatalogPrune`, `cacheCatalogResync`, and other methods starting with `cache*`

**Groups (site-local)**: `groupsList`, `groupGet`, `groupCreate`, `groupUpdate`, `groupJoin`, `groupInviteJoin`, `groupInviteAccept`, `groupLeave`, `groupAuditList`, `groupMembersList`, `groupMemberApprove`, `groupMemberDeny`, `groupMemberWarn`, `groupMemberSuspend`, `groupMemberUnsuspend`, `groupMemberBan`, `groupMemberUnban`, `groupInviteCreate`, `groupInvitesList`, `groupInviteRevoke`, `groupRulesAccept`, `groupRulesUpdate`

**Groups (post moderation)**: `groupPostSubmit`, `groupPostsList`, `groupPostsPendingList`, `groupPostApprove`, `groupPostDeny`

**Groups (feed suppression)**: `groupHiddenPostsList`, `groupPostHide`, `groupPostUnhide`

**Groups (phrase filters)**: `groupPhraseFiltersList`, `groupPhraseFilterAdd`, `groupPhraseFilterRemove`

**Groups (reports)**: `groupReportCreate`, `groupReportsList`, `groupReportResolve`

**Groups (self-service)**: `groupPostsMineList`

**Groups (posting settings)**: `groupPostingSettingsUpdate`

**Bluesky parity: gates**: `createThreadGate`, `createPostGate`

**Rich-text helpers**: `resolveHandles`, `unfurlUrl`

## UI Web Components API

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

### Group context (site-local)

The shell provides a simple “active group” context used by the Group panel and any future group-scoped features.

- Persisted key: `localStorage['bsky_active_group_id']` (stringified integer; `0`/missing means “no active group”).
- Event: `window` dispatches `bsky-group-changed` with `detail: { groupId, group }` whenever the selector changes.
- UX: selecting a non-zero group automatically activates the `group` panel tab.
- Consumer: `<bsky-group-home>` listens for `bsky-group-changed` and calls `groupGet/groupJoin/groupLeave`.

#### Group posting/tagging (MVP)

Because posts are stored on Bluesky, the MVP “post to group” feature associates posts with a group via a stable hashtag derived from the group slug:

- Tag format: `#csky_<slug>` with non-alphanumerics normalized to `_`.
- The Group panel uses `searchPosts` with `q = <tag>` to render a group feed.
- The composer submits via `groupPostSubmit` (not `createPost` directly).
  - `public` groups: the server immediately creates the Bluesky post.
  - `closed/secret` groups: the server stores a pending item in `group_posts` for moderator approval.
  - Mods approve/deny via `groupPostApprove` / `groupPostDeny` and list the queue via `groupPostsPendingList`.
- Members can view their own submission history via `groupPostsMineList`.
- Mods can suppress specific public posts from the group UI feed site-locally via `groupPostHide` / `groupPostUnhide` (does not delete the Bluesky post).
- Mods can configure phrase filters (site-local) via `groupPhraseFiltersList` / `groupPhraseFilterAdd` / `groupPhraseFilterRemove`.
  - Filters are enforced during `groupPostSubmit`.
  - Action `deny`: blocks the submission.
  - Action `require_approval`: forces a pending submission even in `public` groups.
- Groups can optionally enable “slow mode” (site-local) via `groupPostingSettingsUpdate`.
  - When enabled, `groupPostSubmit` enforces a minimum time between submissions for non-mod members.
- Group moderators/admins can apply site-local member sanctions:
  - Warn: `groupMemberWarn`
  - Suspend/unsuspend: `groupMemberSuspend` / `groupMemberUnsuspend`
  - Ban/unban: `groupMemberBan` / `groupMemberUnban`
  - Enforcement:
    - `groupPostSubmit` returns `403` with `code: "banned"` for banned members.
    - `groupPostSubmit` returns `403` with `code: "suspended"` and `retryAfterSeconds` for active suspensions.
    - `groupJoin` and `groupInviteJoin` return `403` with `code: "banned"` if a member is banned/blocked.
- Members can report a post URI (site-local) via `groupReportCreate`; mods can list/resolve via `groupReportsList` / `groupReportResolve`.
  - `groupReportsList` supports `state: open|resolved`.
  - Resolving supports an optional “hide this post from the group feed” behavior (site-local).
- Groups can define site-local rules (Markdown) enforced for posting.
  - Members accept rules via `groupRulesAccept`.
  - Mods/admins set rules via `groupRulesUpdate`.
- Note: this is **not privacy**; the feed is still public Bluesky content, and closed/secret semantics are enforced only for site-local membership/admin actions.

Related event (optional): panels that create/join/leave groups may dispatch `bsky-groups-changed` so the shell refreshes its selector by re-calling `groupsList`.

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
