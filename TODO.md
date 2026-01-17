# TODO (ConcreteSky)

This is the top-level TODO for the package (GitHub-facing).

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
- Add a compact, themeable style system (CSS variables) to keep colors/spacing consistent across panels.

### 5) Notifications UX (bar + panel)

- Enrich notification entries: show who performed the action (identity block/avatar/handle), and show relationship state (following / follows-you / mutual) where relevant.
- Add quick actions/links (open profile, open post, follow/unfollow when appropriate) and improve grouping/layout readability.

### 6) Data features

- Optional FTS search for cached profiles/posts (SQLite FTS5), with a clean fallback to LIKE when unavailable. (Posts FTS implemented; falls back to LIKE if FTS5 isn't available.)
- Export tools (CSV/JSON) for cached datasets (followers/following/notifications/posts) for AI workflows. (Posts/notifications/followers/following export implemented via `cacheExport`.)
- Add “signals” / analyst views for suspicious or unusual activity patterns (e.g. account age buckets, follower/following ratio, sudden spikes, top interactors).

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

### 9) Bluesky feature parity (expansive)

#### Composer / Posting
- [x] Bluesky-like composer lightbox (Posts panel).
- [x] 300-char counter + over-limit enforcement.
- [x] Thread composer "+" (multi-part posts) with sequential root/parent chaining.
- [x] Emoji picker.
- [x] GIF link insertion (URL into text).
- [x] Multi-image attachments (up to 4) + alt text.
- [x] Language tagging on posts via `record.langs` (uses browser languages).
- [x] Drafts: local drafts per context + autosave (text + interaction settings; incl. thread parts).
- [ ] Drafts: persist media selections across reloads (likely needs IndexedDB; not localStorage).
- [ ] Scheduled posts (client-side scheduler + server job to publish).
- [ ] Edit post (Bluesky supports record update semantics; confirm UX + history).
- [ ] Post deletion UX improvements (undo window, optimistic removal).

#### Facets (mentions, links, hashtags)
- [x] Auto-link URLs into facets (`app.bsky.richtext.facet#link`).
- [x] @mention parsing + DID resolution into facets (`#mention`).
- [x] Hashtag parsing into facets (`#tag`).
- [x] Unicode-safe facet indexing (UTF-8 byte indices).

#### Interaction settings (gates)
- [x] Reply controls (threadgate) for new root posts:
	- Everyone (no gate)
	- Nobody (`allow: []`)
	- Custom: mentioned users / followers / following / list
- [x] List picker support for reply gates (loads lists via `app.bsky.graph.getLists`, fallback to paste AT-URI).
- [x] Quote/embedding control (postgate): disable embedding/quotes.
- [ ] Expose additional postgate rules if/when supported (future lexicon expansion).
- [ ] UI copy parity (Bluesky wording + per-setting explanations).

#### Media
- [x] Images upload + embed.images.
- [ ] Video upload + embed.video support (upload flow + transcoding constraints).
- [ ] Media processing UX: progress bar, cancel, retry.
- [ ] Content accessibility: alt-text required toggle + warnings when missing.

#### Embeds
- [x] Render quoted posts (record embeds) in feed/thread view.
- [x] Render external link cards where available.
- [ ] Better embed fallback: fetch external cards when only a URL is present.
- [ ] Record-with-media embeds (quote + images/video) full parity.

#### Threading / Conversation UX
- [x] True nested replies across all surfaces.
- [x] Hide-root behavior where duplicate root cards would appear.
- [x] Inline reply composer inserted under clicked post; second click closes.
- [ ] Better “reply-to” UX like Bluesky: show the parent snippet above composer.
- [ ] “Detach thread” / “Continue thread” UX for composing follow-ups.

#### Content labels / Safety
- [ ] Self-labeling UI (e.g. “Adult content”) and attach labels per post.
- [ ] Content warnings UI (toggle + reason) and render in timeline.
- [ ] Respect viewer moderation preferences (hide/blur sensitive media).
- [ ] Report post/account flows (if supported via endpoints).

#### Lists / Feeds
- [ ] Browse + manage lists (create, delete, add/remove members).
- [ ] Timeline view for a list feed.
- [ ] Custom feed browsing (app.bsky.feed.getActorFeeds / getFeedSkeleton).

#### Notifications + Activity
- [ ] Full parity notification rendering (reason strings, grouped actions).
- [ ] Inline actions in notifications (like/repost/follow) without context switch.
- [ ] Background polling with backoff + “unread” badge counts.

#### Accessibility / Polish
- [ ] Keyboard navigation for composer parts + pickers.
- [ ] Proper focus management when opening/closing dialogs.
- [ ] Screenreader labels for all icon buttons.

### 8) People monitoring (watchlist + activity)

- Add a “Watchlist” / People Monitoring panel:
	- Add/remove Bluesky users by handle/DID.
	- Persist watchlist in SQLite (and expose via API).
- Cache watched users’ profile + recent posts on-demand and on a schedule.
- Activity stats for watched users:
	- Posting frequency, active hours/days, recent streaks.
	- Interaction stats: replies/likes/reposts involving you and/or other watched users.
	- “New since last check” summaries.
- Notifications for watched users:
	- In-app notifications when they post (and optionally when they are replied to / quoted / reposted).
	- Optional: email notifications and web push notifications (future).

## Maintenance

- Consider deprecating or clearly labeling the legacy app-password login path (`authLogin`) now that OAuth is the default.
