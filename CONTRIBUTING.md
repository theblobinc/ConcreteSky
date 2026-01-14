# Contributing

Thanks for contributing to ConcreteSky.

## Repo layout

This repo is intended to contain the ConcreteSky package folder contents (the code that normally lives at `packages/concretesky/` in a Concrete site).

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

If you change frontend behavior, please also spot-check the SPA in a browser.

## Licensing

- ConcreteSky is MIT licensed (see `LICENSE`).
- If you add/update bundled third-party code, update `THIRD_PARTY_NOTICES.md` with the license text.
