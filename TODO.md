# TODO (ConcreteSky)

This is the top-level TODO for the package (GitHub-facing). A more detailed/legacy planning doc exists at `single_pages/concretesky/TODO.md`.

## Already done (implemented)

- Tabs/panels system with persistence (`bsky_active_tabs` in localStorage + `#tabs=...` hash) + drag ordering + resize.
- SQLite cache (profiles, follower/following snapshots + diffs, notifications, posts) with migrations + schema versioning.
- Cache/ops endpoints: `cacheStatus`, `cacheSync`, `cacheSyncRecent`, `cacheQueryPeople`, `cacheFriendDiff`, `cacheQueryNotifications`, `cacheQueryMyPosts`.
- Calendar coverage API + UI: `cacheCalendarMonth` + DB Manager calendar view.
- Social HUD: cache coverage calendar icon (ring indicator: up-to-date / partial / needs update + pre-join grey), click day for summary + backfill actions.
- Shared cache settings lightbox: usable from Social HUD and notification bar settings; leverages DB Manager calendar for drill-down + range backfill tooling.
- Backfill tooling:
	- Posts: `cacheBackfillMyPosts`
	- Notifications: `cacheBackfillNotifications`
	- UI wiring exists (DB Manager + Cache Status components)
- “Month-level bulk actions” via calendar selection + range backfill/refresh.

## No longer needed / superseded

- Separate “Search tab” (superseded by in-panel search/filtering and the shared search utilities; consider adding a dedicated Search panel only if it provides extra value).
- “Remove hardcoded defaults for credentials” (OAuth is the default; legacy env-based handle/app-password is not required).

## Next (prioritized)

### 1) Backfill clarity + progress

- Deep notifications/posts backfill status: retention caveats + current cursor/coverage + “done” signal. (Implemented: `cacheStatus.backfill` + DB Manager display.)
- Better progress stats for notification backfill (inserted/updated/skipped per chunk) + surfaced in UI. (Implemented.)
- Long-running backfills safer: explicit cancel/stop controls + clearer messaging. (Implemented: DB Manager stop + HUD cancel hooks; copy tweaks optional.)

### 2) Cache lifecycle + maintenance

- Add cache pruning strategy (retention / TTL + vacuum) to keep `cache.sqlite` bounded. (Implemented: admin actions + scheduled job `concretesky_cache_maintenance`.)
- Add an admin-only “DB inspector” view (table sizes, indexes, schema version, last vacuum, writable-path checks). (Implemented: `cacheDbInspect` + DB Manager.)
- Add cache schema migration smoke checks (at least a minimal command/script to run migrate + verify schema version). (Implemented: CLI `concretesky:cache:migrate-check`.)

### 3) Security / access control

- Add configurable access-control guard for the SPA (admin/whitelist/group-based). (Implemented: `CONCRETESKY_UI_*` + server-side enforcement.)
- Keep OAuth endpoints workable: `/oauth/client_metadata` and `/oauth/callback` must remain reachable.
- Document and harden automation mode defaults (JWT allowlist, superuser requirement, when to enable `CONCRETESKY_JWT_ENFORCE`). (Implemented: README guidance + safe defaults.)

### 4) UX / configuration

- Persist DB Manager settings (calendar selections, pagesMax, notifications window, posts filter) optionally in localStorage. (Implemented: `bsky.dbManager.prefs`.)
- Add staleness threshold configuration (what counts as “stale” for cached rows and UI warnings). (Implemented in DB Manager; can be propagated to other panels if desired.)
- Improve rate-limit errors (surface retry-after / backoff hints; reduce spammy retries). (Implemented: Retry-After surfaced + UI backoff in long-running loops.)

### 5) Notifications UX (bar + panel)

- Enrich notification entries: show who performed the action (identity block/avatar/handle), and show relationship state (following / follows-you / mutual) where relevant.
- Add quick actions/links (open profile, open post, follow/unfollow when appropriate) and improve grouping/layout readability.

### 6) Data features

- Optional FTS search for cached profiles/posts (SQLite FTS5), with a clean fallback to LIKE when unavailable. (Posts FTS implemented; falls back to LIKE if FTS5 isn't available.)
- Export tools (CSV/JSON) for cached datasets (followers/following/notifications/posts) for AI workflows. (Posts/notifications/followers/following export implemented via `cacheExport`.)

### 7) Posts / Threads UI (feed + content)

- Posts feed should be thread-centric:
	- Default: compact “summary cards” for posts/replies/reposts.
	- Expand/collapse (+/−) per entry to show the full thread inline (no accidental cross-thread nesting).
	- Clicking any entry opens the Content panel in “conversation/thread view”.
- Fix incorrect nesting in Posts feed where unrelated items appear under the same thread (treat feed items as independent unless explicitly expanded to a fetched thread).
- Inline media in-client (no forced redirect to bsky.app):
	- Images: render grids/preview in cards and in thread view.
	- Bluesky video: render/play inline where possible; add fallback behavior for HLS if the browser can’t play it.
- Commenting / replying:
	- Dedicated comment UI web components under `packages/concretesky/js/comment/*`.
	- Reply composer usable in both the Posts panel (inline in the card) and the Content panel (thread view).
	- Support full Bluesky media options for replies (at minimum: multi-image upload + alt text; extend to video as supported).
	- After posting, refresh the thread/feed to reflect the new reply.
- Reposting:
	- Repost/unrepost actions in cards and thread view.
	- Keep UI state in sync (optimistic update + refresh).

## Maintenance

- Consider deprecating or clearly labeling the legacy app-password login path (`authLogin`) now that OAuth is the default.
