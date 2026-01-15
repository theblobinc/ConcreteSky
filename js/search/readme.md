This folder contains the HUD-driven search router.

- `query.js`: parses a lightweight query language and compiles a matcher (used by panels for client-side filtering).
- `search_bus.js`: global event used by panels to react to HUD search changes.

## Query syntax (v1)

- AND is the default: `foo bar`
- OR with `OR` or `|`: `foo OR bar` / `foo | bar`
- Negation: `-foo` or `NOT foo`
- Quoted phrases: `"multi word"`
- Field filters: `field:value` with negation `-field:value`
- Regex mode: `/pattern/i` (client-side; pattern length and flags are validated)

### Fuzzy matching

Fuzzy matching is client-side only.

- Prefix a term or field value with `~`:
	- `~blobinc`
	- `handle:~blob`
- Or enable globally with `fuzzy:true`:
	- `fuzzy:true blob inc`

Fuzzy match is a simple ordered-subsequence match (fast, no dependencies).

## Field mapping (what panels currently expose)

These are the fields passed into the matcher as `fields`.

- People (Connections panel):
	- `handle`, `did`
- Posts:
	- `type` (one of `post|reply|repost`)
	- `uri`
- Notifications:
	- `reason` (ex: `like`, `reply`, `follow`)
	- `subject` (usually an `at://...` URI)
	- `uri`
	- `handle`, `did`

## HUD filters (payload)

The profile HUD dispatches `BSKY_SEARCH_EVENT` with:

- `targets`: `people`, `posts`, `notifications`
- `mode`: `cache` or `network`
- `filters`:
	- `people`: `{ list: 'all'|'followers'|'following', sort: 'followers'|'following'|'posts'|'age'|'name'|'handle', mutual: boolean }`
	- `posts`: `{ types: ['post','reply','repost'] }`
	- `notifications`: `{ reasons: ['follow','like','reply','repost','mention','quote','subscribed-post','subscribed'] }`

## Backend search API (JWT-friendly)

Panels can optionally use the backend `search` method to query beyond what is currently loaded.

Endpoint: `/concretesky/api` (JSON-RPC POST).

- With a valid JWT (`Authorization: Bearer <token>`), CSRF is bypassed.
- Without JWT, the API expects the standard CSRF token flow.
- Note: results are still scoped to the Concrete user in the JWT `sub` and require an existing Bluesky session server-side.

### Params

- `q`: query string
- `mode`: `cache` or `network`
- `targets`: any of `['people','posts','notifications']`
- `limit`: max items per target (server clamps to 200)
- `hours`: cache window for posts/notifications
- `postTypes`: optional array for posts (ex: `['post','reply']`)
- `reasons`: optional array for notifications

### Example (cache search notifications)

```bash
TOKEN=$(php packages/concretesky/tools/jwt.php --user tbi --ttl 120)

curl -sS \
	-H 'Content-Type: application/json' \
	-H "Authorization: Bearer $TOKEN" \
	-X POST \
	--data '{"method":"search","params":{"q":"reason:like -handle:spam","mode":"cache","targets":["notifications"],"reasons":["like","reply"],"hours":720,"limit":100}}' \
	https://<site>/concretesky/api
```

### Example (network search people)

```bash
TOKEN=$(php packages/concretesky/tools/jwt.php --user tbi --ttl 120)

curl -sS \
	-H 'Content-Type: application/json' \
	-H "Authorization: Bearer $TOKEN" \
	-X POST \
	--data '{"method":"search","params":{"q":"blob inc","mode":"network","targets":["people"],"limit":50}}' \
	https://<site>/concretesky/api
```
