# TODO (ConcreteSky)

This is the top-level TODO for the package (GitHub-facing).

## North Star

Build “Facebook Groups, but for Bluesky”: community spaces (membership + moderation + discovery + admin tooling) powered by AT Protocol identities and content, delivered as a PHP-first package with Web Components so it can embed into most PHP websites with minimal integration.

Principles:

- Web Components first: the UI should be portable across PHP sites.
- One shared controller per behavior: panels stay thin; reusable logic lives in `js/controllers/*`.
- Durable background work: rate-limit and maintenance work should keep running via ConcreteCMS jobs (and later, cron for non-Concrete hosts).
- Cache-first UX: use SQLite for fast browsing/filtering; fall back to network when needed.

## Parity targets

- Bluesky client parity: core posting, reading, engagement, moderation, and account management.
- Facebook Groups parity: group spaces, membership/roles, moderation queue, units/guides, events, announcements, and insights.

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
- [ ] Post “translations” / inline translate UX (if supported; else defer) + copy-to-clipboard.
- [ ] Per-post audience controls parity (where applicable): visibility-like semantics (note: ATProto is public-first; document constraints clearly).
- [ ] Drafts: autosave to IndexedDB (text + media + gates) for crash-proof drafts.
- [ ] Drafts: export/import (JSON) for power users.

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
- [ ] Embed accessibility parity: ensure quoted/external cards expose meaningful text for screen readers.
- [ ] Embed safety: guard against layout shifts (image aspect reservation) and malicious URLs.

#### Threading / Conversation UX
- [x] True nested replies across all surfaces.
- [x] Hide-root behavior where duplicate root cards would appear.
- [x] Inline reply composer inserted under clicked post; second click closes.
- [ ] Better “reply-to” UX like Bluesky: show the parent snippet above composer.
- [ ] “Detach thread” / “Continue thread” UX for composing follow-ups.
- [ ] Thread actions parity: collapse/expand all, copy link, share, open in new panel.
- [ ] Conversation context parity: show “you replied” / “you reposted” indicators.

#### Content labels / Safety
- [ ] Self-labeling UI (e.g. “Adult content”) and attach labels per post.
- [ ] Content warnings UI (toggle + reason) and render in timeline.
- [ ] Respect viewer moderation preferences (hide/blur sensitive media).
- [ ] Report post/account flows (if supported via endpoints).
- [ ] “Mute thread” / “hide post” local actions (site-local) if network endpoints don’t exist.
- [ ] Safety UX parity: clear per-post label explanations + “Why am I seeing this?” affordance.

#### Lists / Feeds
- [ ] Browse + manage lists (create, delete, add/remove members).
- [ ] Timeline view for a list feed.
- [ ] Custom feed browsing (app.bsky.feed.getActorFeeds / getFeedSkeleton).
- [ ] Feed pin/reorder persistence (per account) + export/import.
- [ ] Curate feeds in UI: add/remove to home, rename aliases, icons.

#### Notifications + Activity
- [ ] Full parity notification rendering (reason strings, grouped actions).
- [ ] Inline actions in notifications (like/repost/follow) without context switch.
- [ ] Background polling with backoff + “unread” badge counts.
- [ ] Mark-as-read semantics parity (per-notification + “mark all read”) with server sync where possible.
- [ ] Notification preferences UI (what to notify on; per-account).
- [ ] Activity filters: mentions, replies, follows, likes, reposts, quotes.
- [ ] “Activity” view parity (likes/reposts on your posts; your own actions timeline).

#### Discoverability / Search
- [ ] Global search parity (people + posts + feeds) with a unified results UI.
- [ ] Hashtag browsing (tap a hashtag → feed view).
- [ ] Saved searches / pinned queries (localStorage + optional SQLite persistence).
- [ ] Trending view parity (if available; else approximate via cached aggregation: top hashtags/links).
- [ ] Starter packs (if supported): browse + view members + follow-all with rate limiting.
- [ ] User lists discovery: show lists that include an actor (if supported) and list search.

#### Profiles / Identity
- [ ] Profile edit UI (display name, bio, avatar/banner upload if supported).
- [ ] “Followers you know” / mutuals UX parity.
- [ ] Relationship badges everywhere (following/follows-you/mutual) with fast cached lookups.
- [ ] Profile tabs parity: posts, replies, media, likes (if supported via endpoints) + counts.
- [ ] Profile moderation controls: mute/block/report from profile with clear state.
- [ ] Account switching UX parity: multi-account picker + per-account state isolation.

#### Bookmarks / Saves
- [ ] Bookmarks / saved posts (if supported; else implement local-only saved list in SQLite per actor).
- [ ] “Read later” list UI + export.
- [ ] Local-only tagging for saves (labels/folders), plus quick filters.

#### Media parity
- [ ] Video upload + `embed.video` support (upload flow + constraints + playback).
- [ ] GIF picker parity (provider abstraction; allow swapping sources).
- [ ] Media processing UX: progress, cancel, retry.

#### DMs / Chat (if/when supported)
- [ ] DM surface (inbox + thread view) if Bluesky exposes stable endpoints.
- [ ] If not supported: explicitly defer and keep UI hooks modular.

