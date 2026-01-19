# ConcreteSky

ConcreteSky is a Concrete CMS (v9+) package that adds a Bluesky dashboard to your site.

It provides a single-page app (SPA) under a Concrete single page (default: `/concretesky`) and uses a local SQLite cache to make browsing/filtering fast.

It supports Bluesky OAuth (DPoP-bound tokens) and multiple Bluesky accounts per Concrete user.

If you want a PHP-first “Bluesky client inside ConcreteCMS” with operational tools for caching/backfill and long-running work handled via jobs, this is that project.

## Features

- SPA under a Concrete single page (`/concretesky` by default)
- Bluesky OAuth connect flow (stores tokens server-side; DPoP-bound)
- Multi-account switching (per Concrete user)
- Posts / Threads UI
   - Reply composer
   - Edit post (when supported by the Bluesky API/account)
   - Delete post
- Connections UI (followers / following)
   - Local cache for fast list browsing
   - Diffs between snapshots (added/removed)
   - Bulk follow queue helpers (durable + rate-limit aware)
- Notifications UI
   - Filtered views + local cache windows
   - Mark-seen helpers
- Local SQLite cache
   - Queryable catalogue of cached days (calendar coverage)
   - Backfill tools to build toward “full history” (posts + replies + notifications)
   - Basic catalogue management (status, prune, reset/resync)
- Scheduled posts (optional)
   - Server-side publisher job (runs via Concrete automated jobs)
- Groups (site-local community layer; optional/advanced)
   - “Facebook Groups, but for Bluesky” style membership/moderation UX
   - Group logic is site-local; Bluesky content remains public by nature
- Translation helpers (optional)
   - Inline “translate” UX and copy-to-clipboard support
   - Backend can be configured to call a translation service (for example LibreTranslate)
- Optional JWT mode for automation (bypass CSRF; optionally enforce JWT)

## What ConcreteSky is (and isn’t)

- ConcreteSky is a ConcreteCMS package, meant to be installed into an existing Concrete site.
- It is **not** a standalone server.
- It is **not** “privacy for Bluesky posts”. Anything posted to Bluesky is still public; ConcreteSky can only add site-local organization/moderation around it.

## Requirements

- Concrete CMS 9.x
- PHP with PDO SQLite enabled (`pdo_sqlite`)
- A writable cache directory for PHP-FPM (see “Local SQLite cache”)
- A publicly reachable OAuth client metadata route (see “Routes / Pages”)

## Routes / Pages

The package installs these single pages:

- `/concretesky` (SPA) — requires a logged-in Concrete user
- `/concretesky/api` (JSON API) — POST-only
- `/concretesky/oauth/client_metadata` — must be publicly reachable by Bluesky during OAuth
- `/concretesky/oauth/callback` — OAuth redirect landing page

If you move the single page in the Concrete dashboard, the OAuth URLs and API path are derived from the request path so the app keeps working.

## Install / Update

1. Copy this folder into your site at `packages/concretesky`.
2. Install the package:
   - `php concrete/bin/concrete5 c5:package-install concretesky`
3. When you change package code, bump the version in `controller.php` (`$pkgVersion`) and deploy:
   - `php concrete/bin/concrete5 c5:package-update concretesky`

## Quick start

1. Install the package (see “Install / Update”).
2. Confirm these URLs work in a browser:
   - `/concretesky` (requires login)
   - `/concretesky/oauth/client_metadata` (must be publicly reachable; returns JSON)
3. Visit `/concretesky` while logged into Concrete.
4. Click **Connect** and complete Bluesky OAuth.
5. Use the HUD and panels to browse cache or live network data.

## Usage

1. Log in to Concrete.
2. Visit `/concretesky`.
3. Use the UI Connect flow (OAuth) to attach a Bluesky account.
4. Use the account manager to switch between connected accounts (stored per Concrete user).

## UI tour

ConcreteSky is intentionally “single page”, but there are a few distinct surfaces:

- Profile HUD (top bar)
   - Account identity, quick search, and access to cache tools
   - Calendar button (`📅`) opens cache coverage + management
