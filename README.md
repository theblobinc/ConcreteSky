# ConcreteSky

ConcreteSky is a Concrete CMS (v9+) package that provides a single-page app for working with Bluesky account data (posts, connections, notifications) with a local SQLite cache for fast filtering/sorting.

## Features

- Posts + Connections UIs (MagicGrid layout)
- Notifications UI with follow/unfollow indicator
- Database Manager for bulk import/backfill
- Calendar coverage + per-day staleness (last ingested) indicators
- Optional JWT auth mode for automation (see `tools/jwt.php` and `.env.example`)

## Requirements

- Concrete CMS 9.x
- PHP with SQLite enabled
- A Bluesky session (OAuth via the package UI)

## Install

1. Copy this folder into your site at `packages/concretesky`.
2. Install the package:
   - `php concrete/bin/concrete5 c5:package-install concretesky`
3. When you change package code, bump the version in `controller.php` (`$pkgVersion`) and deploy:
   - `php concrete/bin/concrete5 c5:package-update concretesky`

## Development notes

- API controller: `controllers/single_page/concretesky/api.php`
- Frontend entry: `js/main.js` and Web Components under `js/components/`
- Local cache: SQLite file created under your Concrete writable storage (managed by the API controller)

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
   - (Optional) run the site and spot-check the SPA.

4. Deploy to Concrete
   - `php concrete/bin/concrete5 c5:package-update concretesky`

5. GitHub hygiene
   - Ensure `LICENSE` and `THIRD_PARTY_NOTICES.md` are up to date.
   - Update `TODO.md` if behavior/roadmap changed.

## Contributing

See `CONTRIBUTING.md`.

## Security

- Do not commit real `.env` files or secrets.
- If you enable JWT auth, keep `CONCRETESKY_JWT_SECRET` private and restrict allowed users.

## License

- Project: MIT (see `LICENSE`).
- Third-party licenses: see `THIRD_PARTY_NOTICES.md` (includes MagicGrid).
