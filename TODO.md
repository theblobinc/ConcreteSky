# TODO (ConcreteSky)

This is the top-level TODO for the package (GitHub-facing).

## North Star

Build “Facebook Groups, but for Bluesky”: community spaces (membership + moderation + discovery + admin tooling) powered by AT Protocol identities and content, delivered as a PHP-first package with Web Components so it can embed into most PHP websites with minimal integration.

Principles:

- Web Components first: the UI should be portable across PHP sites.
- One shared controller per behavior: panels stay thin; reusable logic lives in `js/controllers/*`.
- Durable background work: rate-limit and maintenance work should keep running via ConcreteCMS jobs (and later, cron for non-Concrete hosts).
- Cache-first UX: use SQLite for fast browsing/filtering; fall back to network when needed.

## Parity targets

- Bluesky client parity: core posting, reading, engagement, moderation, and account management.
- Facebook Groups parity: group spaces, membership/roles, moderation queue, units/guides, events, announcements, and insights.

## Already done (implemented)

- Tabs/panels system with persistence (`bsky_active_tabs` in localStorage + `#tabs=...` hash) + drag ordering + resize.
- SQLite cache (profiles, follower/following snapshots + diffs, notifications, posts) with migrations + schema versioning.
- Cache/ops endpoints: `cacheStatus`, `cacheSync`, `cacheSyncRecent`, `cacheQueryPeople`, `cacheFriendDiff`, `cacheQueryNotifications`, `cacheQueryMyPosts`.
- Calendar coverage API + UI: `cacheCalendarMonth` + DB Manager calendar view.
- Social HUD: cache coverage calendar icon (ring indicator: up-to-date / partial / needs update + pre-join grey), click day for summary + backfill actions.
- Shared cache settings lightbox: usable from Social HUD and notification bar settings; leverages DB Manager calendar for drill-down + range backfill tooling.
- Backfill tooling:
	- Posts: `cacheBackfillMyPosts`
	- Notifications: `cacheBackfillNotifications`
	- UI wiring exists (DB Manager + Cache Status components)
- “Month-level bulk actions” via calendar selection + range backfill/refresh.

## No longer needed / superseded

- Separate “Search tab” (superseded by in-panel search/filtering and the shared search utilities; consider adding a dedicated Search panel only if it provides extra value).
- “Remove hardcoded defaults for credentials” (OAuth is the default; legacy env-based handle/app-password is not required).

## Next (prioritized)

## Panels roadmap (canonical)

This section was previously maintained in `packages/concretesky/js/panels/TODO.md`.
It has been merged into this file so there is a single source of truth.

### Planned features

- [x] Panel API docs: keep `API.md` current as new hooks are added.
- [x] Standardize stable keys: all list-like components should use `data-k` for scroll anchoring.
- [x] Windowing (virtualized lists) for long lists to reduce DOM size. (true DOM windowing implemented via `ListWindowingController` across notifications, connections, followers/following, feed, notification bar, and my posts)
- [x] Better “exhausted” UX for infinite scroll (explicit end-of-feed states per panel). (implemented via `renderListEndcap()` and adopted across notifications, connections, followers/following, feed, notification bar, and my posts)
- [x] Centralized error/toast reporting for load failures (common hook).
- [x] Persist per-panel scroll position across tab switches (opt-in).

This is the roadmap for improving the ConcreteSky panel system and adding upcoming UI features (notifications, commenting, threaded rendering, and a content/details panel).

### Goals

- Keep the SPA within 100% viewport width at all times (no horizontal overflow).
- Panels should reduce columns as space shrinks, down to a single primary column.
- On mobile, users should swipe horizontally between panels.
- Panels should be modular: shared layout, shared UX APIs, pluggable menus/controls.
- Support adding new panels later by dropping in a template module.

### Panel System Stabilization (Do First)

#### 1) Make sizing rules consistent and predictable
- Ensure a single source of truth for:
	- card width: `--bsky-card-w`
	- card gap: `--bsky-card-gap`
	- panel density: `--bsky-panel-pad(-dense)` etc
- Note: theme preferences now support a “comfortable” density mode by overriding the `--bsky-panel-*-dense` tokens.
- Verify panel sizing logic aligns with the new `<bsky-panel-shell dense>` (avoid “extra padding models” drifting).

#### 2) Mobile behavior (no overflow)
- Mobile mode is “one panel per screen”:
	- `.panel { flex: 0 0 100%; min-width: 100%; }`
	- horizontal scroll + `scroll-snap`
- Ensure stored panel widths never apply on mobile.

#### 3) Reduce “layout regression” risk
- Add a small debug helper (optional) to log:
	- panelsWrap width
	- each panel’s flex-basis + measured width
	- card width/gap
- Add a single “reset layout” escape hatch (already exists) and confirm it also resets any new panel keys.

### Panel Templates / Registry (Foundation)

