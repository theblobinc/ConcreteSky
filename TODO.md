# TODO (ConcreteSky)

This is the top-level TODO for the package (GitHub-facing). A more detailed/legacy planning doc also exists at `single_pages/concretesky/TODO.md`.

## High priority

- Add an explicit “Deep notifications backfill” status view (server retention varies).
- Add month-level bulk actions (select month(s), refresh/backfill per kind).
- Add better progress stats (rows inserted/updated) for notification backfill.

## UX / Quality

- Persist calendar selections (optional).
- Add staleness threshold configuration (what counts as “stale”).
- Improve error messages when rate-limited by Bluesky.

## Data / Cache

- Add optional FTS search for profiles/posts.
- Add export tools (CSV/JSON) for cached datasets.

## Security

- Add configurable access-control guard for the SPA (admin/whitelist).
