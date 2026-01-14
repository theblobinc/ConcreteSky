# AI Instructions (ConcreteSky Package)

These are local workflow rules for making changes to this Concrete CMS package.

## Defaults

- **Package handle/folder:** `concretesky`
- **Version lives in:** `packages/concretesky/controller.php` (`$pkgVersion`)
- **Concrete CMS CLI:** `./concrete/bin/concrete5` (v9)

## ConcreteCMS CLI commands (c5 namespace)

This site is currently running Concrete CMS `9.4.7`.

- List commands: `./concrete/bin/concrete5 list c5`
- Export JSON: `./concrete/bin/concrete5 list c5 --format=json`

### Commands

- `c5:boards:refresh`
- `c5:clear-cache`
- `c5:compare-schema`
- `c5:config`
- `c5:database:charset:set`
- `c5:database:foreignkey:fix`
- `c5:denylist:clear`
- `c5:entities:refresh`
- `c5:exec`
- `c5:express:export`
- `c5:files:generate-identifiers`
- `c5:ide-symbols`
- `c5:info`
- `c5:install`
- `c5:is-installed`
- `c5:job`
- `c5:language-install` (alias: `c5:install-language`)
- `c5:package:install` (aliases: `c5:package-install`, `c5:install-package`)
- `c5:package:pack` (aliases: `c5:package-pack`, `c5:pack-package`)
- `c5:package:translate` (aliases: `c5:package-translate`, `c5:translate-package`)
- `c5:package:uninstall` (aliases: `c5:package-uninstall`, `c5:uninstall-package`)
- `c5:package:update` (aliases: `c5:package-update`, `c5:update-package`)
- `c5:phpcs`
- `c5:rescan-files`
- `c5:reset`
- `c5:service`
- `c5:sitemap:generate`
- `c5:theme:install`
- `c5:update`
- `c5:user-group:bulk-assign-users`

## Sudo + permissions (important)

- Before running any `sudo` commands in a session, run:
  - `sudo -v`

- When running commands that modify files or run the Concrete CMS CLI, run them as the site user/group:
  - `sudo -u tbi -g tbi <command>`

Examples:

- `sudo -u tbi -g tbi ./concrete/bin/concrete5 c5:package:update concretesky`

## REQUIRED after any package change

1. Increment the package version in `packages/concretesky/controller.php`:
   - Update `$pkgVersion` (e.g. `0.1.6` → `0.1.7`).

2. Update the installed package in Concrete CMS:
   - `sudo -v`
  - `sudo -u tbi -g tbi ./concrete/bin/concrete5 c5:package:update concretesky`

## Package rename (done)

This package was renamed from `bluesky_feed` to `concretesky`.

- Concrete CMS stores the installed package handle in the database.
- To switch an existing site from the old handle to the new one, uninstall the old package and install the new package.

Suggested migration commands:

- `sudo -v`
- `sudo -u tbi -g tbi ./concrete/bin/concrete5 c5:package:uninstall bluesky_feed`
- `sudo -u tbi -g tbi ./concrete/bin/concrete5 c5:package:install concretesky`
- `sudo -u tbi -g tbi ./concrete/bin/concrete5 c5:package:update concretesky`

## Optional JWT auth (MCP / automation)

ConcreteSky supports an optional JWT (HS256) auth mode for programmatic callers (MCP, scripted tests).

### Setup

1. Create a `.env` at the site root:
  - Copy from `.env.example` and fill values.

2. Set these keys:
  - `CONCRETESKY_JWT_ENABLED=1`
  - `CONCRETESKY_JWT_SECRET=<long random secret>`
  - `CONCRETESKY_JWT_USERS=tbi` (comma-separated usernames)
  - `CONCRETESKY_JWT_REQUIRE_SUPERUSER=1` (recommended)
    - If your service user is not marked as a Concrete "Super User" (for example, `tbi` on this site), set this to `0`.

3. (Optional) Enable the JWT → ConcreteCMS session bridge (for browser automation):
  - `CONCRETESKY_MCP_LOGIN_ENABLED=1`
  - (Optional, dangerous) `CONCRETESKY_MCP_LOGIN_ALLOW_IMPERSONATE=1`

3. Generate a token:
  - `php packages/concretesky/tools/jwt.php --user tbi`

### Creating a ConcreteCMS login session (cookie)

JWT auth is enough for API calls, but browser automation (Playwright/MCP) usually needs an actual ConcreteCMS session cookie so that `GET /concretesky` doesn’t redirect to `/login`.

ConcreteSky provides an **opt-in** API method that converts a valid JWT into a ConcreteCMS session:

- Endpoint: `POST /concretesky/api`
- Body: `{ "method": "mcpLogin", "params": { "userName": "tbi" } }`
- Header: `Authorization: Bearer <token>`

Local helper scripts live under:

- `packages/concretesky/_private/mcp/` (gitignored)

Example (cookie jar):

- `bash packages/concretesky/_private/mcp/login-cookie.sh --base https://www.theblobinc.com --user tbi`

If enabled, this will write a `cookies.txt` you can reuse for subsequent requests.

### Using the token

- Send requests to the API endpoint with:
  - Header: `Authorization: Bearer <token>`
  - Body: JSON `{ "method": "...", "params": { ... } }`

Notes:
- JWT auth bypasses CSRF, but still scopes data to the Concrete user in `sub`.
- If you want to *require* JWT for all API calls, set `CONCRETESKY_JWT_ENFORCE=1`.

Security notes:
- Keep `CONCRETESKY_MCP_LOGIN_ENABLED=0` in production unless you explicitly need automation.
- Keep `CONCRETESKY_JWT_USERS` small (service accounts only).
- Only enable `CONCRETESKY_MCP_LOGIN_ALLOW_IMPERSONATE` when you fully control the environment.
