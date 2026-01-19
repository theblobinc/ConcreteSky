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

    this.auditFilterAction = '';
    this.auditSearch = '';
    this.auditExportBusy = false;
    this.auditExportLimit = 1000;

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

    // Phrase filters (mods).
    this.filtersLoading = false;
    this.filtersItems = [];
    this.filtersError = '';
    this.filterPhrase = '';
    this.filterAction = 'require_approval';

    // Report queue (mods).
    this.reportsLoading = false;
    this.reportsItems = [];
    this.reportsCursor = null;
    this.reportsHasMore = false;
    this.reportsError = '';
    this.reportsState = 'open';

    // Members moderation (mods).
    this.membersLoading = false;
    this.membersItems = [];
    this.membersError = '';
    this.membersState = '';

    // Group rules.
    this.rulesEditText = '';
    this.rulesDirty = false;
    this.rulesBusy = false;
    this.rulesAcceptBusy = false;

    // Posting settings (mods).
    this.postCooldownSeconds = 0;
    this.postCooldownDirty = false;
    this.postingSettingsBusy = false;

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
      if (action === 'refresh-audit') {
        this.loadAudit(true);
        return;
      }
      if (action === 'audit-export-json') {
        this.exportAudit('json');
        return;
      }
      if (action === 'audit-export-csv') {
        this.exportAudit('csv');
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
      if (action === 'report-post') {
        const uri = String(btn.getAttribute('data-uri') || '').trim();
        if (uri) this.reportPost(uri);
        return;
      }

      if (action === 'refresh-filters') {
        this.loadFilters(true);
        return;
      }
      if (action === 'add-filter') {
        this.addFilter();
        return;
      }
      if (action === 'remove-filter') {
        const phrase = String(btn.getAttribute('data-phrase') || '').trim();
        if (phrase) this.removeFilter(phrase);
        return;
      }

      if (action === 'refresh-reports') {
        this.loadReports(true);
        return;
      }
      if (action === 'more-reports') {
        this.loadReports(false);
        return;
      }
      if (action === 'resolve-report') {
        const rid = Number(btn.getAttribute('data-report-id') || 0);
        if (rid) this.resolveReport(rid, false);
        return;
      }
      if (action === 'resolve-hide-report') {
        const rid = Number(btn.getAttribute('data-report-id') || 0);
        if (rid) this.resolveReport(rid, true);
        return;
      }

      if (action === 'refresh-members') {
        this.loadMembers(true);
        return;
      }
      if (action === 'approve-member') {
        const did = String(btn.getAttribute('data-member-did') || '').trim();
        if (did) this.approveMember(did);
        return;
      }
      if (action === 'deny-member') {
        const did = String(btn.getAttribute('data-member-did') || '').trim();
        if (did) this.denyMember(did);
        return;
      }
      if (action === 'warn-member') {
        const did = String(btn.getAttribute('data-member-did') || '').trim();
        if (did) this.warnMember(did);
        return;
      }
      if (action === 'suspend-member') {
        const did = String(btn.getAttribute('data-member-did') || '').trim();
        if (did) this.suspendMember(did);
        return;
      }
      if (action === 'unsuspend-member') {
        const did = String(btn.getAttribute('data-member-did') || '').trim();
        if (did) this.unsuspendMember(did);
        return;
      }
      if (action === 'ban-member') {
        const did = String(btn.getAttribute('data-member-did') || '').trim();
        if (did) this.banMember(did);
        return;
      }
      if (action === 'unban-member') {
        const did = String(btn.getAttribute('data-member-did') || '').trim();
        if (did) this.unbanMember(did);
        return;
      }
      if (action === 'accept-rules') {
        this.acceptRules();
        return;
      }
      if (action === 'save-rules') {
        this.saveRules();
        return;
      }
      if (action === 'save-posting-settings') {
        this.savePostingSettings();
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
      if (el.matches('input[name="filter_phrase"]')) {
        this.filterPhrase = String(el.value || '');
      }
      if (el.matches('select[name="filter_action"]')) {
        this.filterAction = String(el.value || 'require_approval');
      }
      if (el.matches('select[name="reports_state"]')) {
        const v = String(el.value || 'open');
        this.reportsState = (v === 'resolved') ? 'resolved' : 'open';
        this.loadReports(true);
      }
      if (el.matches('select[name="members_state"]')) {
        const v = String(el.value || '').trim();
        this.membersState = v;
        this.loadMembers(true);
      }
      if (el.matches('textarea[name="rules_md"]')) {
        this.rulesEditText = String(el.value || '');
        this.rulesDirty = true;
      }
      if (el.matches('input[name="post_cooldown_seconds"]')) {
        const n = Number(el.value || 0);
        this.postCooldownSeconds = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
        this.postCooldownDirty = true;
      }

      if (el.matches('input[name="audit_search"]')) {
        this.auditSearch = String(el.value || '');
        this.render();
      }
      if (el.matches('select[name="audit_action"]')) {
        this.auditFilterAction = String(el.value || '');
        this.render();
      }
      if (el.matches('input[name="audit_export_limit"]')) {
        const n = Number(el.value || 0);
        this.auditExportLimit = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1000;
        if (this.auditExportLimit > 5000) this.auditExportLimit = 5000;
        this.render();
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

      if (this.group && !this.rulesDirty) {
        this.rulesEditText = String(this.group.rules_md || '');
      }
      if (this.group && !this.postCooldownDirty) {
        const n = Number(this.group.post_cooldown_seconds || 0);
        this.postCooldownSeconds = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
      }
      await this.loadAudit(true);
      await this.loadFeed(true);
      await this.loadPending(true);
      await this.loadMine(true);
      await this.loadHidden(true);
      await this.loadFilters(true);
      await this.loadReports(true);
      await this.loadMembers(true);
    } catch (e) {
      this.group = null;
      this.setError(e?.message || String(e));
    } finally {
      this.loading = false;
      this.render();
    }
  }

  async loadMembers(reset = false) {
    const g = this.group;
    if (!this.groupId || !g) return;
    const myRole = String(g?.my_role || '');
    const isMod = (myRole === 'admin' || myRole === 'moderator');
    if (!isMod) return;

    if (this.membersLoading) return;
    this.membersLoading = true;
    this.membersError = '';
    if (reset) this.membersItems = [];
    this.render();
    try {
      const res = await call('groupMembersList', { groupId: this.groupId, ...(this.membersState ? { state: this.membersState } : {}) });
      this.membersItems = Array.isArray(res?.members) ? res.members : [];
    } catch (e) {
      this.membersError = e?.message || String(e);
    } finally {
      this.membersLoading = false;
      this.render();
    }
  }

  async approveMember(memberDid) {
    if (!this.groupId || !this.group) return;
    this.setError('');
    this.setNotice('');
    try {
      await call('groupMemberApprove', { groupId: this.groupId, memberDid });
      await this.loadMembers(true);
      await this.loadAudit(true);
      this.setNotice('Member approved.');
    } catch (e) {
      this.setError(e?.message || String(e));
    }
  }

  async denyMember(memberDid) {
    if (!this.groupId || !this.group) return;
    const note = prompt('Reason? (optional)') || '';
    if (!confirm(`Deny membership for ${memberDid}?`)) return;
    this.setError('');
    this.setNotice('');
    try {
      await call('groupMemberDeny', { groupId: this.groupId, memberDid, ...(note ? { note } : {}) });
      await this.loadMembers(true);
      await this.loadAudit(true);
      this.setNotice('Member denied.');
    } catch (e) {
      this.setError(e?.message || String(e));
    }
  }

  async warnMember(memberDid) {
    if (!this.groupId || !this.group) return;
    const note = prompt('Warn note? (optional)') || '';
    this.setError('');
    this.setNotice('');
    try {
      await call('groupMemberWarn', { groupId: this.groupId, memberDid, ...(note ? { note } : {}) });
      await this.loadMembers(true);
      await this.loadAudit(true);
      this.setNotice('Warning applied.');
    } catch (e) {
      this.setError(e?.message || String(e));
    }
  }

  async suspendMember(memberDid) {
    if (!this.groupId || !this.group) return;
    const raw = prompt('Suspend for how many minutes? (e.g. 60)') || '';
    const minutes = Number(raw);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    const note = prompt('Suspend note? (optional)') || '';
    this.setError('');
    this.setNotice('');
    try {
      await call('groupMemberSuspend', { groupId: this.groupId, memberDid, suspendSeconds: Math.floor(minutes * 60), ...(note ? { note } : {}) });
      await this.loadMembers(true);
      await this.loadAudit(true);
      this.setNotice('Member suspended.');
    } catch (e) {
      this.setError(e?.message || String(e));
    }
  }

  async unsuspendMember(memberDid) {
    if (!this.groupId || !this.group) return;
    if (!confirm(`Unsuspend ${memberDid}?`)) return;
    this.setError('');
    this.setNotice('');
    try {
      await call('groupMemberUnsuspend', { groupId: this.groupId, memberDid });
      await this.loadMembers(true);
      await this.loadAudit(true);
      this.setNotice('Member unsuspended.');
    } catch (e) {
      this.setError(e?.message || String(e));
    }
  }

  async banMember(memberDid) {
    if (!this.groupId || !this.group) return;
    if (!confirm(`Ban ${memberDid} from this group?`)) return;
    const note = prompt('Ban note? (optional)') || '';
    this.setError('');
    this.setNotice('');
    try {
      await call('groupMemberBan', { groupId: this.groupId, memberDid, ...(note ? { note } : {}) });
      await this.loadMembers(true);
      await this.loadAudit(true);
      this.setNotice('Member banned.');
    } catch (e) {
      this.setError(e?.message || String(e));
    }
  }

  async unbanMember(memberDid) {
    if (!this.groupId || !this.group) return;
    if (!confirm(`Unban ${memberDid}? (They will need to re-join / be re-approved)`)) return;
    this.setError('');
    this.setNotice('');
    try {
      await call('groupMemberUnban', { groupId: this.groupId, memberDid });
      await this.loadMembers(true);
      await this.loadAudit(true);
      this.setNotice('Member unbanned.');
    } catch (e) {
      this.setError(e?.message || String(e));
    }
  }

  async loadFilters(reset = false) {
    const g = this.group;
    if (!this.groupId || !g) return;
    const myRole = String(g?.my_role || '');
    const isMod = (myRole === 'admin' || myRole === 'moderator');
    if (!isMod) return;

    if (this.filtersLoading) return;
    this.filtersLoading = true;
    this.filtersError = '';
    if (reset) this.filtersItems = [];
    this.render();
    try {
      const res = await call('groupPhraseFiltersList', { groupId: this.groupId });
      this.filtersItems = Array.isArray(res?.items) ? res.items : [];
    } catch (e) {
      this.filtersError = e?.message || String(e);
    } finally {
      this.filtersLoading = false;
      this.render();
    }
  }

  async addFilter() {
    const g = this.group;
    if (!this.groupId || !g) return;
    const phrase = String(this.filterPhrase || '').trim();
    if (!phrase) return;
    const action = (String(this.filterAction || 'require_approval') === 'deny') ? 'deny' : 'require_approval';
    this.setError('');
    this.setNotice('');
    try {
      await call('groupPhraseFilterAdd', { groupId: this.groupId, phrase, action });
      this.filterPhrase = '';
      await this.loadFilters(true);
      await this.loadAudit(true);
      this.setNotice('Filter saved.');
    } catch (e) {
      this.setError(e?.message || String(e));
    }
  }

  async removeFilter(phrase) {
    const g = this.group;
    if (!this.groupId || !g) return;
    if (!confirm(`Remove filter "${phrase}"?`)) return;
    this.setError('');
    this.setNotice('');
    try {
      await call('groupPhraseFilterRemove', { groupId: this.groupId, phrase });
      await this.loadFilters(true);
      await this.loadAudit(true);
      this.setNotice('Filter removed.');
    } catch (e) {
      this.setError(e?.message || String(e));
    }
  }

  async loadReports(reset = false) {
    const g = this.group;
    if (!this.groupId || !g) return;
    const myRole = String(g?.my_role || '');
    const isMod = (myRole === 'admin' || myRole === 'moderator');
    if (!isMod) return;

    if (this.reportsLoading) return;
    if (!reset && !this.reportsHasMore) return;

    this.reportsLoading = true;
    this.reportsError = '';
    if (reset) {
      this.reportsItems = [];
      this.reportsCursor = null;
      this.reportsHasMore = false;
    }
    this.render();
    try {
      const res = await call('groupReportsList', {
        groupId: this.groupId,
        state: this.reportsState,
        limit: 50,
        ...(this.reportsCursor ? { cursor: Number(this.reportsCursor) } : {}),
      });
      const items = Array.isArray(res?.items) ? res.items : [];
      if (reset) this.reportsItems = items;
      else this.reportsItems = [...(this.reportsItems || []), ...items];
      this.reportsCursor = res?.cursor ? String(res.cursor) : null;
      this.reportsHasMore = !!this.reportsCursor;
    } catch (e) {
      this.reportsError = e?.message || String(e);
    } finally {
      this.reportsLoading = false;
      this.render();
    }
  }

  async resolveReport(reportId, hide) {
    const g = this.group;
    if (!this.groupId || !g) return;
    const note = prompt('Resolution note? (optional)') || '';
    this.setError('');
    this.setNotice('');
    try {
      await call('groupReportResolve', { groupId: this.groupId, reportId, ...(note ? { note } : {}), ...(hide ? { hide: true } : {}) });
      await this.loadReports(true);
      await this.loadHidden(true);
      await this.loadAudit(true);
      this.setNotice(hide ? 'Report resolved and post hidden.' : 'Report resolved.');
    } catch (e) {
      this.setError(e?.message || String(e));
    }
  }

  async reportPost(uri) {
    const g = this.group;
    if (!this.groupId || !g) return;
    if (String(g?.my_state || '') !== 'member' && String(g?.visibility || '') !== 'public') return;
    const reason = prompt('Report reason? (optional)') || '';
    this.setError('');
    this.setNotice('');
    try {
      await call('groupReportCreate', { groupId: this.groupId, uri, ...(reason ? { reason } : {}) });
      this.setNotice('Report submitted.');
      await this.loadAudit(true);
      await this.loadReports(true);
    } catch (e) {
      this.setError(e?.message || String(e));
    }
  }

  async acceptRules() {
    const g = this.group;
    if (!this.groupId || !g) return;
    const myState = String(g?.my_state || '');
    if (myState !== 'member' && myState !== 'pending') return;
    const rulesMd = String(g?.rules_md || '');
    if (!rulesMd.trim()) return;
    const acceptedAt = String(g?.my_rules_accepted_at || '');
    if (acceptedAt) return;

    if (this.rulesAcceptBusy) return;
    this.rulesAcceptBusy = true;
    this.setError('');
    this.setNotice('');
    this.render();
    try {
      await call('groupRulesAccept', { groupId: this.groupId });
      await this.load();
      this.setNotice('Rules accepted.');
    } catch (e) {
      this.setError(e?.message || String(e));
    } finally {
      this.rulesAcceptBusy = false;
      this.render();
    }
  }

  async saveRules() {
    const g = this.group;
    if (!this.groupId || !g) return;
    const myRole = String(g?.my_role || '');
    const isMod = (myRole === 'admin' || myRole === 'moderator');
    if (!isMod) return;

    if (this.rulesBusy) return;
    this.rulesBusy = true;
    this.setError('');
    this.setNotice('');
    this.render();
    try {
      await call('groupRulesUpdate', { groupId: this.groupId, rulesMd: String(this.rulesEditText || '') });
      this.rulesDirty = false;
      await this.load();
      this.setNotice('Rules saved. Members will need to re-accept.');
    } catch (e) {
      this.setError(e?.message || String(e));
    } finally {
      this.rulesBusy = false;
      this.render();
    }
  }

  async savePostingSettings() {
    const g = this.group;
    if (!this.groupId || !g) return;
    const myRole = String(g?.my_role || '');
    const isMod = (myRole === 'admin' || myRole === 'moderator');
    if (!isMod) return;

    if (this.postingSettingsBusy) return;
    this.postingSettingsBusy = true;
    this.setError('');
    this.setNotice('');
    this.render();
    try {
      await call('groupPostingSettingsUpdate', { groupId: this.groupId, postCooldownSeconds: Number(this.postCooldownSeconds || 0) });
      this.postCooldownDirty = false;
      await this.load();
      this.setNotice('Posting settings saved.');
    } catch (e) {
      this.setError(e?.message || String(e));
    } finally {
      this.postingSettingsBusy = false;
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

  async exportAudit(format = 'json') {
    if (!this.groupId) return;
    if (this.auditExportBusy) return;
    const f = (String(format || 'json').toLowerCase() === 'csv') ? 'csv' : 'json';

    this.auditExportBusy = true;
    this.setError('');
    this.setNotice('');
    this.render();
    try {
      const limit = Number.isFinite(this.auditExportLimit) ? this.auditExportLimit : 1000;
      const res = await call('groupAuditExport', { groupId: this.groupId, format: f, limit });

      let filename = String(res?.filename || '').trim();
      if (!filename) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        filename = `group_audit_${this.groupId}_${ts}.${f}`;
      }
      filename = filename.replace(/[^a-zA-Z0-9._-]+/g, '_');

      let blob;
      if (f === 'csv') {
        const csv = String(res?.csv || '');
        blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      } else {
        const items = Array.isArray(res?.items) ? res.items : [];
        const json = JSON.stringify({ groupId: this.groupId, exportedAt: new Date().toISOString(), items }, null, 2);
        blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.setNotice(`Exported ${String(res?.count ?? '') || ''} audit rows.`.trim());
    } catch (e) {
      this.setError(e?.message || String(e));
    } finally {
      this.auditExportBusy = false;
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

    const rulesMd = String(g?.rules_md || '');
    const acceptedAt = String(g?.my_rules_accepted_at || '');
    if (rulesMd.trim() && !acceptedAt) {
      this.setError('You must accept the group rules before posting.');
      return;
    }

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
    const mySuspendedUntil = g ? String(g.my_suspended_until || '') : '';
    const myBannedAt = g ? String(g.my_banned_at || '') : '';
    const isMod = g && (myRole === 'admin' || myRole === 'moderator');

    const nowMs = Date.now();
    const mySuspendedMs = mySuspendedUntil ? Date.parse(mySuspendedUntil) : NaN;
    const isSuspended = Number.isFinite(mySuspendedMs) && mySuspendedMs > nowMs;
    const isBanned = !!myBannedAt || myState === 'blocked';

    const rulesMd = g ? String(g.rules_md || '') : '';
    const hasRules = !!rulesMd.trim();
    const myRulesAcceptedAt = g ? String(g.my_rules_accepted_at || '') : '';
    const cooldownSeconds = g ? Number(g.post_cooldown_seconds || 0) : 0;

    const canJoin = g && !myState;
    const canLeave = g && (myState === 'member' || myState === 'pending');
    const canPost = g && (myState === 'member') && (!hasRules || !!myRulesAcceptedAt) && !isSuspended && !isBanned;
    const canReport = g && (myState === 'member' || vis === 'public');
    const groupTag = g ? groupTagFromSlug(slug) : '';

    const statusBits = g ? [
      vis ? `Visibility: ${vis}` : '',
      (myState ? `You: ${myState}${myRole ? ` (${myRole})` : ''}` : 'You: not a member'),
      (membersCount !== null && typeof membersCount !== 'undefined') ? `Members: ${membersCount}` : '',
      (cooldownSeconds && cooldownSeconds > 0) ? `Slow mode: ${Math.floor(cooldownSeconds)}s` : '',
    ].filter(Boolean).join(' • ') : '';

    const secretInvite = (g && vis === 'secret' && !myState) ? `
      <div class="invite">
        <div class="muted">This is a secret group. You need an invite token to join.</div>
        <label>Invite token</label>
        <input name="invite_token" placeholder="paste token" value="${escAttr(this.inviteToken)}" ${this.busy ? 'disabled' : ''} />
      </div>
    ` : '';

    const rulesBlock = (g && (hasRules || isMod)) ? (() => {
      const acceptedRow = (hasRules && (myState === 'member' || myState === 'pending') && !myRulesAcceptedAt)
        ? `<div class="actions">
            <button class="btn" type="button" data-action="accept-rules" ${this.rulesAcceptBusy ? 'disabled' : ''}>Accept rules</button>
            <div class="muted">You must accept before posting.</div>
          </div>`
        : (hasRules && myRulesAcceptedAt)
          ? `<div class="muted">Rules accepted: <span class="mono">${esc(myRulesAcceptedAt)}</span></div>`
          : '';

      const view = hasRules
        ? `<div class="rulesBox">${esc(rulesMd)}</div>`
        : `<div class="muted">No rules set.</div>`;

      const edit = isMod ? `
        <label>Edit rules (markdown)</label>
        <textarea name="rules_md" rows="10" ${this.rulesBusy ? 'disabled' : ''}>${esc(this.rulesEditText)}</textarea>
        <div class="actions">
          <button class="btn" type="button" data-action="save-rules" ${this.rulesBusy ? 'disabled' : ''}>Save rules</button>
        </div>
      ` : '';

      return `
        <div class="card">
          <div class="title">Group rules</div>
          ${view}
          ${acceptedRow}
          ${edit}
        </div>
      `;
    })() : '';

    const rulesGateNotice = (g && myState === 'member' && hasRules && !myRulesAcceptedAt)
      ? `<div class="card">
          <div class="title">Posting locked</div>
          <div class="muted">You must accept the group rules before posting.</div>
        </div>`
      : '';

    const enforcementNotice = (g && (isBanned || isSuspended))
      ? `<div class="card">
          <div class="title">Posting restricted</div>
          ${isBanned ? `<div class="muted">You are banned from this group.</div>` : ''}
          ${(!isBanned && isSuspended) ? `<div class="muted">You are suspended until <span class="mono">${esc(mySuspendedUntil)}</span>.</div>` : ''}
        </div>`
      : '';

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

    const auditLog = (() => {
      if (!g || !isMod) return '';

      const raw = Array.isArray(this.auditItems) ? this.auditItems : [];
      const q = String(this.auditSearch || '').trim().toLowerCase();
      const a = String(this.auditFilterAction || '').trim();

      const filtered = raw.filter((it) => {
        if (a && String(it?.action || '') !== a) return false;
        if (!q) return true;
        const hay = [it?.action, it?.actor_did, it?.subject, it?.created_at, it?.detail]
          .map((x) => String(x || '').toLowerCase())
          .join(' ');
        return hay.includes(q);
      });

      const actions = Array.from(new Set(raw.map((it) => String(it?.action || '')).filter(Boolean))).sort();
      const rows = filtered.length
        ? `<div class="auditList">${filtered.map((it) => {
            const at = String(it.created_at || '');
            const action = String(it.action || '');
            const actor = String(it.actor_did || '');
            const subject = String(it.subject || '');
            let detail = '';
            try {
              const d = it.detail ? JSON.parse(String(it.detail)) : null;
              if (d && typeof d === 'object') detail = JSON.stringify(d);
            } catch {
              detail = String(it.detail || '');
            }
            return `<div class="auditRow">
              <div class="auditTop">
                <div class="auditWhen mono">${esc(at)}</div>
                <div class="auditWho"><span class="mono">${esc(action)}</span> <span class="muted">by</span> <span class="mono">${esc(actor)}</span></div>
              </div>
              ${subject ? `<div class="auditSub"><span class="muted">subject:</span> <span class="mono">${esc(subject)}</span></div>` : ''}
              ${detail ? `<div class="auditDetail">${esc(detail)}</div>` : ''}
            </div>`;
          }).join('')}</div>`
        : `<div class="muted">${this.auditLoading ? 'Loading audit log…' : 'No audit entries match your filters.'}</div>`;

      const moreBtn = this.auditHasMore
        ? `<button class="btn" type="button" data-action="more-activity" ${this.auditLoading ? 'disabled' : ''}>Load more</button>`
        : '';

      return `
        <div class="card">
          <div class="title">Audit log (mods)</div>
          <div class="muted">Who did what, when. Export is capped to 5000 rows.</div>

          <div class="auditControls">
            <div class="auditCtl">
              <label>Search</label>
              <input name="audit_search" value="${escAttr(this.auditSearch)}" placeholder="action / actor DID / subject / text" />
            </div>
            <div class="auditCtl">
              <label>Action</label>
              <select name="audit_action">
                <option value="" ${!a ? 'selected' : ''}>All</option>
                ${actions.map((x) => `<option value="${escAttr(x)}" ${a === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}
              </select>
            </div>
            <div class="auditCtl">
              <label>Export limit</label>
              <input name="audit_export_limit" value="${escAttr(this.auditExportLimit)}" />
            </div>
          </div>

          <div class="actions">
            <button class="btn" type="button" data-action="refresh-audit" ${this.auditLoading ? 'disabled' : ''}>Refresh</button>
            ${moreBtn || ''}
            <div style="flex:1"></div>
            <button class="btn" type="button" data-action="audit-export-json" ${this.auditExportBusy ? 'disabled' : ''}>Export JSON</button>
            <button class="btn" type="button" data-action="audit-export-csv" ${this.auditExportBusy ? 'disabled' : ''}>Export CSV</button>
          </div>

          <div style="margin-top:10px;">
            ${rows}
          </div>
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
            const controls = uri ? `<div class="postActions">
                ${isMod ? (isHidden
                  ? `<button class="btn" type="button" data-action="unhide-post" data-uri="${escAttr(uri)}" ${this.hiddenLoading ? 'disabled' : ''}>Unhide</button>`
                  : `<button class="btn" type="button" data-action="hide-post" data-uri="${escAttr(uri)}" ${this.hiddenLoading ? 'disabled' : ''}>Hide</button>`) : ''}
                ${canReport ? `<button class="btn" type="button" data-action="report-post" data-uri="${escAttr(uri)}">Report</button>` : ''}
              </div>` : '';
            const badge = (isMod && isHidden) ? `<div class="muted" style="margin-bottom:6px;">Hidden from group feed</div>` : '';
            return `<div class="post ${isHidden ? 'postHidden' : ''}">${badge}${controls}${renderPostCard(p)}</div>`;
          }).join('')}</div>`;

      const more = this.feedHasMore
        ? `<div class="moreRow"><button class="btn" type="button" data-action="more-feed" ${this.feedLoading ? 'disabled' : ''}>Load more</button></div>`
        : '';

      return `${header}${list}${more}`;
    })();

    const postingSettings = (() => {
      if (!g || !isMod) return '';
      return `
        <div class="feedMeta">
          <div class="muted">Posting settings</div>
        </div>
        <label>Slow mode (seconds between submissions)</label>
        <input name="post_cooldown_seconds" type="number" min="0" max="86400" value="${escAttr(String(this.postCooldownSeconds || 0))}" ${this.postingSettingsBusy ? 'disabled' : ''} />
        <div class="actions">
          <button class="btn" type="button" data-action="save-posting-settings" ${this.postingSettingsBusy ? 'disabled' : ''}>Save</button>
        </div>
      `;
    })();

    const filters = (() => {
      if (!g || !isMod) return '';
      const items = Array.isArray(this.filtersItems) ? this.filtersItems : [];
      const err = this.filtersError ? `<div class="err">${esc(this.filtersError)}</div>` : '';
      const rows = (items.length === 0)
        ? `<div class="muted">${this.filtersLoading ? 'Loading…' : 'No filters yet.'}</div>`
        : `<div class="pendingList">${items.map((f) => {
            const phrase = String(f.phrase || '');
            const action = String(f.action || 'require_approval');
            return `
              <div class="pendingRow">
                <div class="muted"><span class="mono">${esc(action)}</span> • <span class="mono">${esc(phrase)}</span></div>
                <div class="actions">
                  <button class="btn" type="button" data-action="remove-filter" data-phrase="${escAttr(phrase)}" ${this.filtersLoading ? 'disabled' : ''}>Remove</button>
                </div>
              </div>
            `;
          }).join('')}</div>`;

      return `
        ${err}
        <div class="feedMeta">
          <div class="muted">Phrase filters</div>
          <div style="flex:1"></div>
          <button class="btn" type="button" data-action="refresh-filters" ${this.filtersLoading ? 'disabled' : ''}>Refresh</button>
        </div>
        <label>Add phrase</label>
        <input name="filter_phrase" placeholder="keyword or phrase" value="${escAttr(this.filterPhrase)}" ${this.filtersLoading ? 'disabled' : ''} />
        <label>Action</label>
        <select name="filter_action" ${this.filtersLoading ? 'disabled' : ''}>
          <option value="require_approval" ${this.filterAction === 'require_approval' ? 'selected' : ''}>Require approval</option>
          <option value="deny" ${this.filterAction === 'deny' ? 'selected' : ''}>Deny</option>
        </select>
        <div class="actions">
          <button class="btn" type="button" data-action="add-filter" ${this.filtersLoading ? 'disabled' : ''}>Save filter</button>
        </div>
        ${rows}
      `;
    })();

    const reports = (() => {
      if (!g || !isMod) return '';
      const items = Array.isArray(this.reportsItems) ? this.reportsItems : [];
      const err = this.reportsError ? `<div class="err">${esc(this.reportsError)}</div>` : '';
      const stateLabel = (this.reportsState === 'resolved') ? 'Resolved reports' : 'Open reports';
      const list = (items.length === 0)
        ? `<div class="muted">${this.reportsLoading ? 'Loading…' : (this.reportsState === 'resolved' ? 'No resolved reports.' : 'No open reports.')}</div>`
        : `<div class="pendingList">${items.map((r) => {
            const rid = String(r.report_id || '');
            const uri = String(r.post_uri || '');
            const who = String(r.reporter_did || '');
            const reason = String(r.reason || '');
            const at = String(r.created_at || '');
            return `
              <div class="pendingRow">
                <div class="muted">#${esc(rid)} • ${esc(at)} • <span class="mono">${esc(who)}</span></div>
                <div class="muted">URI: <span class="mono">${esc(uri)}</span></div>
                ${reason ? `<div class="pendingText">${esc(reason)}</div>` : ''}
                <div class="actions">
                  ${this.reportsState === 'open'
                    ? `<button class="btn" type="button" data-action="resolve-report" data-report-id="${escAttr(rid)}" ${this.reportsLoading ? 'disabled' : ''}>Resolve</button>
                       <button class="btn" type="button" data-action="resolve-hide-report" data-report-id="${escAttr(rid)}" ${this.reportsLoading ? 'disabled' : ''}>Resolve + Hide</button>`
                    : `<div class="muted">Resolved</div>`}
                </div>
              </div>
            `;
          }).join('')}</div>`;

      const more = this.reportsHasMore
        ? `<div class="moreRow"><button class="btn" type="button" data-action="more-reports" ${this.reportsLoading ? 'disabled' : ''}>Load more</button></div>`
        : '';

      return `
        ${err}
        <div class="feedMeta">
          <div class="muted">${esc(stateLabel)}</div>
          <div style="flex:1"></div>
          <select name="reports_state" ${this.reportsLoading ? 'disabled' : ''}>
            <option value="open" ${this.reportsState === 'open' ? 'selected' : ''}>Open</option>
            <option value="resolved" ${this.reportsState === 'resolved' ? 'selected' : ''}>Resolved</option>
          </select>
          <button class="btn" type="button" data-action="refresh-reports" ${this.reportsLoading ? 'disabled' : ''}>Refresh</button>
        </div>
        ${list}
        ${more}
      `;
    })();

    const members = (() => {
      if (!g || !isMod) return '';
      const items = Array.isArray(this.membersItems) ? this.membersItems : [];
      const err = this.membersError ? `<div class="err">${esc(this.membersError)}</div>` : '';
      const header = `
        <div class="feedMeta">
          <div class="muted">Members</div>
          <div style="flex:1"></div>
          <select name="members_state" ${this.membersLoading ? 'disabled' : ''}>
            <option value="" ${this.membersState === '' ? 'selected' : ''}>All</option>
            <option value="member" ${this.membersState === 'member' ? 'selected' : ''}>Members</option>
            <option value="pending" ${this.membersState === 'pending' ? 'selected' : ''}>Pending</option>
            <option value="blocked" ${this.membersState === 'blocked' ? 'selected' : ''}>Blocked</option>
            <option value="invited" ${this.membersState === 'invited' ? 'selected' : ''}>Invited</option>
          </select>
          <button class="btn" type="button" data-action="refresh-members" ${this.membersLoading ? 'disabled' : ''}>Refresh</button>
        </div>
      `;
      const list = (items.length === 0)
        ? `<div class="muted">${this.membersLoading ? 'Loading…' : 'No members found.'}</div>`
        : `<div class="pendingList">${items.map((m) => {
            const did = String(m.member_did || '');
            const state = String(m.state || '');
            const role = String(m.role || '');
            const warnCount = Number(m.warn_count || 0);
            const suspendedUntil = String(m.suspended_until || '');
            const bannedAt = String(m.banned_at || '');

            const suspendedMs = suspendedUntil ? Date.parse(suspendedUntil) : NaN;
            const suspended = Number.isFinite(suspendedMs) && suspendedMs > Date.now();
            const banned = !!bannedAt || state === 'blocked';

            const badges = [
              role ? `<span class="badge">${esc(role)}</span>` : '',
              state ? `<span class="badge badgeDim">${esc(state)}</span>` : '',
              warnCount > 0 ? `<span class="badge badgeWarn">warns:${esc(String(warnCount))}</span>` : '',
              suspended ? `<span class="badge badgeSusp">suspended</span>` : '',
              banned ? `<span class="badge badgeBan">banned</span>` : '',
            ].filter(Boolean).join(' ');

            const approveBtns = (state === 'pending')
              ? `<button class="btn" type="button" data-action="approve-member" data-member-did="${escAttr(did)}" ${this.membersLoading ? 'disabled' : ''}>Approve</button>
                 <button class="btn" type="button" data-action="deny-member" data-member-did="${escAttr(did)}" ${this.membersLoading ? 'disabled' : ''}>Deny</button>`
              : '';

            const sanctionBtns = `
              <button class="btn" type="button" data-action="warn-member" data-member-did="${escAttr(did)}" ${this.membersLoading ? 'disabled' : ''}>Warn</button>
              ${suspended ? `<button class="btn" type="button" data-action="unsuspend-member" data-member-did="${escAttr(did)}" ${this.membersLoading ? 'disabled' : ''}>Unsuspend</button>`
                : `<button class="btn" type="button" data-action="suspend-member" data-member-did="${escAttr(did)}" ${this.membersLoading ? 'disabled' : ''}>Suspend</button>`}
              ${banned ? `<button class="btn" type="button" data-action="unban-member" data-member-did="${escAttr(did)}" ${this.membersLoading ? 'disabled' : ''}>Unban</button>`
                : `<button class="btn" type="button" data-action="ban-member" data-member-did="${escAttr(did)}" ${this.membersLoading ? 'disabled' : ''}>Ban</button>`}
            `;

            return `
              <div class="pendingRow">
                <div class="muted"><span class="mono">${esc(did)}</span></div>
                ${badges ? `<div class="badges">${badges}</div>` : ''}
                ${suspendedUntil ? `<div class="muted">Suspended until: <span class="mono">${esc(suspendedUntil)}</span></div>` : ''}
                ${bannedAt ? `<div class="muted">Banned at: <span class="mono">${esc(bannedAt)}</span></div>` : ''}
                <div class="actions">
                  ${approveBtns}
                  ${sanctionBtns}
                </div>
              </div>
            `;
          }).join('')}</div>`;
      return `${err}${header}${list}`;
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

                ${rulesBlock}

                ${rulesGateNotice}

                ${enforcementNotice}

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

                ${isMod ? `
                  <div class="card">
                    <div class="title">Moderation (mods)</div>
                    ${postingSettings}
                    <div style="height:10px"></div>
                    ${filters}
                    <div style="height:10px"></div>
                    ${reports}
                  </div>
                ` : ''}

                ${isMod ? `
                  <div class="card">
                    <div class="title">Members (mods)</div>
                    <div class="muted">Warnings/suspensions/bans are site-local and enforced when posting or joining.</div>
                    ${members}
                  </div>
                ` : ''}

                ${auditLog}

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
        select{width:100%;background:#000;border:1px solid #333;color:#fff;padding:8px}
        textarea{width:100%;background:#000;border:1px solid #333;color:#fff;padding:8px;resize:vertical}
        .rulesBox{white-space:pre-wrap;background:#050505;border:1px solid #222;padding:10px;border-radius:10px;line-height:1.4;margin-top:8px}
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

        .auditControls{display:grid;grid-template-columns: 1fr 200px 160px;gap:10px;margin-top:8px}
        .auditCtl{min-width:0}
        .auditList{display:flex;flex-direction:column;gap:10px}
        .auditRow{border-top:1px solid #111;padding-top:10px}
        .auditRow:first-child{border-top:0;padding-top:0}
        .auditTop{display:flex;gap:10px;justify-content:space-between;align-items:flex-start}
        .auditWhen{font-size:11px;opacity:.6;white-space:nowrap}
        .auditWho{font-size:12px;min-width:0;word-break:break-word}
        .auditSub{margin-top:4px;font-size:12px;opacity:.9;word-break:break-word}
        .auditDetail{margin-top:4px;font-size:12px;opacity:.85;white-space:pre-wrap;word-break:break-word}

        .pendingList{display:flex;flex-direction:column;gap:10px}
        .pendingRow{border-top:1px solid #111;padding-top:10px}
        .pendingRow:first-child{border-top:0;padding-top:0}
        .pendingText{margin-top:6px;white-space:pre-wrap;word-break:break-word}

        .badges{margin-top:6px;display:flex;gap:6px;flex-wrap:wrap}
        .badge{font-size:11px;border:1px solid #222;border-radius:999px;padding:2px 8px;background:#080808;opacity:.95}
        .badgeDim{opacity:.7}
        .badgeWarn{border-color:#604a00;color:#ffd27a}
        .badgeSusp{border-color:#1f4b62;color:#98d8ff}
        .badgeBan{border-color:#6b1f1f;color:#ffb3b3}

        @media (max-width: 960px){
          .split{grid-template-columns: 1fr}
          .auditControls{grid-template-columns: 1fr}
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