#### Blocks / Mutes / Moderation prefs
- [ ] Mute/unmute user UI + fast cached state.
- [ ] Block/unblock user UI + fast cached state.
- [ ] Muted words/phrases UI (if supported), including per-language and per-scope toggles.
- [ ] List-based moderation parity (mute list / block list) if supported.
- [ ] Labelers management UI (subscribe/unsubscribe labelers; explain implications) if supported.

#### Feeds / Timeline UX
- [ ] Feed picker parity: Following + custom feeds with pin/reorder.
- [ ] Feed composition preferences (hide replies, show reposts, etc.) if supported.
- [ ] Better infinite-scroll UX: virtualization, scroll position restore, “new posts” banner.

#### Settings / Preferences
- [ ] Viewer preferences UI (hide/blur sensitive media, labelers, moderation prefs).
- [ ] Per-account settings persistence (SQLite + UI sync).
- [ ] Session diagnostics UI: show token expiry, DPoP status, last refresh, last error.
- [ ] Privacy/security settings: clear cached tokens locally, clear per-account caches, “forget account” UX.
- [ ] Theme preferences: compact/comfortable density, font size, reduced motion.

#### Account lifecycle
- [ ] Handle change support (detect + update cached profile links).
- [ ] DID rotation / recovery story (document constraints; handle gracefully if it occurs).
- [ ] “Sign out everywhere”/token revoke UX (if supported) or local-only sign-out.
- [ ] Account migration tooling for site-local data (saved posts, group membership): export/import keyed by DID.

#### Diagnostics / Developer tooling
- [ ] Built-in “Request Log” panel (admin-only): last N XRPC calls, status, latency, rate-limit headers.
- [ ] “Replay last request” button (safe GETs only) and “copy curl” for debugging.
- [ ] Feature flags UI (localStorage + optional server-config): enable experimental panels/features.
- [ ] Minimal error reporting hook (optional): log to a site-local table for support.

#### Internationalization
- [ ] i18n strategy for Web Components (string tables, locale selection, fallbacks).
- [ ] Date/time formatting parity (relative times, locale-sensitive).
- [ ] RTL support audit for panel layouts.

#### Offline-ish / resilience
- [ ] Background refresh scheduler (jobs) for posts + notifications + profiles with backoff.
- [ ] Conflict-safe refresh (avoid duplicates; stable ordering; cursor correctness).
- [ ] “Low-connectivity mode” toggle: fewer images, smaller page sizes, less aggressive polling.
- [ ] Robust retry UX: per-surface “retry now” buttons + explain backoff state.

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

## Facebook Groups parity (Bluesky-first)

This section is the backlog for building “groups” as a first-class product. Some features map directly to ATProto primitives; others will be implemented as **site-local group metadata + moderation** while posting public content to Bluesky.

### 1) Group model (foundation)

- [ ] Define a durable Group model:
	- [x] SQLite schema + migrations (groups + membership + audit log).
	- [ ] Export/backup + import (site portability).
	- [ ] Clarify constraints and invariants (owner transfer, delete semantics).
- [ ] Group-scoped routing in UI:
	- [x] Group selector (site-level nav) + persisted active group.
	- [x] Shell stays in sync on group changes (live refresh).
	- [x] Group home panel with MVP activity feed.
- [ ] Group settings UI (admins only).

- [x] MVP server API for site-local groups (list/get/create/update/join/leave).
- [x] MVP Groups panel (list + join/leave + admin create).

### 2) Membership + roles

- [ ] Membership states: `member|pending|blocked|invited`.
- [ ] Roles: `admin|moderator|member` (+ optional `trusted`).
- [ ] Join flow parity:
	- Join questions (form builder + stored answers).
	- [x] Approval queue for closed groups (admin-only MVP).
	- [x] Invite links (rotatable tokens) (admin-only MVP).
- [ ] Group rules (markdown) + onboarding gate (“must accept rules”).

### 3) Group feed + posting

- [ ] Group feed panel:
	- [x] MVP: tag-based feed from Bluesky search.
	- [ ] Sort modes (new, top, hot) with clear semantics.
	- [ ] Topic tags (group-local taxonomy).
- [ ] Posting into a group:
	- [x] Post composer supports “post to group” (adds group tag).
	- [x] Group-only posting rules (MVP): members can submit; closed/secret require approval; public posts publish immediately.
	- [ ] Slow-mode / per-member rate limits.
- [ ] Announcement posts + pinning:
	- Pin up to N posts; show pinned section.
	- Admin-only announcement marker.

### 4) Moderation queue (Facebook-style)

- [ ] Moderation surfaces:
	- [x] Pending posts queue (approve/deny) (MVP: mods/admins only).
	- Report queue (user reports with reasons).
	- Member requests queue (approve/deny).
- [ ] Moderator actions:
	- [x] Remove post (from group feed) (MVP: site-local hide/unhide), keep audit log.
	- Warn/suspend/ban member (group-local enforcement).
	- Keyword filters / blocked phrases.