- Posts / Threads
   - View cached or network feeds (depending on HUD mode)
   - Create / reply / edit / delete actions (as available)
- Connections
   - Followers/following lists with cache-backed filtering and sorting
   - Snapshot diffs to see what changed between syncs
- Notifications
   - Cached notifications with filters and helper actions

The HUD search supports a compact query language; see `SEARCH.md` for the full reference.

### Cache tools: calendar + catalogue manager

The calendar icon (`📅`) in the Profile HUD opens a combined “coverage + management” modal:

- Coverage calendar by month (cached posts `P` and notifications `N`)
- Per-day drill-down showing cached rows
- Backfill actions to build coverage backward in time
- Catalogue management actions:
   - View cache status (counts/ranges and DB size)
   - Prune old data (keep last N days)
   - Reset/resync backfill state (optionally clear cached rows)

## Documentation

- UI/web-component + backend JSON API surfaces: `API.md`
- Panel system framework + utilities: `PANELS_API.md`
- Search router / HUD query language: `SEARCH.md`
- Roadmap / status: `TODO.md`

## API (how the SPA talks to PHP)

Canonical UI API documentation lives in `API.md` (this README includes only a short overview).

The frontend calls `/concretesky/api` with JSON like:

```json
{ "method": "getProfile", "params": { "actor": "did:plc:..." } }
```

Guards:

- The API is POST-only.
- Default browser flow requires `X-CSRF-Token` (Concrete token `bsky_api`).
- If a valid `Authorization: Bearer <jwt>` is present, CSRF is skipped.

Notable methods (see `controllers/single_page/concretesky/api.php` for the complete list):

- Auth/session: `authStatus`, `oauthStart`, `authLogout`, `authLogoutAll`
- Accounts: `accountsList`, `accountsSetActive`, `accountsRemove`
- Profiles: `getProfile`, `getProfiles`, `profilesHydrate`, `cacheGetProfiles`, `searchActors`
- Feeds/posts: `getTimeline`, `getAuthorFeed`, `getPosts`, `getPostThread`, `searchPosts`, `getFeed`, `createPost`, `deletePost`
- Social: `getFollowers`, `getFollows`, `getRelationships`, `follow`, `unfollow`, `block`, `unblock`, `mute`, `unmute`
- Bulk follows: `queueFollows`, `followQueueStatus`, `processFollowQueue`
   - Bulk follow actions are durable (queued in SQLite) and rate-limit aware.
- Notifications: `listNotifications`, `updateSeenNotifications`, `listNotificationsSince`, `followMany`
- Cache: `cacheStatus`, `cacheSync`, `cacheCalendarMonth` (+ other `cache*` helpers)
- Cache catalogue management: `cacheCatalogStatus`, `cacheCatalogPrune`, `cacheCatalogResync`

Notes:

- The API is intentionally “one endpoint with method switching” to keep Concrete routing simple.
- Many methods are intended for UI use (browser session + CSRF). Automation is supported via JWT (see below).

## Local SQLite cache

ConcreteSky stores its cache DB here by default:

- `packages/concretesky/db/cache.sqlite`

You can override the cache directory with:

- `CONCRETESKY_CACHE_DIR=/absolute/path`

Back-compat: if a legacy DB is found under `application/files/` (for example `application/files/bluesky_feed/cache.sqlite`), ConcreteSky will auto-migrate it into the new cache directory on first use.

**Production recommendation:** point `CONCRETESKY_CACHE_DIR` at a directory outside the web root (for example `/var/lib/concretesky`) and ensure it’s writable by the PHP-FPM user.

### What is cached?

The cache is a local SQLite “catalogue” that enables fast UI filtering/sorting without repeatedly calling the Bluesky network APIs.

At a high level it stores:

- Your author feed (posts + replies; depending on configured filter)
- Notifications
- Supporting metadata (sync timestamps, cursors, staleness markers)

### Cache coverage calendar (HUD `📅`)

The calendar modal is the primary operational view of cache coverage.

- Each day shows counts for cached posts (`P`) and notifications (`N`).
- The ring color indicates whether that day likely needs refresh/backfill based on the last cache sync timestamps.
- Clicking a day opens a detail panel showing cached rows for that day and provides backfill actions.

