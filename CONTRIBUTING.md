# Contributing

Thanks for contributing to ConcreteSky.

## Repo layout

This repo is intended to contain the ConcreteSky package folder contents (the code that normally lives at `packages/concretesky/` in a Concrete site).

## Documentation expectations

ConcreteSky keeps its canonical docs in the package folder so they can ship alongside the code.

When you change behavior, please update the matching docs:

- UI/web-component + backend JSON API surfaces: `API.md`
- Panel system contract: `PANELS_API.md`
- Search router / HUD query language: `SEARCH.md`

If you add or change environment variables, update:

- `.env.example`
- `README.md` (and `API.md` if it affects jobs/rate limits)

## Development workflow

- Prefer small, focused PRs.
- Keep changes consistent with the existing style.
- Avoid drive-by refactors.

## Versioning / deployment

ConcreteCMS packages require a version bump to publish updated assets.

1. Bump `controller.php` (`$pkgVersion`).
2. Deploy on a Concrete site:
   - `php concrete/bin/concrete5 c5:package-update concretesky`

## Safety / secrets

- Never commit real `.env` files or secrets.
- Keep `_private/` out of git (AI dumps, local notes).

## Lint / checks

At minimum:

- PHP: `php -l controllers/single_page/concretesky/api.php`

If you changed auth/session behavior, also lint:

- PHP: `php -l controllers/single_page/concretesky.php`

If you change frontend behavior, please also spot-check the SPA in a browser.

If you changed background processing (jobs, follow queue, cache maintenance), run the jobs once via CLI:

- `php concrete/bin/concrete5 c5:job concretesky_cache_maintenance`
- `php concrete/bin/concrete5 c5:job concretesky_follow_queue_processor`

## Licensing

- ConcreteSky is MIT licensed (see `LICENSE`).
- If you add/update bundled third-party code, update `THIRD_PARTY_NOTICES.md` with the license text.
