# AI Tests (ConcreteSky)

This file is a living checklist for MCP/agent-driven testing.

## Preconditions

- Site root `.env` contains (or equivalent):
  - `CONCRETESKY_JWT_ENABLED=1`
  - `CONCRETESKY_JWT_SECRET=...`
  - `CONCRETESKY_JWT_USERS=tbi`
  - `CONCRETESKY_MCP_LOGIN_ENABLED=1`
- If `tbi` is **not** a Concrete “super user” on this site, set:
  - `CONCRETESKY_JWT_REQUIRE_SUPERUSER=0`

## Test 1 — JWT minting

From site root:

- `php packages/concretesky/tools/jwt.php --user tbi --ttl 120 >/dev/null && echo OK`

Expected:
- Exit code 0.

## Test 2 — mcpLogin establishes Concrete session cookie (curl)

- `COOKIE=/tmp/csky-cookies.txt`
- `TOKEN=$(php packages/concretesky/tools/jwt.php --user tbi --ttl 120)`
- `curl -sS -c "$COOKIE" -b "$COOKIE" -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -X POST --data '{"method":"mcpLogin","params":{"userName":"tbi"}}' https://www.theblobinc.com/concretesky/api`

Expected:
- JSON `{ "ok": true, ... }`

## Test 3 — cookie avoids /login redirect

- `curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' -b /tmp/csky-cookies.txt https://www.theblobinc.com/concretesky`

Expected:
- `200` and empty redirect URL.

## Test 4 — authStatus (cookie)

 `TOKEN=$(php packages/concretesky/tools/jwt.php --user tbi --ttl 120)`
 `curl -sS -b /tmp/csky-cookies.txt -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -X POST --data '{"method":"authStatus","params":{}}' https://www.theblobinc.com/concretesky/api`

Expected:
- `c5.registered=true`, `c5.userName=tbi`.

## Test 5 — authStatus (JWT-only)

- `TOKEN=$(php packages/concretesky/tools/jwt.php --user tbi --ttl 120)`
- `curl -sS -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -X POST --data '{"method":"authStatus","params":{}}' https://www.theblobinc.com/concretesky/api`

Expected:
- `c5.registered=true`, `c5.userName=tbi`.

## Test 6 — Disabled mcpLogin returns 404

Set in site root `.env`:

- `CONCRETESKY_MCP_LOGIN_ENABLED=0`

Then:

- `TOKEN=$(php packages/concretesky/tools/jwt.php --user tbi --ttl 120)`
- `curl -sS -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -X POST --data '{"method":"mcpLogin","params":{"userName":"tbi"}}' https://www.theblobinc.com/concretesky/api`

Expected:
- HTTP 404 with `{ "error": "Not Found" }`

Re-enable after:

- `CONCRETESKY_MCP_LOGIN_ENABLED=1`

## Test 7 — Playwright/MCP auto-login hook

Goal: prove an agent can authenticate and then browse `/concretesky` without hitting `/login`.

High-level steps:

1. Open `https://www.theblobinc.com/`.
2. Run `fetch('/concretesky/api', {method:'POST', credentials:'include', Authorization: Bearer <JWT>, body:{method:'mcpLogin'}})`.
3. Navigate to `https://www.theblobinc.com/concretesky`.

Expected:
- Page title is `ConcreteSky :: theblobinc`.
- The page header shows `Log out` (not `Log in`).
- The app loads posts/notifications without prompting for Concrete login.

Helper files:
- `packages/concretesky/_private/mcp/auto-login-snippet.js`
- `packages/concretesky/_private/mcp/auto-login-playwright.mjs`

## Test 8 — Multi-panel grid fit (Posts + Connections)

Goal: verify Posts + Connections can be shown together and their card entries still fit cleanly (no clipping/overflow).

High-level steps:

1. Complete Test 7 (session cookies set).
2. Navigate to `https://www.theblobinc.com/concretesky#tabs=posts,connections`.
3. Scroll both panels a bit; trigger a load-more (infinite scroll) in Posts.

Expected:

- No horizontal overflow/clipping within the Posts or Connections lists.
- Cards reflow naturally as panel widths change (no JS-driven masonry repositioning).

Notes:

- If you previously dragged panel resize handles, you can click the UI button `Reset layout` before re-testing.

## Test 9 — CSRF still required for browser callers without JWT

- Without sending `Authorization: Bearer ...` and without a valid `X-CSRF-Token`, call any API method.

Expected:
- HTTP 403 `{ "error": "Bad CSRF" }`

## Test 10 — Security sanity checks

- Ensure `CONCRETESKY_MCP_LOGIN_ALLOW_IMPERSONATE=0` unless explicitly needed.
- If you enable impersonation, verify that non-super JWTs cannot impersonate.

