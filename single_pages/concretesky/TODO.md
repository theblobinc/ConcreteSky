# ConcreteSky (ConcreteCMS v9) — TODO

## Status (2026-01)

This file is largely a historical planning doc. Most of the Phase 0/1 items here are implemented now (tabs/panels, SQLite cache, snapshots/diffs, calendar coverage, backfills).

Current actionable work is tracked in the top-level package TODO: `packages/concretesky/TODO.md`.

## Goals
- Make the SPA a useful “local analyst’s console” for Bluesky data (followers, following, posts, notifications).
- Add a local SQLite cache so the SPA can sort/filter/search without re-fetching everything.
- Track changes over time (adds/removals, mutuals, suspicious patterns) to support AI workflows.

## Phase 0 — UI improvements (no DB yet)
- [ ] Replace two-column layout with tabs:
  - [x] My Posts
  - [x] Notifications
  - [ ] Followers
  - [ ] Following
  - [ ] Search
- [ ] Persist selected tab (URL hash + localStorage)
- [ ] Add a “People” table-style list UI:
  - [ ] Sort by: name/handle, followersCount, followsCount, postsCount, account age (createdAt when available)
  - [ ] Filter: show only mutuals / only not-mutuals
  - [ ] Quick search (client-side) across handle/displayName/description (supports emoji)
- [ ] Improve loading/error states across components
- [ ] Add a compact themeable style system (CSS vars)

## Phase 1 — SQLite cache (server-side)

### Storage location
- Use a writable Concrete path (recommended): `application/files/concretesky/`.
- SQLite file: `application/files/concretesky/cache.sqlite`.

You can override the subdir name via env var `BSKY_STORAGE_SUBDIR`.

### Schema (proposal)
- `meta(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`
- `profiles(did TEXT PRIMARY KEY, handle TEXT, display_name TEXT, description TEXT, created_at TEXT, followers_count INT, follows_count INT, posts_count INT, raw_json TEXT, updated_at TEXT)`
- `followers(actor_did TEXT, follower_did TEXT, snapshot_at TEXT, PRIMARY KEY(actor_did, follower_did, snapshot_at))`
- `follows(actor_did TEXT, follows_did TEXT, snapshot_at TEXT, PRIMARY KEY(actor_did, follows_did, snapshot_at))`
- `notifications(id TEXT PRIMARY KEY, indexed_at TEXT, reason TEXT, author_did TEXT, reason_subject TEXT, raw_json TEXT)`
- (optional) `posts(uri TEXT PRIMARY KEY, author_did TEXT, created_at TEXT, text TEXT, raw_json TEXT)`

### Full‑text search
- Prefer SQLite FTS5 when available:
  - `profiles_fts` over `handle`, `display_name`, `description`
  - Keep in sync with `profiles` (triggers or application-side upserts)

### Sync behavior
- [ ] “Refresh” triggers server sync:
  - Fetch my profile → determine `me_did`
  - Fetch followers/follows (paginated)
  - Upsert all profiles encountered
  - Save follower/follow edges for a new snapshot timestamp
  - Fetch notifications window (e.g., 7–30 days) and upsert
- [ ] Compute diffs vs prior snapshot:
  - Added followers / removed followers
  - Added mutuals / removed mutuals
  - Show counts + list top changes

### API endpoints (proposal)
Add new methods to the existing JSON POST controller:
- `cacheSync` → runs sync and returns summary counts
- `cacheQueryPeople` → filtered/sorted paginated people list from SQLite
- `cacheFriendDiff` → returns added/removed follower/follow/mutuals since last snapshot

## Phase 2 — Suspicious-account signals (for AI)
- [ ] Feature engineering ideas:
  - Account age bucket (days since created)
  - Follower/following ratio
  - “Follows you but you don’t follow back” / vice versa
  - Sudden follower spikes (snapshot deltas)
  - Text similarity / emoji-heavy bios (queryable via FTS)
- [ ] Export datasets:
  - CSV/JSON export endpoints
  - “Top N suspicious” views

## Security & ops
- [ ] Remove hardcoded defaults for credentials (use env vars only)
- [ ] Rate-limit and/or throttle sync calls to avoid Bluesky rate limits
- [ ] Access control: restrict SPA to admin/whitelisted users
- [ ] Avoid storing sensitive tokens in SQLite; store only derived public data