#### 4) Standardize panel templates
- Templates live in: `packages/concretesky/js/panels/templates/`
- Each template exports:
	- `name` (must match `data-tab` / `data-panel`)
	- `title` (tab label)
	- `mountHtml` (rendered when active)
	- optional `defaultActive`

Example template:

```js
// packages/concretesky/js/panels/templates/notifications.js
export default {
	name: 'notifications',
	title: 'Notifications',
	mountHtml: '<bsky-notifications></bsky-notifications>',
	defaultActive: false,
};
```

#### 5) Standardize panel utilities
- Shared utilities live in: `packages/concretesky/js/panels/panel_api.js`
- Keep it framework-free; provide small helpers panels can share:
	- `registerPanelTemplate()` / `getPanelTemplates()`
	- `getDefaultActiveTabs()`
	- `debounce(fn, ms)`
	- `bindNearBottom(scroller, cb, { threshold, enabled })`
	- `isMobilePanelsViewport()`

Example usage:

```js
// inside a panel that uses <bsky-panel-shell>
import { bindNearBottom } from '../panels/panel_api.js';

const scroller = this.shadowRoot.querySelector('bsky-panel-shell')?.getScroller?.();
this._unbindNearBottom?.();
this._unbindNearBottom = bindNearBottom(scroller, () => this.load(false), {
	threshold: 220,
	enabled: () => !this.loading && this.hasMore,
});
```

### Notifications Panel (High Priority)

#### 6) Add a Notifications panel template
- Add: `packages/concretesky/js/panels/templates/notifications.js`
- Register in `panel_api.js`

Code:

```js
// packages/concretesky/js/panels/panel_api.js
import notifications from './templates/notifications.js';
registerPanelTemplate(notifications);
```

#### 7) Implement `<bsky-notifications>` component
- File: `packages/concretesky/js/components/notifications.js` (already exists but needs “panel shell parity” and UX).
- Requirements:
	- Display grouped/filtered notifications (mentions, replies, likes, reposts, follows).
	- Mark as read/unread.
	- Click notification -> open associated post/thread in content panel.
	- Pagination + infinite scroll.
	- Optional polling interval or manual refresh.

Skeleton:

```js
// packages/concretesky/js/components/notifications.js
import { call } from '../api.js';
import { bindNearBottom, debounce } from '../panels/panel_api.js';

class BskyNotifications extends HTMLElement {
	constructor(){
		super();
		this.attachShadow({ mode: 'open' });
		this.items = [];
		this.loading = false;
		this.cursor = null;
		this.hasMore = false;
		this.filters = { q: '', types: new Set(['all']) };
		this._unbindNearBottom = null;
	}

	connectedCallback(){
		this.render();
		this.load(true);
	}

	async load(reset){
		// TODO: implement via ConcreteSky API (cache + network modes as needed)
		// const out = await call('cacheQueryNotifications', { ... })
	}

	openItem(item){
		const uri = item?.uri;
		if (!uri) return;
		this.dispatchEvent(new CustomEvent('bsky-open-content', {
			detail: { kind: 'post', uri },
			bubbles: true,
			composed: true,
		}));
	}

	render(){
		this.shadowRoot.innerHTML = `
			<bsky-panel-shell title="Notifications" dense>
				<div slot="toolbar">TODO filters/search</div>
				<div>TODO list</div>
			</bsky-panel-shell>
		`;

		const scroller = this.shadowRoot.querySelector('bsky-panel-shell')?.getScroller?.();
		this._unbindNearBottom?.();
		this._unbindNearBottom = bindNearBottom(scroller, () => this.load(false), {
			enabled: () => !this.loading && this.hasMore,
		});
	}
}

customElements.define('bsky-notifications', BskyNotifications);
```

Acceptance criteria:
- Loads fast from cache/DB.
- Does not reflow panels unexpectedly.
- Works as a single swipe panel on mobile.

### Content Panel (Post Details) (High Priority)

#### 8) Add a “content” panel template
- Template: `packages/concretesky/js/panels/templates/content.js`
- Mounted component: `<bsky-content-panel>` (new).

Template:

```js
// packages/concretesky/js/panels/templates/content.js
export default {
	name: 'content',
	title: 'Content',
	mountHtml: '<bsky-content-panel></bsky-content-panel>',
	defaultActive: false,
};
```

#### 9) Behavior: click a post -> open content panel
- In Posts panel:
	- Clicking a post (excluding links/buttons) selects it.
	- Emits an event (suggested): `bsky-open-content`
		- detail: `{ uri, cid, kind: 'post' }`
- In App shell / panels controller:
	- If the content panel is not visible, activate it.
	- Ensure layout makes room by reducing the posts panel by exactly 1 column when possible.

Posts click emission (pattern):

```js
// inside bsky-my-posts
onClickPost(uri, cid){
	this.dispatchEvent(new CustomEvent('bsky-open-content', {
		detail: { kind: 'post', uri, cid },
		bubbles: true,
		composed: true,
	}));
}
```