### Catalogue management (prune / resync)

The calendar modal also includes management controls:

- **Refresh**: reloads month coverage and catalogue status.
- **Prune**: delete rows older than a retention window (keep last N days). Optional `VACUUM` can compact the DB but may be slow.
- **Resync**: resets backfill state (and optionally clears cached rows) so you can rebuild the catalogue via backfill.

Notes:

- Prune/resync apply to the *currently active* connected Bluesky account.
- SQLite uses sidecar files (`-wal`, `-shm`) during writes; DB size reporting includes those.

### Backfill model (building toward full history)

ConcreteSky’s cache can be incrementally built over time. Backfill routines work backward in time until one of these happens:

- You reach the chosen stop date (for example “up to join day”)
- The API signals a retention limit (common for notifications)
- A rate limit forces a cooldown (the UI waits and continues)

The cache can be “good enough” without being complete; the calendar is designed to make gaps visible.

## Automated jobs (background processing)

ConcreteSky includes ConcreteCMS jobs for maintenance and long-running work.

- Cache maintenance: `jobs/concretesky_cache_maintenance.php`
   - Keeps `cache.sqlite` healthy/bounded (prune/vacuum style work).
   - Recommended even if you occasionally manage the catalogue from the UI.
- Follow queue processor: `jobs/concretesky_follow_queue_processor.php`
   - Drains queued follows server-side so it continues working even after the browser tab closes.
- Scheduled posts publisher: `jobs/concretesky_scheduled_posts_publisher.php`
   - Publishes posts that were queued/scheduled by the UI.

Run via CLI (cron-friendly):

- `php concrete/bin/concrete5 c5:job --list`
- `php concrete/bin/concrete5 c5:job concretesky_cache_maintenance`
- `php concrete/bin/concrete5 c5:job concretesky_follow_queue_processor`
- `php concrete/bin/concrete5 c5:job concretesky_scheduled_posts_publisher`

## Configuration (.env)

The API controller will read a site root `.env` file if present.

Start with:

```bash
cp packages/concretesky/.env.example .env
```

Key options:

- `BSKY_PDS` (default `https://bsky.social`) — which PDS to talk to
- `BSKY_DEBUG=1` — enables verbose server-side logging
- `BSKY_OAUTH_ISSUER` — optional issuer override for OAuth flows (usually leave unset)
- `CONCRETESKY_CACHE_DIR` — controls where the SQLite cache lives

Legacy/back-compat (not recommended for production):

- `BSKY_HANDLE` / `BSKY_APP_PASSWORD` — legacy env-based login (OAuth is the default)

Optional features:

- Translation:
   - ConcreteSky includes a translation UX; configure the backend via `.env.example`.
   - Primary env vars:
     - `CONCRETESKY_TRANSLATE_BACKEND` (`none` or `libretranslate`)
     - `CONCRETESKY_TRANSLATE_LIBRETRANSLATE_URL`
     - `CONCRETESKY_TRANSLATE_LIBRETRANSLATE_API_KEY` (optional)
   - If no translation backend is configured, the UI can still provide copy-to-clipboard helpers.

## Access control

By default, any logged-in Concrete user can open the SPA and call the API.

To restrict access (recommended for production), set one or more of:

- `CONCRETESKY_UI_REQUIRE_SUPERUSER=1` (only super users)
- `CONCRETESKY_UI_ALLOW_USERS=user1,user2` (Concrete usernames, comma-separated; numeric user IDs also accepted)
- `CONCRETESKY_UI_ALLOW_GROUPS=Administrators,SomeGroup` (Concrete group names, comma-separated)

Notes:

- The guard is applied consistently to the SPA (`/concretesky`) and the JSON API (`/concretesky/api`).
- The OAuth callback (`/concretesky/oauth/callback`) remains reachable, but will refuse to complete for users who do not pass the UI guard.

JWT mode (automation) is documented below; do not enable it unless you need it.

## Automation / JWT mode

If you enable JWT support (`CONCRETESKY_JWT_ENABLED=1`), callers can send:

- `Authorization: Bearer <token>`

and bypass CSRF.

Token helper:

```bash
php packages/concretesky/tools/jwt.php --user <concrete_username>
```

Optional hardening:

- `CONCRETESKY_JWT_ENFORCE=1` to require JWT for all API calls.

Recommended defaults:

- Keep `CONCRETESKY_JWT_REQUIRE_SUPERUSER=1` (default).
- Keep `CONCRETESKY_JWT_USERS` small and explicit.
- Keep `CONCRETESKY_MCP_LOGIN_ENABLED=0` unless you explicitly need it.

Optional (off by default): `mcpLogin` can convert a valid JWT into a Concrete session cookie for browser automation when `CONCRETESKY_MCP_LOGIN_ENABLED=1`.

## Groups (advanced)

ConcreteSky includes an optional “Groups” layer intended to feel like “Facebook Groups, but for Bluesky”.

Important constraints:

- This is **site-local** organization and moderation.
- Groups do **not** make Bluesky posts private.
- Closed/secret group semantics are enforced for site-local membership/admin flows, but content still lives on Bluesky.

If you’re building on group features, start with `API.md` (it documents the group-related UI API surface) and `TODO.md` for roadmap context.

## Development

ConcreteSky intentionally avoids a build step:

- ES modules served directly
- Entry: `js/main.js`
- Shell Web Component: `js/app/bsky_app.js`
- Most UI is Web Components under `js/components/` and the panel system under `js/panels/`

References:

- UI/web-component API surfaces: `API.md`
- Panel framework: `PANELS_API.md`
- HUD query language: `SEARCH.md`
- Roadmap: `TODO.md`

## Troubleshooting

- OAuth error `invalid_client_metadata`: Bluesky could not fetch `/concretesky/oauth/client_metadata`. Ensure that route is publicly reachable and returns JSON (HTTP 200).
- `PDO SQLite driver missing (pdo_sqlite)`: install/enable the PHP SQLite extension.
- `SQLite cache directory is not writable`: ensure the chosen cache directory is writable by PHP-FPM.
- Calendar opens but shows cache errors: check the API response for `cacheAvailable:false` / `cacheError` (the UI is designed to keep working even if the cache is temporarily unavailable).
- DB size seems “wrong”: SQLite may keep data in `cache.sqlite-wal` until a checkpoint; vacuum is optional and can be run by the maintenance job or via the UI.

## FAQ

### Does ConcreteSky make Bluesky content private?

No. Bluesky posts are public. ConcreteSky can add site-local organization (groups, moderation flows, queues) but cannot turn public Bluesky content into private content.

### Where are tokens stored?

OAuth tokens are stored server-side (ConcreteSky). Treat your Concrete database and server filesystem as sensitive.

## Scripts

- `./ai-dump.sh` creates a timestamped “AI dump” under `_private/dumps/`.
  - This is meant for local workflow only; `_private/` is gitignored.

## Release checklist

When preparing a change for deploy and/or GitHub release:

1. Verify secrets are not committed
   - Do not commit `.env` (only `.env.example`).
   - Keep `_private/` out of git.

2. Bump package version
   - Edit `controller.php` and increment `$pkgVersion`.

3. Sanity checks
   - PHP lint: `php -l controllers/single_page/concretesky/api.php`
   - Spot-check OAuth: hit `/concretesky/oauth/client_metadata` in an incognito window (should return JSON)

4. Deploy to Concrete
   - `php concrete/bin/concrete5 c5:package-update concretesky`

5. GitHub hygiene
   - Ensure `LICENSE` and `THIRD_PARTY_NOTICES.md` are up to date.
   - Update `TODO.md` if behavior/roadmap changed.

## Contributing

See `CONTRIBUTING.md`.

## Security

- Do not commit real `.env` files or secrets.
- If you enable JWT, keep `CONCRETESKY_JWT_SECRET` private and restrict `CONCRETESKY_JWT_USERS`.

## License

- Project: MIT (see `LICENSE`).
- Third-party licenses: see `THIRD_PARTY_NOTICES.md`.
