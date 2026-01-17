# ConcreteSky

ConcreteSky is a Concrete CMS (v9+) package that provides a single-page Bluesky dashboard (posts, connections, notifications) with a local SQLite cache for fast filtering/sorting.

It supports Bluesky OAuth (DPoP-bound tokens) and multiple Bluesky accounts per Concrete user.

## Features

- SPA under a Concrete single page (`/concretesky` by default)
- Bluesky OAuth connect flow (stores tokens server-side)
- Multi-account switching (per Concrete user)
- Posts / Threads UI (includes reply composer)
- Connections UI (followers / following) with local cache + diffs
- Notifications UI (including filtered windows + bulk follow helpers)
- Local SQLite cache with snapshot + staleness metadata
- Optional JWT mode for automation (bypass CSRF; optionally enforce JWT)

## Requirements

- Concrete CMS 9.x
- PHP with PDO SQLite enabled (`pdo_sqlite`)
- A writable Concrete application files directory

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

## Usage

1. Log in to Concrete.
2. Visit `/concretesky`.
3. Use the UI Connect flow (OAuth) to attach a Bluesky account.
4. Use the account manager to switch between connected accounts (stored per Concrete user).

## API (how the SPA talks to PHP)

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
- Notifications: `listNotifications`, `updateSeenNotifications`, `listNotificationsSince`, `followMany`
- Cache: `cacheStatus`, `cacheSync` (+ other `cache*` helpers)

## Local SQLite cache

ConcreteSky stores its cache DB here by default:

- `application/files/concretesky/cache.sqlite`

You can change the subdirectory name with:

- `BSKY_STORAGE_SUBDIR=concretesky`

Back-compat: if `application/files/bluesky_feed/` exists and `BSKY_STORAGE_SUBDIR` is left at the default, ConcreteSky will continue using the legacy directory.

## Configuration (.env)

The API controller will read a site root `.env` file if present.

Start with:

```bash
cp packages/concretesky/.env.example .env
```

Key options:

- `BSKY_PDS` (default `https://bsky.social`)
- `BSKY_DEBUG=1` (enables verbose API logging)
- `BSKY_STORAGE_SUBDIR` (controls where the SQLite cache lives)

JWT / automation options are documented in `.env.example`.

## UI access control (optional)

By default, any logged-in Concrete user can open the SPA and call the API.

To restrict access (recommended for production), set one or more of:

- `CONCRETESKY_UI_REQUIRE_SUPERUSER=1` (only super users)
- `CONCRETESKY_UI_ALLOW_USERS=user1,user2` (Concrete usernames, comma-separated; numeric user IDs also accepted)
- `CONCRETESKY_UI_ALLOW_GROUPS=Administrators,SomeGroup` (Concrete group names, comma-separated)

Notes:

- The guard is applied consistently to the SPA (`/concretesky`) and the JSON API (`/concretesky/api`).
- The OAuth callback (`/concretesky/oauth/callback`) remains reachable, but will refuse to complete for users who do not pass the UI guard.

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

## Frontend architecture

- ES modules, no build step.
- Entry: `js/main.js`
- Top-level shell Web Component: `js/app/bsky_app.js`
- Most UI is Web Components under `js/components/` and the panel system under `js/panels/`.
- Panel framework docs: `js/panels/API.md`

## Troubleshooting

- OAuth error `invalid_client_metadata`: Bluesky could not fetch `/concretesky/oauth/client_metadata`. Ensure that route is publicly reachable and returns JSON (HTTP 200).
- `PDO SQLite driver missing (pdo_sqlite)`: install/enable the PHP SQLite extension.
- `SQLite cache directory is not writable`: ensure `application/files/` (and the chosen subdir) is writable by PHP.

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
- Third-party licenses: see `THIRD_PARTY_NOTICES.md` (includes MagicGrid).