- [ ] Audit log UI + export (who did what, when).

### 5) Units / Guides (learning content)

- [ ] Units feature parity (Facebook “Guides”):
	- Units have title/description + ordered steps.
	- Steps can link to posts, external URLs, or local HTML blocks.
	- Completion tracking per member.

### 6) Events

- [ ] Group events:
	- Create/edit event, RSVP list.
	- Optional reminders (email/push later).
	- Event posts in group feed.

### 7) Files / Media library

- [ ] Group files (site-local storage): upload, organize, permissions.
- [ ] Link media to posts/units/events.
- [ ] Anti-abuse constraints (size limits, types, virus scan hook).

### 8) Insights / analytics

- [ ] Group insights dashboard:
	- Growth (members over time, join sources).
	- Engagement (posts/comments/reactions per day).
	- Top contributors, top posts.
	- Moderation workload stats.

### 9) Discovery + cross-site portability

- [ ] “Directory” view of groups on a site (categories, search).
- [ ] Export/import group configuration + membership list.
- [ ] Non-Concrete host strategy:
	- Extract core PHP library (auth + XRPC + SQLite + jobs runner) so other PHP CMSs can integrate.
	- Define a minimal cron entrypoint equivalent to Concrete jobs.

### 10) Post types + engagement parity

- [ ] Poll posts (group-local): create, vote, results visibility rules.
- [ ] Q&A / “Ask a question” post type (accepted answer + surfaced state).
- [ ] Anonymous posting (admin-controlled; audited; optional moderator reveal).
- [ ] Post reactions beyond likes (group-local) if desired; ensure anti-abuse constraints.

### 11) Group chat / real-time community

- [ ] Group chat surface (site-local): channels, member mentions, moderation.
- [ ] If Bluesky DMs become viable: optionally bridge group chat to DMs for small groups.

### 12) Admin automation (“Moderation Assist”)

- [ ] Auto-approve rules (account age, mutuals, prior member standing, answered questions).
- [ ] Auto-decline heuristics (link spam patterns, repeated phrases, suspicious domains).
- [ ] Scheduled moderation reports (daily digest) for admins.

### 13) Membership + community management

- [ ] Member badges / roles expansion (e.g. “Top contributor”, “New member”, “Verified”).
- [ ] Welcome posts + onboarding checklist.
- [ ] Member directory view with filters (new members, most active, moderators).

### 14) Content organization + knowledge base

- [ ] Topics taxonomy tooling: merge/rename, pin topics, topic rules.
- [ ] Wiki/Docs (site-local): pages with history + editor permissions.
- [ ] Group “Files” + “Docs” unified library (search, tagging).

### 15) Integrations + sharing

- [ ] Share group content externally:
	- Generate canonical permalinks that work outside the panel UI.
	- Optional OpenGraph cards for posts/events/units.
- [ ] Webhook/event stream for group actions (new member, post approved, report created).

### 16) Safety + compliance

- [ ] Privacy controls parity: secret groups should not leak membership/content in listings.
- [ ] Data retention tooling: delete member data, export member data, purge audit logs by policy.
- [ ] Abuse handling: rate limits per member, post cooldowns, link limits, attachment limits.

### 17) Governance + rules enforcement

- [ ] Appeals workflow: member can appeal a denial/ban; moderator review; audit trail.
- [ ] Moderator permissions granularity (who can ban vs approve vs edit rules vs manage files).
- [ ] “Admin announcements” system: schedule announcements, pin duration, expiry.
- [ ] Rule change history + member re-acknowledgement gate when rules update.

### 18) Subgroups + multi-space communities

- [ ] Subgroups / channels inside a group (topic-based rooms) with per-channel posting rules.
- [ ] Cross-posting between subgroups with attribution.
- [ ] “Collections” for organizing posts (saved threads inside a group).

### 19) Monetization + fundraising (optional)

- [ ] Paid groups / memberships (site-local billing integration; keep optional and decoupled).
- [ ] Donations/fundraisers: campaign posts + progress display + donor privacy controls.
- [ ] Member perks (badges, role unlocks) managed by admins.

### 20) Notifications + digests (group-scoped)

- [ ] Group notification settings: new posts, mentions, announcements, events, units.
- [ ] Email digests (daily/weekly) for group activity (site-local mailer integration).
- [ ] Web push notifications (later): subscribe per group + per device.

### 21) Scheduling + content calendar

- [ ] Scheduled posts (group-local queue) + approval + publish windows.
- [ ] Content calendar view (admin/mod): upcoming posts/events/announcements.
- [ ] Recurring events + automated reminder posts.

### 22) Reputation + trust signals

- [ ] Trust score (site-local): tenure, approvals, reports, engagement.
- [ ] Anti-spam gating: require phone/email verification (site-local) if desired.
- [ ] “Slow mode” auto-enable when spam spikes (rules engine).

### 23) Accessibility + inclusivity (group features)

- [ ] Alt-text enforcement for group-required media.
- [ ] Caption uploads for video (site-local) + transcript fields for events/units.
- [ ] Accessibility audit: keyboard nav for mod tools and forms.
