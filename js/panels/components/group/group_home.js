import { call } from '../../../api.js';
import { resolveMentionDidsFromTexts, buildFacetsSafe, defaultLangs, selectEmbed } from '../../../controllers/compose_controller.js';
import { syncRecent } from '../../../controllers/cache_sync_controller.js';
import { renderPostCard } from '../../../components/interactions/utils.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));
const escAttr = (s) => esc(String(s || '')).replace(/\n/g, ' ');

function loadSavedGroupId() {
  try {
    const raw = localStorage.getItem('bsky_active_group_id');
    const n = Number(raw || 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function groupTagFromSlug(slug) {
  const s = String(slug || '').toLowerCase();
  const safe = s.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return safe ? `#csky_${safe}` : '';
}

export class BskyGroupHome extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this.groupId = 0;
    this.group = null;

    this.loading = false;
    this.busy = false;
    this.error = '';
    this.notice = '';

    this.inviteToken = '';

    // Group posts (MVP): global tag-based feed.
    this.composeText = '';
    this.postBusy = false;

    this.feedLoading = false;
    this.feedItems = [];
    this.feedCursor = null;
    this.feedHasMore = false;

    this.auditLoading = false;
    this.auditItems = [];
    this.auditBefore = null;
    this.auditHasMore = false;

    // Group post moderation (MVP): closed/secret require approval.
    this.pendingLoading = false;
    this.pendingItems = [];
    this.pendingCursor = null;
    this.pendingHasMore = false;
    this.pendingError = '';

    // Member-visible submission history.
    this.mineLoading = false;
    this.mineItems = [];
    this.mineCursor = null;
    this.mineHasMore = false;
    this.mineError = '';

    // Site-local feed suppression list.
    this.hiddenLoading = false;
    this.hiddenItems = [];
    this.hiddenError = '';
    this.hiddenSet = new Set();

    this._onGroupChanged = (e) => {
      try {
        const gid = Number(e?.detail?.groupId || 0);
        if (gid && gid !== this.groupId) {
          this.groupId = gid;
          this.load();
        }
        if (!gid) {
          this.groupId = 0;
          this.group = null;
          this.render();
        }
      } catch {
        // ignore
      }
    };
  }

  connectedCallback() {
    this.groupId = loadSavedGroupId();
    this.render();
    if (this.groupId) this.load();

    window.addEventListener('bsky-group-changed', this._onGroupChanged);

    this.shadowRoot.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      e.preventDefault();

      const action = btn.getAttribute('data-action') || '';
      if (action === 'refresh') {
        this.load();
        return;
      }
      if (action === 'more-activity') {
        this.loadAudit(false);
        return;
      }
      if (action === 'post') {
        this.submitPost();
        return;
      }
      if (action === 'refresh-feed') {
        this.loadFeed(true);
        return;
      }
      if (action === 'more-feed') {
        this.loadFeed(false);
        return;
      }
      if (action === 'refresh-pending') {
        this.loadPending(true);
        return;
      }
      if (action === 'more-pending') {
        this.loadPending(false);
        return;
      }
      if (action === 'approve-pending') {
        const id = Number(btn.getAttribute('data-post-id') || 0);
        if (id) this.approvePending(id);
        return;
      }
      if (action === 'deny-pending') {
        const id = Number(btn.getAttribute('data-post-id') || 0);
        if (id) this.denyPending(id);
        return;
      }
      if (action === 'refresh-mine') {
        this.loadMine(true);
        return;
      }
      if (action === 'more-mine') {
        this.loadMine(false);
        return;
      }
      if (action === 'hide-post') {
        const uri = String(btn.getAttribute('data-uri') || '').trim();
        if (uri) this.hidePost(uri);
        return;
      }
      if (action === 'unhide-post') {
        const uri = String(btn.getAttribute('data-uri') || '').trim();
        if (uri) this.unhidePost(uri);
        return;
      }
      if (action === 'join') {
        this.join();
        return;
      }
      if (action === 'leave') {
        this.leave();
        return;
      }
    });

    this.shadowRoot.addEventListener('input', (e) => {
      const el = e.target;
      if (!(el instanceof HTMLElement)) return;
      if (el.matches('input[name="invite_token"]')) {
        this.inviteToken = String(el.value || '');
      }
      if (el.matches('textarea[name="compose_text"]')) {
        this.composeText = String(el.value || '');
      }
    });
  }

  disconnectedCallback() {
    window.removeEventListener('bsky-group-changed', this._onGroupChanged);
  }

  setError(msg) {
    this.error = String(msg || '');
    if (this.error) this.notice = '';
    this.render();
  }

  setNotice(msg) {
    this.notice = String(msg || '');
    this.render();
  }

  async load() {
    if (this.loading) return;
    if (!this.groupId) {
      this.group = null;
      this.render();
      return;
    }

    this.loading = true;
    this.setError('');
    this.render();
    try {
      const res = await call('groupGet', { groupId: this.groupId });
      this.group = res?.group || null;
      await this.loadAudit(true);
      await this.loadFeed(true);
      await this.loadPending(true);
      await this.loadMine(true);
      await this.loadHidden(true);
    } catch (e) {
      this.group = null;
      this.setError(e?.message || String(e));
    } finally {
      this.loading = false;
      this.render();
    }
  }

  async loadMine(reset = false) {
    const g = this.group;
    if (!this.groupId || !g) return;
    if (String(g?.my_state || '') !== 'member') return;

    if (this.mineLoading) return;
    if (!reset && !this.mineHasMore) return;

    this.mineLoading = true;
    this.mineError = '';
    if (reset) {
      this.mineItems = [];
      this.mineCursor = null;
      this.mineHasMore = false;
    }
    this.render();

    try {
      const res = await call('groupPostsMineList', {
        groupId: this.groupId,
        limit: 25,
        ...(this.mineCursor ? { cursor: Number(this.mineCursor) } : {}),
      });
      const items = Array.isArray(res?.items) ? res.items : [];
      if (reset) this.mineItems = items;
      else this.mineItems = [...(this.mineItems || []), ...items];
      this.mineCursor = (res?.cursor ? String(res.cursor) : null);
      this.mineHasMore = !!this.mineCursor;
    } catch (e) {
      this.mineError = e?.message || String(e);
      if (reset) {
        this.mineItems = [];
        this.mineCursor = null;
        this.mineHasMore = false;
      }
    } finally {
      this.mineLoading = false;
      this.render();
    }
  }

  async loadHidden(reset = false) {
    const g = this.group;
    if (!this.groupId || !g) return;

    if (this.hiddenLoading) return;
    if (!reset && this.hiddenItems && this.hiddenItems.length) return;

    this.hiddenLoading = true;
    this.hiddenError = '';
    if (reset) {
      this.hiddenItems = [];
      this.hiddenSet = new Set();
    }
    this.render();

    try {
      const res = await call('groupHiddenPostsList', { groupId: this.groupId, limit: 500 });
      const items = Array.isArray(res?.items) ? res.items : [];
      this.hiddenItems = items;
      this.hiddenSet = new Set(items.map((it) => String(it.post_uri || '')).filter(Boolean));
    } catch (e) {
      this.hiddenError = e?.message || String(e);
      if (reset) {
        this.hiddenItems = [];
        this.hiddenSet = new Set();
      }
    } finally {
      this.hiddenLoading = false;
      this.render();
    }
  }

  async hidePost(uri) {
    const g = this.group;
    if (!this.groupId || !g) return;
    const myRole = String(g?.my_role || '');
    const isMod = (myRole === 'admin' || myRole === 'moderator');
    if (!isMod) return;

    const note = prompt('Hide reason? (optional)') || '';
    this.setError('');
    this.setNotice('');
    this.render();
    try {
      await call('groupPostHide', { groupId: this.groupId, uri, ...(note ? { note } : {}) });
      await this.loadHidden(true);
      await this.loadAudit(true);
      this.setNotice('Post hidden from group feed.');
    } catch (e) {
      this.setError(e?.message || String(e));
    }
  }

  async unhidePost(uri) {
    const g = this.group;
    if (!this.groupId || !g) return;
    const myRole = String(g?.my_role || '');
    const isMod = (myRole === 'admin' || myRole === 'moderator');
    if (!isMod) return;

    this.setError('');
    this.setNotice('');
    this.render();
    try {
      await call('groupPostUnhide', { groupId: this.groupId, uri });
      await this.loadHidden(true);
      await this.loadAudit(true);
      this.setNotice('Post unhidden.');
    } catch (e) {
      this.setError(e?.message || String(e));
    }
  }

  async loadPending(reset = false) {
    const g = this.group;
    if (!this.groupId || !g) return;
    const myRole = String(g?.my_role || '');
    const isMod = (myRole === 'admin' || myRole === 'moderator');
    if (!isMod) return;

    if (this.pendingLoading) return;
    if (!reset && !this.pendingHasMore) return;

    this.pendingLoading = true;
    this.pendingError = '';
    if (reset) {
      this.pendingItems = [];
      this.pendingCursor = null;
      this.pendingHasMore = false;
    }
    this.render();

    try {
      const res = await call('groupPostsPendingList', {
        groupId: this.groupId,
        limit: 50,
        ...(this.pendingCursor ? { cursor: Number(this.pendingCursor) } : {}),
      });
      const items = Array.isArray(res?.items) ? res.items : [];
      if (reset) this.pendingItems = items;
      else this.pendingItems = [...(this.pendingItems || []), ...items];
      this.pendingCursor = (res?.cursor ? String(res.cursor) : null);
      this.pendingHasMore = !!this.pendingCursor;
    } catch (e) {
      this.pendingError = e?.message || String(e);
      if (reset) {
        this.pendingItems = [];
        this.pendingCursor = null;
        this.pendingHasMore = false;
      }
    } finally {
      this.pendingLoading = false;
      this.render();
    }
  }

  async approvePending(postId) {
    const g = this.group;
    if (!this.groupId || !g) return;
    if (this.pendingLoading) return;
    this.pendingLoading = true;
    this.pendingError = '';
    this.render();

    try {
      await call('groupPostApprove', { groupId: this.groupId, postId });
      try {
        await syncRecent({ minutes: 10, refreshMinutes: 30 });
      } catch {}
      await this.loadPending(true);
      await this.loadFeed(true);
      await this.loadAudit(true);
    } catch (e) {
      this.pendingError = e?.message || String(e);
    } finally {
      this.pendingLoading = false;
      this.render();
    }
  }

  async denyPending(postId) {
    const g = this.group;
    if (!this.groupId || !g) return;
    if (this.pendingLoading) return;

    const note = prompt('Deny reason? (optional)') || '';
    this.pendingLoading = true;
    this.pendingError = '';
    this.render();

    try {
      await call('groupPostDeny', { groupId: this.groupId, postId, ...(note ? { note } : {}) });
      await this.loadPending(true);
      await this.loadAudit(true);
    } catch (e) {
      this.pendingError = e?.message || String(e);
    } finally {
      this.pendingLoading = false;
      this.render();
    }
  }

  async loadAudit(reset = false) {
    if (!this.groupId) return;
    if (this.auditLoading) return;
    if (!reset && !this.auditHasMore) return;

    this.auditLoading = true;
    if (reset) {
      this.auditItems = [];
      this.auditBefore = null;
      this.auditHasMore = false;
    }
    this.render();

    try {
      const res = await call('groupAuditList', {
        groupId: this.groupId,
        limit: 50,
        ...(this.auditBefore ? { before: this.auditBefore } : {}),
      });
      const items = Array.isArray(res?.items) ? res.items : [];
      if (reset) this.auditItems = items;
      else this.auditItems = [...(this.auditItems || []), ...items];
      this.auditBefore = (res?.nextBefore ? String(res.nextBefore) : null);
      this.auditHasMore = !!this.auditBefore && items.length > 0;
    } catch (e) {
      // Closed/secret groups may deny activity to non-members.
      // Keep the panel usable even if this fails.
      if (reset) {
        this.auditItems = [];
        this.auditBefore = null;
        this.auditHasMore = false;
      }
    } finally {
      this.auditLoading = false;
      this.render();
    }
  }

  async loadFeed(reset = false) {
    const g = this.group;
    if (!this.groupId || !g) return;
    if (this.feedLoading) return;
    if (!reset && !this.feedHasMore) return;

    const tag = groupTagFromSlug(g?.slug);
    if (!tag) {
      if (reset) {
        this.feedItems = [];
        this.feedCursor = null;
        this.feedHasMore = false;
      }
      return;
    }

    this.feedLoading = true;
    if (reset) {
      this.feedItems = [];
      this.feedCursor = null;
      this.feedHasMore = false;
    }
    this.render();

    try {
      const res = await call('searchPosts', {
        q: tag,
        limit: 25,
        ...(this.feedCursor ? { cursor: this.feedCursor } : {}),
      });
      const items = Array.isArray(res?.posts) ? res.posts : [];
      if (reset) this.feedItems = items;
      else this.feedItems = [...(this.feedItems || []), ...items];
      this.feedCursor = res?.cursor ? String(res.cursor) : null;
      this.feedHasMore = !!this.feedCursor;
    } catch {
      // keep panel usable if search fails/rate-limits
      if (reset) {
        this.feedItems = [];
        this.feedCursor = null;
        this.feedHasMore = false;
      }
    } finally {
      this.feedLoading = false;
      this.render();
    }
  }

  async submitPost() {
    const g = this.group;
    if (!this.groupId || !g) return;
    if (this.postBusy) return;
    if (String(g?.my_state || '') !== 'member') return;

    const base = String(this.composeText || '').trim();
    if (!base) return;

    const tag = groupTagFromSlug(g?.slug);
    const alreadyTagged = tag && new RegExp(`\\b${tag.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i').test(base);
    const text = (tag && !alreadyTagged) ? `${base}\n\n${tag}` : base;

    this.postBusy = true;
    this.setError('');
    this.setNotice('');
    this.render();

    try {
      const didByHandle = await resolveMentionDidsFromTexts([text]);
      const facets = buildFacetsSafe(text, didByHandle);
      const embed = await selectEmbed({ text, images: null, quote: null });

      const res = await call('groupPostSubmit', { groupId: this.groupId, text, langs: defaultLangs(), ...(facets ? { facets } : {}), ...(embed ? { embed } : {}) });
      if (!res?.ok) throw new Error(res?.error || 'Failed to submit');

      try {
        await syncRecent({ minutes: 10, refreshMinutes: 30 });
      } catch {}

      this.composeText = '';
      if (String(res?.state || '') === 'pending') {
        this.setNotice('Submitted for approval.');
        await this.loadPending(true);
        await this.loadAudit(true);
        await this.loadMine(true);
      } else {
        this.setNotice('Posted to group.');
        await this.loadFeed(true);
        await this.loadMine(true);
      }
    } catch (e) {
      this.setError(e?.message || String(e));
    } finally {
      this.postBusy = false;
      this.render();
    }
  }

  async join() {
    if (!this.groupId) return;
    if (this.busy) return;
    this.busy = true;
    this.setError('');
    this.render();
    try {
      const visibility = String(this.group?.visibility || '');
      const inviteToken = (visibility === 'secret') ? String(this.inviteToken || '').trim() : '';
      await call('groupJoin', { groupId: this.groupId, ...(inviteToken ? { inviteToken } : {}) });
      await this.load();
    } catch (e) {
      this.setError(e?.message || String(e));
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async leave() {
    if (!this.groupId) return;
    if (this.busy) return;
    if (!confirm('Leave group?')) return;
    this.busy = true;
    this.setError('');
    this.render();
    try {
      await call('groupLeave', { groupId: this.groupId });
      await this.load();
    } catch (e) {
      this.setError(e?.message || String(e));
    } finally {
      this.busy = false;
      this.render();
    }
  }

  render() {
    const g = this.group;
    const name = g ? String(g.name || g.slug || `#${g.group_id || ''}`) : '';
    const slug = g ? String(g.slug || '') : '';
    const vis = g ? String(g.visibility || 'public') : '';
    const membersCount = g ? (g.members_count ?? g.membersCount ?? '—') : '—';
    const myState = g ? String(g.my_state || '') : '';
    const myRole = g ? String(g.my_role || '') : '';
    const isMod = g && (myRole === 'admin' || myRole === 'moderator');

    const canJoin = g && !myState;
    const canLeave = g && (myState === 'member' || myState === 'pending');
    const canPost = g && (myState === 'member');
    const groupTag = g ? groupTagFromSlug(slug) : '';

    const isMod = g && (myRole === 'admin' || myRole === 'moderator');

    const statusBits = g ? [
      vis ? `Visibility: ${vis}` : '',
      (myState ? `You: ${myState}${myRole ? ` (${myRole})` : ''}` : 'You: not a member'),
      (membersCount !== null && typeof membersCount !== 'undefined') ? `Members: ${membersCount}` : '',
    ].filter(Boolean).join(' • ') : '';

    const secretInvite = (g && vis === 'secret' && !myState) ? `
      <div class="invite">
        <div class="muted">This is a secret group. You need an invite token to join.</div>
        <label>Invite token</label>
        <input name="invite_token" placeholder="paste token" value="${escAttr(this.inviteToken)}" ${this.busy ? 'disabled' : ''} />
      </div>
    ` : '';

    const activity = (() => {
      const items = Array.isArray(this.auditItems) ? this.auditItems : [];
      if (!g) return '';
      if (this.auditLoading && items.length === 0) return `<div class="muted">Loading activity…</div>`;
      if (items.length === 0) return `<div class="muted">No recent activity yet.</div>`;

      const rows = items.map((it) => {
        const at = String(it.created_at || '');
        const action = String(it.action || '');
        const actor = String(it.actor_did || '');
        let detail = '';
        try {
          const d = it.detail ? JSON.parse(String(it.detail)) : null;
          if (d && typeof d === 'object') detail = JSON.stringify(d);
        } catch {
          detail = String(it.detail || '');
        }
        return `
          <div class="actRow">
            <div class="actMain">
              <div class="actAction"><span class="mono">${esc(action)}</span> <span class="muted">by</span> <span class="mono">${esc(actor)}</span></div>
              ${detail ? `<div class="actDetail">${esc(detail)}</div>` : ''}
            </div>
            <div class="actAt">${esc(at)}</div>
          </div>
        `;
      }).join('');

      const moreBtn = this.auditHasMore
        ? `<button class="btn" type="button" data-action="more-activity" ${this.auditLoading ? 'disabled' : ''}>Load more</button>`
        : '';

      return `
        <div class="activity">
          ${rows}
          ${moreBtn ? `<div class="moreRow">${moreBtn}</div>` : ''}
        </div>
      `;
    })();

    const feed = (() => {
      if (!g) return '';
      if (!groupTag) return `<div class="muted">No group tag available for this group.</div>`;

      const raw = Array.isArray(this.feedItems) ? this.feedItems : [];
      const hidden = this.hiddenSet instanceof Set ? this.hiddenSet : new Set();
      const items = isMod
        ? raw
        : raw.filter((p) => !hidden.has(String(p?.uri || '')));
      const header = `
        <div class="feedMeta">
          <div class="muted">Tag:</div>
          <div class="mono">${esc(groupTag)}</div>
          <div style="flex:1"></div>
          <button class="btn" type="button" data-action="refresh-feed" ${this.feedLoading ? 'disabled' : ''}>Refresh</button>
        </div>
      `;

      const list = (items.length === 0)
        ? `<div class="muted">${this.feedLoading ? 'Loading posts…' : 'No posts found yet.'}</div>`
        : `<div class="feedList">${items.map((p) => {
            const uri = String(p?.uri || '');
            const isHidden = uri && hidden.has(uri);
            const controls = isMod && uri
              ? `<div class="postActions">
                  ${isHidden
                    ? `<button class="btn" type="button" data-action="unhide-post" data-uri="${escAttr(uri)}" ${this.hiddenLoading ? 'disabled' : ''}>Unhide</button>`
                    : `<button class="btn" type="button" data-action="hide-post" data-uri="${escAttr(uri)}" ${this.hiddenLoading ? 'disabled' : ''}>Hide</button>`}
                </div>`
              : '';
            const badge = (isMod && isHidden) ? `<div class="muted" style="margin-bottom:6px;">Hidden from group feed</div>` : '';
            return `<div class="post ${isHidden ? 'postHidden' : ''}">${badge}${controls}${renderPostCard(p)}</div>`;
          }).join('')}</div>`;

      const more = this.feedHasMore
        ? `<div class="moreRow"><button class="btn" type="button" data-action="more-feed" ${this.feedLoading ? 'disabled' : ''}>Load more</button></div>`
        : '';

      return `${header}${list}${more}`;
    })();

    const mine = (() => {
      if (!g || !canPost) return '';
      const items = Array.isArray(this.mineItems) ? this.mineItems : [];
      const header = `
        <div class="feedMeta">
          <div class="muted">Your submissions</div>
          <div style="flex:1"></div>
          <button class="btn" type="button" data-action="refresh-mine" ${this.mineLoading ? 'disabled' : ''}>Refresh</button>
        </div>
      `;
      const err = this.mineError ? `<div class="err">${esc(this.mineError)}</div>` : '';
      const list = (items.length === 0)
        ? `<div class="muted">${this.mineLoading ? 'Loading…' : 'No submissions yet.'}</div>`
        : `<div class="pendingList">${items.map((p) => {
            const state = String(p.state || '');
            const uri = String(p.uri || '');
            const createdAt = String(p.created_at || '');
            const decidedAt = String(p.decided_at || '');
            const note = String(p.decision_note || '');
            return `
              <div class="pendingRow">
                <div class="muted">State: <span class="mono">${esc(state || '—')}</span> • ${esc(createdAt)}</div>
                ${p.text ? `<div class="pendingText">${esc(p.text)}</div>` : ''}
                ${uri ? `<div class="muted">URI: <span class="mono">${esc(uri)}</span></div>` : ''}
                ${decidedAt ? `<div class="muted">Decided: ${esc(decidedAt)}${p.decided_by_did ? ` by <span class=\"mono\">${esc(p.decided_by_did)}</span>` : ''}</div>` : ''}
                ${note ? `<div class="muted">Note: ${esc(note)}</div>` : ''}
              </div>
            `;
          }).join('')}</div>`;
      const more = this.mineHasMore
        ? `<div class="moreRow"><button class="btn" type="button" data-action="more-mine" ${this.mineLoading ? 'disabled' : ''}>Load more</button></div>`
        : '';
      return `${err}${header}${list}${more}`;
    })();

    const pending = (() => {
      if (!g || !isMod) return '';

      const items = Array.isArray(this.pendingItems) ? this.pendingItems : [];
      const header = `
        <div class="feedMeta">
          <div class="muted">Queue:</div>
          <div class="mono">pending</div>
          <div style="flex:1"></div>
          <button class="btn" type="button" data-action="refresh-pending" ${this.pendingLoading ? 'disabled' : ''}>Refresh</button>
        </div>
      `;

      const list = (items.length === 0)
        ? `<div class="muted">${this.pendingLoading ? 'Loading pending…' : 'No pending posts.'}</div>`
        : `<div class="pendingList">${items.map((p) => `
            <div class="pendingRow">
              <div class="muted"><span class="mono">${esc(p.author_did || '')}</span> • ${esc(p.created_at || '')}</div>
              <div class="pendingText">${esc(p.text || '')}</div>
              <div class="actions">
                <button class="btn" type="button" data-action="approve-pending" data-post-id="${escAttr(p.post_id)}" ${this.pendingLoading ? 'disabled' : ''}>Approve</button>
                <button class="btn" type="button" data-action="deny-pending" data-post-id="${escAttr(p.post_id)}" ${this.pendingLoading ? 'disabled' : ''}>Deny</button>
              </div>
            </div>
          `).join('')}</div>`;

      const more = this.pendingHasMore
        ? `<div class="moreRow"><button class="btn" type="button" data-action="more-pending" ${this.pendingLoading ? 'disabled' : ''}>Load more</button></div>`
        : '';

      return `${this.pendingError ? `<div class="err">${esc(this.pendingError)}</div>` : ''}${header}${list}${more}`;
    })();

    const body = !this.groupId
      ? `<div class="empty">Select a group from the dropdown in the top bar.</div>`
      : (this.loading
          ? `<div class="muted">Loading group…</div>`
          : (g
              ? `
                <div class="card">
                  <div class="title">${esc(name)} <span class="slug">/${esc(slug)}</span></div>
                  ${g.description ? `<div class="desc">${esc(g.description)}</div>` : ''}
                  <div class="sub">${esc(statusBits)}</div>
                  ${secretInvite}
                  <div class="actions">
                    ${canJoin ? `<button class="btn" type="button" data-action="join" ${this.busy ? 'disabled' : ''}>Join</button>` : ''}
                    ${canLeave ? `<button class="btn" type="button" data-action="leave" ${this.busy ? 'disabled' : ''}>Leave</button>` : ''}
                    <button class="btn" type="button" data-action="refresh" ${this.loading || this.busy ? 'disabled' : ''}>Refresh</button>
                  </div>
                </div>

                ${canPost ? `
                  <div class="card">
                    <div class="title">Post to group</div>
                    <div class="muted">MVP: posts are public on Bluesky and are associated to the group via tag <span class="mono">${esc(groupTag)}</span>. Closed/secret groups may require approval.</div>
                    <label>Text</label>
                    <textarea name="compose_text" rows="4" placeholder="Write something…" ${this.postBusy ? 'disabled' : ''}>${esc(this.composeText)}</textarea>
                    <div class="actions">
                      <button class="btn" type="button" data-action="post" ${this.postBusy ? 'disabled' : ''}>Submit</button>
                    </div>
                    <div style="margin-top:10px;">
                      ${mine}
                    </div>
                  </div>
                ` : ''}

                ${isMod ? `
                  <div class="card">
                    <div class="title">Pending posts (mods)</div>
                    ${pending}
                  </div>
                ` : ''}

                <div class="feed">
                  <div class="feedTitle">Group feed</div>
                  <div class="muted">MVP: tag-based Bluesky feed + site-local audit activity.</div>
                  <div class="split">
                    <div class="col">
                      <div class="miniTitle">Posts</div>
                      ${feed}
                    </div>
                    <div class="col">
                      <div class="miniTitle">Activity</div>
                      ${activity}
                    </div>
                  </div>
                </div>
              `
              : `<div class="muted">Group not found.</div>`));

    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block;color:#fff}
        .btn{background:#111;border:1px solid #333;color:#fff;padding:6px 10px;cursor:pointer}
        .btn[disabled]{opacity:.6;cursor:not-allowed}
        .muted{opacity:.75;font-size:12px}
        .err{background:#2a0c0c;border:1px solid #5a1c1c;padding:8px 10px;margin:8px 0}
        .ok{background:#0c2a14;border:1px solid #1c5a2c;padding:8px 10px;margin:8px 0}
        .empty{opacity:.75;padding:10px}
        .card{border:1px solid #222;background:#0b0b0b;margin:8px 0;padding:10px}
        .title{font-weight:800}
        .slug{opacity:.7;font-weight:400;font-size:12px}
        .desc{margin-top:6px;opacity:.9;white-space:pre-wrap}
        .sub{margin-top:6px;opacity:.75;font-size:12px}
        .actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
        .invite{margin-top:10px}
        label{display:block;font-size:12px;opacity:.8;margin-top:8px}
        input{width:100%;background:#000;border:1px solid #333;color:#fff;padding:8px}
        textarea{width:100%;background:#000;border:1px solid #333;color:#fff;padding:8px;resize:vertical}
        .feed{border:1px solid #111;background:#060606;margin:10px 0;padding:10px}
        .feedTitle{font-weight:800;margin-bottom:6px}

        .split{display:grid;grid-template-columns: 1fr 1fr;gap:10px}
        .col{min-width:0}
        .miniTitle{font-weight:800;font-size:12px;opacity:.9;margin:6px 0}
        .feedMeta{display:flex;align-items:center;gap:8px;margin:8px 0}
        .feedList{display:flex;flex-direction:column;gap:10px}
        .post{border-top:1px solid #111;padding-top:10px}
        .post:first-child{border-top:0;padding-top:0}
        .postActions{display:flex;gap:8px;justify-content:flex-end;margin:6px 0}
        .postHidden{opacity:.65}

        .activity{display:flex;flex-direction:column;gap:10px;margin-top:8px}
        .actRow{display:flex;gap:10px;justify-content:space-between;align-items:flex-start;border-top:1px solid #111;padding-top:10px}
        .actRow:first-child{border-top:0;padding-top:0}
        .actMain{min-width:0}
        .actAction{font-size:12px}
        .actDetail{margin-top:4px;font-size:12px;opacity:.85;white-space:pre-wrap;word-break:break-word}
        .actAt{font-size:11px;opacity:.6;white-space:nowrap}
        .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
        .moreRow{display:flex;justify-content:flex-end;margin-top:6px}

        .pendingList{display:flex;flex-direction:column;gap:10px}
        .pendingRow{border-top:1px solid #111;padding-top:10px}
        .pendingRow:first-child{border-top:0;padding-top:0}
        .pendingText{margin-top:6px;white-space:pre-wrap;word-break:break-word}

        @media (max-width: 960px){
          .split{grid-template-columns: 1fr}
        }
      </style>

      <bsky-panel-shell dense title="Group">
        ${this.error ? `<div class="err">${esc(this.error)}</div>` : ''}
        ${this.notice ? `<div class="ok">${esc(this.notice)}</div>` : ''}
        ${body}
      </bsky-panel-shell>
    `;
  }
}

customElements.define('bsky-group-home', BskyGroupHome);