App-side handler (suggested location: inside bsky-app after bootTabs):

```js
// inside bsky-app connectedCallback()
this.shadowRoot.addEventListener('bsky-open-content', (e) => {
	const { uri, cid } = e?.detail || {};
	if (!uri && !cid) return;

	// 1) make content panel visible
	// 2) pass selected uri/cid to <bsky-content-panel>
	// 3) reduce posts panel by exactly 1 column if possible
});
```

Content panel skeleton:

```js
// packages/concretesky/js/components/content_panel.js
import { call } from '../api.js';

class BskyContentPanel extends HTMLElement {
	constructor(){
		super();
		this.attachShadow({ mode: 'open' });
		this.selection = null; // { uri, cid }
	}

	setSelection(sel){
		this.selection = sel;
		this.load();
	}

	async load(){
		// TODO: fetch post + thread + likes/reposts/replies
		// const out = await call('cacheGetPostDetails', { uri: this.selection.uri })
		this.render();
	}

	render(){
		this.shadowRoot.innerHTML = `
			<bsky-panel-shell title="Content" dense>
				<div slot="toolbar">TODO actions (reply/like/repost)</div>
				<div>TODO post details + thread tree</div>
			</bsky-panel-shell>
		`;
	}
}

customElements.define('bsky-content-panel', BskyContentPanel);
```

Acceptance criteria:
- Content panel is exactly 1 column wide (card width based).
- Posts panel loses exactly 1 column, not more.
- Closing the content panel restores the previous layout.
- On mobile: content panel becomes a swipeable panel.

### Commenting + Interactions (High Priority)

#### 10) Add a comment composer web component
- New component: `<bsky-comment-composer>`
- Requirements:
	- Reply-to context
	- character count
	- submit + disabled states
	- emits event on successful post/reply

Skeleton:

```js
// packages/concretesky/js/components/comment_composer.js
import { call } from '../api.js';

class BskyCommentComposer extends HTMLElement {
	constructor(){
		super();
		this.attachShadow({ mode: 'open' });
		this.replyTo = null; // { uri }
		this.text = '';
		this.loading = false;
	}

	setReplyTo(uri){
		this.replyTo = uri ? { uri } : null;
		this.render();
	}

	async submit(){
		if (this.loading) return;
		const text = String(this.text || '').trim();
		if (!text) return;

		this.loading = true;
		this.render();
		try {
			// TODO: wire to create-post / create-reply endpoint
			// const out = await call('createReply', { parentUri: this.replyTo?.uri, text })
			this.text = '';
			this.dispatchEvent(new CustomEvent('bsky-post-created', { bubbles: true, composed: true }));
		} finally {
			this.loading = false;
			this.render();
		}
	}

	render(){
		this.shadowRoot.innerHTML = `
			<style>
				:host{display:block}
				textarea{width:100%;min-height:90px;background:#0b0b0b;color:#fff;border:1px solid #333;border-radius:10px;padding:8px}
				.row{display:flex;justify-content:space-between;align-items:center;margin-top:6px;gap:8px}
				button{background:#111;border:1px solid #555;color:#fff;padding:8px 10px;border-radius:10px;cursor:pointer}
				button:disabled{opacity:.6;cursor:not-allowed}
				.muted{color:#aaa}
			</style>
			<textarea placeholder="Write a reply…">${this.text || ''}</textarea>
			<div class="row">
				<div class="muted">${(this.text || '').length}/300</div>
				<button ${this.loading ? 'disabled' : ''}>${this.replyTo ? 'Reply' : 'Post'}</button>
			</div>
		`;

		const ta = this.shadowRoot.querySelector('textarea');
		ta?.addEventListener('input', () => { this.text = ta.value; });
		const btn = this.shadowRoot.querySelector('button');
		btn?.addEventListener('click', () => this.submit());
	}
}

customElements.define('bsky-comment-composer', BskyCommentComposer);
```

#### 11) Implement post details interactions
- In content panel:
	- show likes
	- show reposts
	- show replies
	- actions: like/repost/reply (as permitted)

### Thread/Comment Tree Rendering (High Priority)

#### 12) Add a thread tree renderer
- New component: `<bsky-thread-tree>`
- Requirements:
	- Render replies in a tree (parent -> children).
	- Collapse/expand branches.
	- Lazy-load deeper replies if needed.
	- Visual connectors and indentation.

Skeleton:

```js
// packages/concretesky/js/components/thread_tree.js
class BskyThreadTree extends HTMLElement {
	constructor(){
		super();
		this.attachShadow({ mode: 'open' });
		this.root = null; // tree node
		this.collapsed = new Set();
	}

	setThreadTree(rootNode){
		this.root = rootNode;
		this.render();
	}

	toggle(uri){
		if (!uri) return;
		if (this.collapsed.has(uri)) this.collapsed.delete(uri);
		else this.collapsed.add(uri);
		this.render();
	}

	renderNode(node, depth){
		const kids = Array.isArray(node?.replies) ? node.replies : [];
		const isCollapsed = this.collapsed.has(node?.uri);
		return `
			<div class="node" style="--d:${depth}">
				<div class="card">
					<div class="meta">${node?.author?.handle ? '@' + node.author.handle : ''}</div>
					<div class="text">${node?.text || ''}</div>
				</div>
				${(!isCollapsed && kids.length)
					? `<div class="kids">${kids.map((k) => this.renderNode(k, depth + 1)).join('')}</div>`
					: ''
				}
			</div>
		`;
	}

	render(){
		this.shadowRoot.innerHTML = `
			<style>
				:host{display:block}
				.node{margin-left:calc(var(--d) * 16px)}
				.card{border:1px solid #333;border-radius:10px;padding:8px;background:#0b0b0b;margin:6px 0}
				.meta{color:#aaa;font-size:.9rem}
				.text{white-space:pre-wrap}
			</style>
			${this.root ? this.renderNode(this.root, 0) : '<div class="muted">No thread.</div>'}
		`;
	}
}

customElements.define('bsky-thread-tree', BskyThreadTree);
```

Acceptance criteria:
- Stable ordering within a thread.
- Does not cause panel overflow.

### Backend/API Tasks (Needed for the above)

#### 13) Add endpoints for post details + thread data
- Add/extend API calls for:
	- post details by URI
	- thread fetch by URI
	- likes list
	- reposts list
	- replies list
	- create reply

#### 14) Cache strategy
- Cache post details + thread responses to reduce repeated network fetch.
- Consider background hydration (similar to profile hydration).

### UX/Polish

#### 15) Keyboard + accessibility
- Focus management when opening content panel.
- Proper `role="region"` and labels.

#### 16) Performance
- Window long lists where needed.
- Avoid re-sorting loaded items; preserve stable ordering unless explicitly requested.

### Suggested Implementation Order

1. Stabilize panel sizing (no overflow, reliable mobile swipe).
2. Add Content panel (template + component + open/close flow).
3. Upgrade Notifications panel to use content panel for deep links.
4. Add thread tree rendering inside content panel.
5. Add comment composer and reply flow.
6. Iterate on caching + performance.

### 1) Backfill clarity + progress

- Deep notifications/posts backfill status: retention caveats + current cursor/coverage + “done” signal. (Implemented: `cacheStatus.backfill` + DB Manager display.)
- Better progress stats for notification backfill (inserted/updated/skipped per chunk) + surfaced in UI. (Implemented.)
- Long-running backfills safer: explicit cancel/stop controls + clearer messaging. (Implemented: DB Manager stop + HUD cancel hooks; copy tweaks optional.)

### 2) Cache lifecycle + maintenance

- Add cache pruning strategy (retention / TTL + vacuum) to keep `cache.sqlite` bounded. (Implemented: admin actions + scheduled job `concretesky_cache_maintenance`.)
- Add an admin-only “DB inspector” view (table sizes, indexes, schema version, last vacuum, writable-path checks). (Implemented: `cacheDbInspect` + DB Manager.)
- Add cache schema migration smoke checks (at least a minimal command/script to run migrate + verify schema version). (Implemented: CLI `concretesky:cache:migrate-check`.)

### 3) Security / access control

- Add configurable access-control guard for the SPA (admin/whitelist/group-based). (Implemented: `CONCRETESKY_UI_*` + server-side enforcement.)
- Keep OAuth endpoints workable: `/oauth/client_metadata` and `/oauth/callback` must remain reachable.
- Document and harden automation mode defaults (JWT allowlist, superuser requirement, when to enable `CONCRETESKY_JWT_ENFORCE`). (Implemented: README guidance + safe defaults.)

### 4) UX / configuration

- Persist DB Manager settings (calendar selections, pagesMax, notifications window, posts filter) optionally in localStorage. (Implemented: `bsky.dbManager.prefs`.)
- Add staleness threshold configuration (what counts as “stale” for cached rows and UI warnings). (Implemented in DB Manager; can be propagated to other panels if desired.)
- Improve rate-limit errors (surface retry-after / backoff hints; reduce spammy retries). (Implemented: Retry-After surfaced + UI backoff in long-running loops.)
- Add a compact, themeable style system (CSS variables) to keep colors/spacing consistent across panels. (Implemented: theme tokens in `bsky-panel-shell`; Groups UI uses tokens.)
- Add a Theme dashboard screen (ConcreteCMS Dashboard) to adjust Dark/Light presets and override `--bsky-*` CSS variables (with color pickers), stored server-side and injected into the SPA. (Implemented: `/dashboard/system/concretesky/theme` + `concretesky.theme_json` injection.)

### 5) Notifications UX (bar + panel)

- Enrich notification entries: show who performed the action (identity block/avatar/handle), and show relationship state (following / follows-you / mutual) where relevant.
- Add quick actions/links (open profile, open post, follow/unfollow when appropriate) and improve grouping/layout readability.

### 6) Data features

- Optional FTS search for cached profiles/posts (SQLite FTS5), with a clean fallback to LIKE when unavailable. (Posts FTS implemented; falls back to LIKE if FTS5 isn't available.)
- Export tools (CSV/JSON) for cached datasets (followers/following/notifications/posts) for AI workflows. (Posts/notifications/followers/following export implemented via `cacheExport`.)
- Add “signals” / analyst views for suspicious or unusual activity patterns (e.g. account age buckets, follower/following ratio, sudden spikes, top interactors).

### 7) Posts / Threads UI (feed + content)

- Posts feed should be thread-centric:
	- Default: compact “summary cards” for posts/replies/reposts.
	- Expand/collapse (+/−) per entry to show the full thread inline (no accidental cross-thread nesting).
	- Clicking any entry opens the Content panel in “conversation/thread view”.
- Fix incorrect nesting in Posts feed where unrelated items appear under the same thread (treat feed items as independent unless explicitly expanded to a fetched thread).
- Inline media in-client (no forced redirect to bsky.app):
	- Images: render grids/preview in cards and in thread view.
	- Bluesky video: render/play inline where possible; add fallback behavior for HLS if the browser can’t play it.
- Commenting / replying:
	- Dedicated comment UI web components under `packages/concretesky/js/comment/*`.
	- Reply composer usable in both the Posts panel (inline in the card) and the Content panel (thread view).
	- Support full Bluesky media options for replies (at minimum: multi-image upload + alt text; extend to video as supported).
	- After posting, refresh the thread/feed to reflect the new reply.
- Reposting:
	- Repost/unrepost actions in cards and thread view.
	- Keep UI state in sync (optimistic update + refresh).

### 9) Bluesky feature parity (expansive)

#### Composer / Posting
- [x] Bluesky-like composer lightbox (Posts panel).
- [x] 300-char counter + over-limit enforcement.
- [x] Thread composer "+" (multi-part posts) with sequential root/parent chaining.
- [x] Emoji picker.
- [x] GIF link insertion (URL into text).
- [x] Multi-image attachments (up to 4) + alt text.
- [x] Language tagging on posts via `record.langs` (uses browser languages).
- [x] Drafts: local drafts per context + autosave (text + interaction settings; incl. thread parts).
- [x] Drafts: persist media selections across reloads (IndexedDB-backed; text/settings remain in localStorage).
- [x] Scheduled posts (client-side scheduler + server job to publish).
- [ ] Edit post (Bluesky supports record update semantics; confirm UX + history).
- [x] Post deletion UX improvements (undo window, optimistic removal).
- [ ] Post “translations” / inline translate UX (if supported; else defer) + copy-to-clipboard.
- [ ] Per-post audience controls parity (where applicable): visibility-like semantics (note: ATProto is public-first; document constraints clearly).
- [x] Drafts: autosave to IndexedDB (text + media + gates) for crash-proof drafts. (IndexedDB snapshot + recovery path.)
- [x] Drafts: export/import (JSON) for power users. (Composer settings: Export/Import.)

#### Facets (mentions, links, hashtags)
- [x] Auto-link URLs into facets (`app.bsky.richtext.facet#link`).
- [x] @mention parsing + DID resolution into facets (`#mention`).
- [x] Hashtag parsing into facets (`#tag`).
- [x] Unicode-safe facet indexing (UTF-8 byte indices).

#### Interaction settings (gates)
- [x] Reply controls (threadgate) for new root posts:
	- Everyone (no gate)
	- Nobody (`allow: []`)
	- Custom: mentioned users / followers / following / list
- [x] List picker support for reply gates (loads lists via `app.bsky.graph.getLists`, fallback to paste AT-URI).
- [x] Quote/embedding control (postgate): disable embedding/quotes.
- [ ] Expose additional postgate rules if/when supported (future lexicon expansion).
- [ ] UI copy parity (Bluesky wording + per-setting explanations).

#### Media
- [x] Images upload + embed.images.
- [ ] Video upload + embed.video support (upload flow + transcoding constraints).
- [ ] Media processing UX: progress bar, cancel, retry.
- [ ] Content accessibility: alt-text required toggle + warnings when missing.

#### Embeds
- [x] Render quoted posts (record embeds) in feed/thread view.
- [x] Render external link cards where available.
- [ ] Better embed fallback: fetch external cards when only a URL is present.
- [ ] Record-with-media embeds (quote + images/video) full parity.
- [ ] Embed accessibility parity: ensure quoted/external cards expose meaningful text for screen readers.
- [ ] Embed safety: guard against layout shifts (image aspect reservation) and malicious URLs.

#### Threading / Conversation UX
- [x] True nested replies across all surfaces.
- [x] Hide-root behavior where duplicate root cards would appear.
- [x] Inline reply composer inserted under clicked post; second click closes.
- [ ] Better “reply-to” UX like Bluesky: show the parent snippet above composer.
- [ ] “Detach thread” / “Continue thread” UX for composing follow-ups.
- [x] Thread actions parity: collapse/expand all, copy link, share, open in new panel. (implemented in `<bsky-thread-tree>`)
- [ ] Conversation context parity: show “you replied” / “you reposted” indicators.

#### Content labels / Safety
- [ ] Self-labeling UI (e.g. “Adult content”) and attach labels per post.
- [ ] Content warnings UI (toggle + reason) and render in timeline.
- [ ] Respect viewer moderation preferences (hide/blur sensitive media).
- [ ] Report post/account flows (if supported via endpoints).
- [ ] “Mute thread” / “hide post” local actions (site-local) if network endpoints don’t exist.
- [ ] Safety UX parity: clear per-post label explanations + “Why am I seeing this?” affordance.

#### Lists / Feeds
- [ ] Browse + manage lists (create, delete, add/remove members).
- [ ] Timeline view for a list feed.
- [ ] Custom feed browsing (app.bsky.feed.getActorFeeds / getFeedSkeleton).
- [ ] Feed pin/reorder persistence (per account) + export/import.
- [ ] Curate feeds in UI: add/remove to home, rename aliases, icons.

#### Notifications + Activity
- [x] Full parity notification rendering (reason strings, grouped actions).
- [x] Inline actions in notifications (like/repost/follow) without context switch.
- [x] Background polling with backoff + “unread” badge counts.
- [x] Mark-as-read semantics parity (per-notification + “mark all read”) with server sync where possible.
- [x] Notification preferences UI (what to notify on; per-account).
- [x] Activity filters: mentions, replies, follows, likes, reposts, quotes.
- [x] “Activity” view parity (likes/reposts on your posts; your own actions timeline).

#### Discoverability / Search
- [x] Global search parity (people + posts + feeds) with a unified results UI.
- [x] Hashtag browsing (tap a hashtag → feed view).
- [x] Saved searches / pinned queries (localStorage + optional SQLite persistence).
- [x] Trending view parity (if available; else approximate via cached aggregation: top hashtags/links).
- [x] Starter packs (if supported): browse + view members + follow-all with rate limiting.
- [x] User lists discovery: show lists that include an actor (if supported) and list search.

#### Profiles / Identity
- [x] Profile edit UI (display name, bio, avatar/banner upload if supported).
- [x] “Followers you know” / mutuals UX parity.
- [ ] Relationship badges everywhere (following/follows-you/mutual) with fast cached lookups.
- [ ] Profile tabs parity: posts, replies, media, likes (if supported via endpoints) + counts.
- [ ] Profile moderation controls: mute/block/report from profile with clear state.
- [ ] Account switching UX parity: multi-account picker + per-account state isolation.

#### Bookmarks / Saves
- [ ] Bookmarks / saved posts (if supported; else implement local-only saved list in SQLite per actor).
- [ ] “Read later” list UI + export.
- [ ] Local-only tagging for saves (labels/folders), plus quick filters.

#### Media parity
- [ ] Video upload + `embed.video` support (upload flow + constraints + playback).
- [ ] GIF picker parity (provider abstraction; allow swapping sources).
- [ ] Media processing UX: progress, cancel, retry.

#### DMs / Chat (if/when supported)
- [ ] DM surface (inbox + thread view) if Bluesky exposes stable endpoints.
- [ ] If not supported: explicitly defer and keep UI hooks modular.

#### Blocks / Mutes / Moderation prefs
- [ ] Mute/unmute user UI + fast cached state.
- [ ] Block/unblock user UI + fast cached state.
- [ ] Muted words/phrases UI (if supported), including per-language and per-scope toggles.
- [ ] List-based moderation parity (mute list / block list) if supported.
- [ ] Labelers management UI (subscribe/unsubscribe labelers; explain implications) if supported.

#### Feeds / Timeline UX
- [ ] Feed picker parity: Following + custom feeds with pin/reorder.
- [ ] Feed composition preferences (hide replies, show reposts, etc.) if supported.
- [ ] Better infinite-scroll UX: see “Panels roadmap (canonical)” (windowing/virtualized lists, scroll position restore, exhausted states, “new posts” banner).

#### Settings / Preferences
- [ ] Viewer preferences UI (hide/blur sensitive media, labelers, moderation prefs).
- [ ] Per-account settings persistence (SQLite + UI sync).
- [ ] Session diagnostics UI: show token expiry, DPoP status, last refresh, last error.
- [ ] Privacy/security settings: clear cached tokens locally, clear per-account caches, “forget account” UX.
- [x] Theme preferences: compact/comfortable density, font size, reduced motion. (Implemented via Theme dashboard prefs; reduced motion currently targets smooth scrolling + drag animation + spinners; remaining: audit any rAF-driven effects/transitions.)

#### Account lifecycle
- [ ] Handle change support (detect + update cached profile links).
- [ ] DID rotation / recovery story (document constraints; handle gracefully if it occurs).
- [ ] “Sign out everywhere”/token revoke UX (if supported) or local-only sign-out.
- [ ] Account migration tooling for site-local data (saved posts, group membership): export/import keyed by DID.

#### Diagnostics / Developer tooling
- [ ] Built-in “Request Log” panel (admin-only): last N XRPC calls, status, latency, rate-limit headers.
- [ ] “Replay last request” button (safe GETs only) and “copy curl” for debugging.
- [ ] Feature flags UI (localStorage + optional server-config): enable experimental panels/features.
- [ ] Minimal error reporting hook (optional): log to a site-local table for support.

#### Internationalization
- [ ] i18n strategy for Web Components (string tables, locale selection, fallbacks).
- [ ] Date/time formatting parity (relative times, locale-sensitive).
- [ ] RTL support audit for panel layouts.

#### Offline-ish / resilience
- [ ] Background refresh scheduler (jobs) for posts + notifications + profiles with backoff.
- [ ] Conflict-safe refresh (avoid duplicates; stable ordering; cursor correctness).
- [ ] “Low-connectivity mode” toggle: fewer images, smaller page sizes, less aggressive polling.
- [ ] Robust retry UX: per-surface “retry now” buttons + explain backoff state.

#### Accessibility / Polish
- [ ] Keyboard navigation for composer parts + pickers.
- [ ] Proper focus management when opening/closing dialogs.
- [ ] Screenreader labels for all icon buttons.

### 8) People monitoring (watchlist + activity)

- Add a “Watchlist” / People Monitoring panel:
	- Add/remove Bluesky users by handle/DID.
	- Persist watchlist in SQLite (and expose via API).
- Cache watched users’ profile + recent posts on-demand and on a schedule.
- Activity stats for watched users:
	- Posting frequency, active hours/days, recent streaks.
	- Interaction stats: replies/likes/reposts involving you and/or other watched users.
	- “New since last check” summaries.
- Notifications for watched users:
	- In-app notifications when they post (and optionally when they are replied to / quoted / reposted).
	- Optional: email notifications and web push notifications (future).

## Maintenance

- Consider deprecating or clearly labeling the legacy app-password login path (`authLogin`) now that OAuth is the default.

## Facebook Groups parity (Bluesky-first)

This section is the backlog for building “groups” as a first-class product. Some features map directly to ATProto primitives; others will be implemented as **site-local group metadata + moderation** while posting public content to Bluesky.

### 1) Group model (foundation)

- [ ] Define a durable Group model:
	- [x] SQLite schema + migrations (groups + membership + audit log).
	- [ ] Export/backup + import (site portability).
	- [ ] Clarify constraints and invariants (owner transfer, delete semantics).
- [ ] Group-scoped routing in UI:
	- [x] Group selector (site-level nav) + persisted active group.
	- [x] Shell stays in sync on group changes (live refresh).
	- [x] Group home panel with MVP activity feed.
- [x] Group settings UI (admins only).

- [x] MVP server API for site-local groups (list/get/create/update/join/leave).
- [x] MVP Groups panel (list + join/leave + admin create).

### 2) Membership + roles

- [x] Membership states: `member|pending|blocked|invited`.
- [x] Roles: `admin|moderator|member` (+ optional `trusted`).
- [ ] Join flow parity:
	- Join questions (form builder + stored answers).
	- [x] Approval queue for closed groups (admin-only MVP).
	- [x] Invite links (rotatable tokens) (admin-only MVP).
- [x] Group rules (markdown) + onboarding gate (“must accept rules”) (MVP).

### 3) Group feed + posting

- [ ] Group feed panel:
	- [x] MVP: tag-based feed from Bluesky search.
	- [ ] Sort modes (new, top, hot) with clear semantics.
	- [ ] Topic tags (group-local taxonomy).
- [ ] Posting into a group:
	- [x] Post composer supports “post to group” (adds group tag).
	- [x] Group-only posting rules (MVP): members can submit; closed/secret require approval; public posts publish immediately.
	- [x] Slow-mode / per-member rate limits (MVP: per-group cooldown seconds).
- [x] Announcement posts + pinning:
	- [x] Pin up to N posts; show pinned section.
	- [x] Admin-only announcement marker.

### 4) Moderation queue (Facebook-style)

- [ ] Moderation surfaces:
	- [x] Pending posts queue (approve/deny) (MVP: mods/admins only).
	- [x] Report queue (user reports with reasons) (MVP).
	- [x] Member requests queue (approve/deny).
- [ ] Moderator actions:
	- [x] Remove post (from group feed) (MVP: site-local hide/unhide), keep audit log.
	- [x] Warn/suspend/ban member (group-local enforcement).
	- [x] Keyword filters / blocked phrases (MVP: deny / require approval).
- [x] Audit log UI + export (who did what, when).

### 5) Units / Guides (learning content)

- [ ] Units feature parity (Facebook “Guides”):
	- Units have title/description + ordered steps.
	- Steps can link to posts, external URLs, or local HTML blocks.
	- Completion tracking per member.

### 6) Events

- [ ] Group events:
	- Create/edit event, RSVP list.
	- Optional reminders (email/push later).
	- Event posts in group feed.

### 7) Files / Media library

- [ ] Group files (site-local storage): upload, organize, permissions.
- [ ] Link media to posts/units/events.
- [ ] Anti-abuse constraints (size limits, types, virus scan hook).

### 8) Insights / analytics

- [ ] Group insights dashboard:
	- Growth (members over time, join sources).
	- Engagement (posts/comments/reactions per day).
	- Top contributors, top posts.
	- Moderation workload stats.

### 9) Discovery + cross-site portability

- [ ] “Directory” view of groups on a site (categories, search).
- [ ] Export/import group configuration + membership list.
- [ ] Non-Concrete host strategy:
	- Extract core PHP library (auth + XRPC + SQLite + jobs runner) so other PHP CMSs can integrate.
	- Define a minimal cron entrypoint equivalent to Concrete jobs.

### 10) Post types + engagement parity

- [ ] Poll posts (group-local): create, vote, results visibility rules.
- [ ] Q&A / “Ask a question” post type (accepted answer + surfaced state).
- [ ] Anonymous posting (admin-controlled; audited; optional moderator reveal).
- [ ] Post reactions beyond likes (group-local) if desired; ensure anti-abuse constraints.

### 11) Group chat / real-time community

- [ ] Group chat surface (site-local): channels, member mentions, moderation.
- [ ] If Bluesky DMs become viable: optionally bridge group chat to DMs for small groups.

### 12) Admin automation (“Moderation Assist”)

- [ ] Auto-approve rules (account age, mutuals, prior member standing, answered questions).
- [ ] Auto-decline heuristics (link spam patterns, repeated phrases, suspicious domains).
- [ ] Scheduled moderation reports (daily digest) for admins.

### 13) Membership + community management

- [ ] Member badges / roles expansion (e.g. “Top contributor”, “New member”, “Verified”).
- [ ] Welcome posts + onboarding checklist.
- [ ] Member directory view with filters (new members, most active, moderators).

### 14) Content organization + knowledge base

- [ ] Topics taxonomy tooling: merge/rename, pin topics, topic rules.
- [ ] Wiki/Docs (site-local): pages with history + editor permissions.
- [ ] Group “Files” + “Docs” unified library (search, tagging).

### 15) Integrations + sharing

- [ ] Share group content externally:
	- Generate canonical permalinks that work outside the panel UI.
	- Optional OpenGraph cards for posts/events/units.
- [ ] Webhook/event stream for group actions (new member, post approved, report created).

### 16) Safety + compliance

- [ ] Privacy controls parity: secret groups should not leak membership/content in listings.
- [ ] Data retention tooling: delete member data, export member data, purge audit logs by policy.
- [ ] Abuse handling: rate limits per member, post cooldowns, link limits, attachment limits.

### 17) Governance + rules enforcement

- [ ] Appeals workflow: member can appeal a denial/ban; moderator review; audit trail.
- [ ] Moderator permissions granularity (who can ban vs approve vs edit rules vs manage files).
- [ ] “Admin announcements” system: schedule announcements, pin duration, expiry.
- [ ] Rule change history + member re-acknowledgement gate when rules update.

### 18) Subgroups + multi-space communities

- [ ] Subgroups / channels inside a group (topic-based rooms) with per-channel posting rules.
- [ ] Cross-posting between subgroups with attribution.
- [ ] “Collections” for organizing posts (saved threads inside a group).

### 19) Monetization + fundraising (optional)

- [ ] Paid groups / memberships (site-local billing integration; keep optional and decoupled).
- [ ] Donations/fundraisers: campaign posts + progress display + donor privacy controls.
- [ ] Member perks (badges, role unlocks) managed by admins.

### 20) Notifications + digests (group-scoped)

- [ ] Group notification settings: new posts, mentions, announcements, events, units.
- [ ] Email digests (daily/weekly) for group activity (site-local mailer integration).
- [ ] Web push notifications (later): subscribe per group + per device.

### 21) Scheduling + content calendar

- [ ] Scheduled posts (group-local queue) + approval + publish windows.
- [ ] Content calendar view (admin/mod): upcoming posts/events/announcements.
- [ ] Recurring events + automated reminder posts.

### 22) Reputation + trust signals

- [ ] Trust score (site-local): tenure, approvals, reports, engagement.
- [ ] Anti-spam gating: require phone/email verification (site-local) if desired.
- [ ] “Slow mode” auto-enable when spam spikes (rules engine).

### 23) Accessibility + inclusivity (group features)

- [ ] Alt-text enforcement for group-required media.
- [ ] Caption uploads for video (site-local) + transcript fields for events/units.
- [ ] Accessibility audit: keyboard nav for mod tools and forms.
