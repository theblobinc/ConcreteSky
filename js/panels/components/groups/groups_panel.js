import { call } from '../../../api.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));
const escAttr = (s) => esc(String(s || '')).replace(/\n/g, ' ');

export class BskyGroupsPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this.loading = false;
    this.busy = false;
    this.error = '';

    this.meDid = '';
    this.meIsSuper = false;
    this.groups = [];

    this.reviewGroupId = 0;
    this.reviewLoading = false;
    this.reviewMembers = [];

    this.inviteByGroupId = new Map();
    this.inviteBusyByGroupId = new Map();
    this.joinInviteToken = '';
  }

  connectedCallback() {
    this.render();
    this.load();

    this.shadowRoot.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      e.preventDefault();

      const action = btn.getAttribute('data-action') || '';
      const groupId = Number(btn.getAttribute('data-group-id') || 0);

      if (action === 'refresh') {
        this.load();
        return;
      }

      if (action === 'join-by-invite') {
        this.joinByInviteToken(this.joinInviteToken);
        return;
      }

      if (action === 'review') {
        if (!groupId) return;
        this.toggleReview(groupId);
        return;
      }

      if (action === 'invite-create') {
        if (!groupId) return;
        this.createInvite(groupId);
        return;
      }

      if (action === 'invite-revoke') {
        if (!groupId) return;
        this.revokeInvites(groupId);
        return;
      }

      if (action === 'approve' || action === 'deny') {
        const memberDid = String(btn.getAttribute('data-member-did') || '').trim();
        if (!groupId || !memberDid) return;
        if (action === 'approve') this.approve(groupId, memberDid);
        if (action === 'deny') this.deny(groupId, memberDid);
        return;
      }

      if (!groupId) return;

      if (action === 'join') this.join(groupId);
      if (action === 'leave') this.leave(groupId);
    });

    this.shadowRoot.addEventListener('submit', (e) => {
      const form = e.target.closest('form[data-create]');
      if (!form) return;
      e.preventDefault();
      this.createFromForm(form);
    });

    this.shadowRoot.addEventListener('input', (e) => {
      const el = e.target;
      if (!(el instanceof HTMLElement)) return;
      if (el.matches('input[name="invite_token"]')) {
        this.joinInviteToken = String(el.value || '');
      }
    });
  }

  setError(msg) {
    this.error = String(msg || '');
    this.render();
  }

  emitGroupsChanged(detail = {}) {
    try {
      window.dispatchEvent(new CustomEvent('bsky-groups-changed', {
        detail: { ...(detail || {}) },
      }));
    } catch {
      // ignore
    }
  }

  async load() {
    if (this.loading) return;
    this.loading = true;
    this.setError('');
    this.render();
    try {
      const res = await call('groupsList', {});
      this.meDid = String(res?.meDid || '');
      this.meIsSuper = !!res?.meIsSuper;
      this.groups = Array.isArray(res?.groups) ? res.groups : [];

      // Keep review in sync when reloading.
      if (this.reviewGroupId) {
        const stillExists = (this.groups || []).some((g) => Number(g.group_id || 0) === Number(this.reviewGroupId));
        if (!stillExists) {
          this.reviewGroupId = 0;
          this.reviewMembers = [];
        } else if (this.meIsSuper) {
          await this.loadReview(this.reviewGroupId);
        }
      }
    } catch (e) {
      this.setError(e?.message || String(e));
    } finally {
      this.loading = false;
      this.render();
    }
  }

  async toggleReview(groupId) {
    const gid = Number(groupId || 0);
    if (!gid) return;
    if (!this.meIsSuper) {
      this.setError('Super user required to review join requests.');
      return;
    }

    if (this.reviewGroupId === gid) {
      this.reviewGroupId = 0;
      this.reviewMembers = [];
      this.render();
      return;
    }

    this.reviewGroupId = gid;
    await this.loadReview(gid);
  }

  async loadReview(groupId) {
    if (this.reviewLoading) return;
    const gid = Number(groupId || 0);
    if (!gid) return;
    this.reviewLoading = true;
    this.setError('');
    this.render();
    try {
      const res = await call('groupMembersList', { groupId: gid, state: 'pending' });
      this.reviewMembers = Array.isArray(res?.members) ? res.members : [];
    } catch (e) {
      this.setError(e?.message || String(e));
      this.reviewMembers = [];
    } finally {
      this.reviewLoading = false;
      this.render();
    }
  }

  async approve(groupId, memberDid) {
    if (this.busy) return;
    this.busy = true;
    this.setError('');
    this.render();
    try {
      await call('groupMemberApprove', { groupId, memberDid });
      await this.loadReview(groupId);
      await this.load();
    } catch (e) {
      this.setError(e?.message || String(e));
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async deny(groupId, memberDid) {
    if (this.busy) return;
    if (!confirm('Deny join request?')) return;
    this.busy = true;
    this.setError('');
    this.render();
    try {
      await call('groupMemberDeny', { groupId, memberDid });
      await this.loadReview(groupId);
      await this.load();
    } catch (e) {
      this.setError(e?.message || String(e));
    } finally {
      this.busy = false;
      this.render();
    }
  }

  isInviteBusy(groupId) {
    return !!this.inviteBusyByGroupId.get(Number(groupId || 0));
  }

  setInviteBusy(groupId, busy) {
    const gid = Number(groupId || 0);
    if (!gid) return;
    if (busy) this.inviteBusyByGroupId.set(gid, true);
    else this.inviteBusyByGroupId.delete(gid);
  }

  async createInvite(groupId) {
    const gid = Number(groupId || 0);
    if (!gid) return;
    if (!this.meIsSuper) {
      this.setError('Super user required to create invite links.');
      return;
    }
    if (this.busy || this.isInviteBusy(gid)) return;

    this.setInviteBusy(gid, true);
    this.setError('');
    this.render();
    try {
      const res = await call('groupInviteCreate', { groupId: gid });
      const token = String(res?.token || '');
      if (!token) throw new Error('Invite created but token missing');
      this.inviteByGroupId.set(gid, { token, createdAt: Date.now(), expiresAt: res?.expiresAt || null });
    } catch (e) {
      this.setError(e?.message || String(e));
    } finally {
      this.setInviteBusy(gid, false);
      this.render();
    }
  }

  async revokeInvites(groupId) {
    const gid = Number(groupId || 0);
    if (!gid) return;
    if (!this.meIsSuper) {
      this.setError('Super user required to revoke invite links.');
      return;
    }
    if (this.busy || this.isInviteBusy(gid)) return;
    if (!confirm('Revoke all active invite links for this group?')) return;

    this.setInviteBusy(gid, true);
    this.setError('');
    this.render();
    try {
      await call('groupInviteRevoke', { groupId: gid });
      this.inviteByGroupId.delete(gid);
    } catch (e) {
      this.setError(e?.message || String(e));
    } finally {
      this.setInviteBusy(gid, false);
      this.render();
    }
  }

  async joinByInviteToken(token) {
    const t = String(token || '').trim();
    if (!t) return;
    if (this.busy) return;
    this.busy = true;
    this.setError('');
    this.render();
    try {
      const res = await call('groupInviteJoin', { token: t });
      this.joinInviteToken = '';
      await this.load();
      const gid = Number(res?.groupId || 0);
      this.emitGroupsChanged({ reason: 'invite_join', groupId: (gid > 0 ? gid : undefined) });
    } catch (e) {
      this.setError(e?.message || String(e));
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async join(groupId) {
    if (this.busy) return;
    this.busy = true;
    this.setError('');
    this.render();
    try {
      await call('groupJoin', { groupId });
      await this.load();
      this.emitGroupsChanged({ reason: 'join', groupId: (Number(groupId || 0) || undefined) });
    } catch (e) {
      this.setError(e?.message || String(e));
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async leave(groupId) {
    if (this.busy) return;
    if (!confirm('Leave group?')) return;
    this.busy = true;
    this.setError('');
    this.render();
    try {
      await call('groupLeave', { groupId });
      await this.load();
      this.emitGroupsChanged({ reason: 'leave', groupId: (Number(groupId || 0) || undefined) });
    } catch (e) {
      this.setError(e?.message || String(e));
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async createFromForm(form) {
    if (this.busy) return;
    const slug = (form.querySelector('input[name="slug"]')?.value || '').trim();
    const name = (form.querySelector('input[name="name"]')?.value || '').trim();
    const description = (form.querySelector('textarea[name="description"]')?.value || '').trim();
    const visibility = (form.querySelector('select[name="visibility"]')?.value || 'public').trim();
    if (!slug || !name) return;

    this.busy = true;
    this.setError('');
    this.render();
    try {
      const res = await call('groupCreate', { slug, name, description, visibility });
      try { form.reset(); } catch {}
      await this.load();
      const gid = Number(res?.groupId || 0);
      this.emitGroupsChanged({ reason: 'created', groupId: (gid > 0 ? gid : undefined) });
    } catch (e) {
      this.setError(e?.message || String(e));
    } finally {
      this.busy = false;
      this.render();
    }
  }

  render() {
    const groups = Array.isArray(this.groups) ? this.groups : [];

    const inviteJoinForm = `
      <form data-join-invite>
        <div class="title">Join via invite link</div>
        <div class="hint">Paste an invite token to join a secret group.</div>
        <label>Invite token</label>
        <input name="invite_token" placeholder="paste token" value="${escAttr(this.joinInviteToken)}" ${this.busy ? 'disabled' : ''} />
        <div style="display:flex;justify-content:flex-end;margin-top:10px">
          <button class="btn" type="button" data-action="join-by-invite" ${this.busy ? 'disabled' : ''}>Join</button>
        </div>
      </form>
    `;

    const rows = groups.map((g) => {
      const id = Number(g.group_id || 0);
      const slug = String(g.slug || '');
      const name = String(g.name || slug || `#${id}`);
      const vis = String(g.visibility || 'public');
      const membersCount = (g.members_count ?? g.membersCount ?? '—');
      const myState = String(g.my_state || '');
      const myRole = String(g.my_role || '');

      const canJoin = !myState;
      const canLeave = (myState === 'member' || myState === 'pending');

      const statusBits = [
        vis ? `Visibility: ${vis}` : '',
        (myState ? `You: ${myState}${myRole ? ` (${myRole})` : ''}` : 'You: not a member'),
        (membersCount !== null && typeof membersCount !== 'undefined') ? `Members: ${membersCount}` : '',
      ].filter(Boolean).join(' • ');

      const joinBtn = canJoin
        ? `<button class="btn" type="button" data-action="join" data-group-id="${escAttr(id)}" ${this.busy ? 'disabled' : ''}>Join</button>`
        : '';

      const leaveBtn = canLeave
        ? `<button class="btn" type="button" data-action="leave" data-group-id="${escAttr(id)}" ${this.busy ? 'disabled' : ''}>Leave</button>`
        : '';

      const reviewBtn = this.meIsSuper
        ? `<button class="btn" type="button" data-action="review" data-group-id="${escAttr(id)}" ${this.busy || this.reviewLoading ? 'disabled' : ''}>
            ${this.reviewGroupId === id ? 'Hide requests' : 'Review requests'}
          </button>`
        : '';

      const reviewOpen = this.meIsSuper && (this.reviewGroupId === id);
      const pendingRows = reviewOpen
        ? (Array.isArray(this.reviewMembers) && this.reviewMembers.length
            ? this.reviewMembers.map((m) => {
                const did = String(m.member_did || '');
                return `
                  <div class="pending-row">
                    <div class="pending-did">${esc(did)}</div>
                    <div class="pending-actions">
                      <button class="btn" type="button" data-action="approve" data-group-id="${escAttr(id)}" data-member-did="${escAttr(did)}" ${this.busy ? 'disabled' : ''}>Approve</button>
                      <button class="btn" type="button" data-action="deny" data-group-id="${escAttr(id)}" data-member-did="${escAttr(did)}" ${this.busy ? 'disabled' : ''}>Deny</button>
                    </div>
                  </div>
                `;
              }).join('')
            : `<div class="muted">${this.reviewLoading ? 'Loading requests…' : 'No pending requests.'}</div>`)
        : '';

      const inviteState = this.inviteByGroupId.get(id) || null;
      const inviteToken = inviteState?.token ? String(inviteState.token) : '';
      const inviteBusy = this.isInviteBusy(id);
      const inviteUi = this.meIsSuper ? `
        <div class="invite">
          <div class="invite-title">Invite link (admin-only)</div>
          <div class="invite-actions">
            <button class="btn" type="button" data-action="invite-create" data-group-id="${escAttr(id)}" ${this.busy || inviteBusy ? 'disabled' : ''}>
              ${inviteToken ? 'Rotate invite' : 'Create invite'}
            </button>
            <button class="btn" type="button" data-action="invite-revoke" data-group-id="${escAttr(id)}" ${this.busy || inviteBusy ? 'disabled' : ''}>
              Revoke invites
            </button>
          </div>
          ${inviteToken ? `<div class="invite-token"><span class="muted">Token (shown once):</span> <span class="mono">${esc(inviteToken)}</span></div>` : `<div class="muted">Create an invite to join secret groups.</div>`}
        </div>
      ` : '';

      return `
        <div class="card">
          <div class="row">
            <div class="meta">
              <div class="title">${esc(name)} <span class="slug">/${esc(slug)}</span></div>
              ${g.description ? `<div class="desc">${esc(g.description)}</div>` : ''}
              <div class="sub">${esc(statusBits)}</div>
            </div>
            <div class="actions">
              ${joinBtn}
              ${leaveBtn}
              ${reviewBtn}
            </div>
          </div>

          ${reviewOpen ? `<div class="pending">
            <div class="pending-title">Pending join requests</div>
            ${pendingRows}
          </div>` : ''}

          ${inviteUi}
        </div>
      `;
    }).join('');

    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block;color:var(--bsky-fg,#fff);font-family:var(--bsky-font-family,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif)}
        .wrap{padding:10px}
        .top{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
        .top .title{font-weight:700}
        .top .spacer{flex:1}
        .btn{background:var(--bsky-btn-bg,#111);border:1px solid var(--bsky-border,#333);color:var(--bsky-fg,#fff);padding:6px 10px;cursor:pointer}
        .btn[disabled]{opacity:.6;cursor:not-allowed}
        .muted{color:var(--bsky-muted-fg,rgba(255,255,255,.75));font-size:12px}
        .err{background:var(--bsky-danger-bg,#2a0c0c);border:1px solid var(--bsky-danger-border,#5a1c1c);padding:8px 10px;margin:8px 0}
        .card{border:1px solid var(--bsky-border-soft,#222);background:var(--bsky-surface,#0b0b0b);margin:8px 0;padding:10px}
        .row{display:flex;gap:10px;align-items:flex-start}
        .meta{flex:1;min-width:0}
        .title{font-weight:700}
        .slug{opacity:.7;font-weight:400;font-size:12px}
        .desc{margin-top:6px;opacity:.9;white-space:pre-wrap}
        .sub{margin-top:6px;opacity:.75;font-size:12px}
        .actions{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start}
        .pending{margin-top:10px;border-top:1px solid var(--bsky-border-soft,#222);padding-top:10px}
        .pending-title{font-weight:700;font-size:12px;opacity:.85;margin-bottom:8px}
        .pending-row{display:flex;gap:10px;align-items:center;justify-content:space-between;border:1px solid var(--bsky-border-subtle,#111);background:var(--bsky-bg,#070707);padding:8px;margin:6px 0}
        .pending-did{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-size:12px;opacity:.95;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .pending-actions{display:flex;gap:8px;flex-wrap:wrap}
        .invite{margin-top:10px;border-top:1px solid var(--bsky-border-soft,#222);padding-top:10px}
        .invite-title{font-weight:700;font-size:12px;opacity:.85;margin-bottom:8px}
        .invite-actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
        .invite-token{margin-top:6px}
        .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace}
        form{border:1px solid var(--bsky-border-soft,#222);background:var(--bsky-surface,#0b0b0b);margin-top:12px;padding:10px}
        label{display:block;font-size:12px;opacity:.8;margin-top:8px}
        input, textarea, select{width:100%;background:var(--bsky-input-bg,#000);border:1px solid var(--bsky-border,#333);color:var(--bsky-fg,#fff);padding:8px}
        textarea{min-height:70px;resize:vertical}
        .hint{font-size:12px;opacity:.7;margin-top:6px}
      </style>
      <div class="wrap">
        <div class="top">
          <div class="title">Groups</div>
          <div class="muted">Site-local groups (Facebook Groups parity) tied to your DID.</div>
          <div class="spacer"></div>
          <button class="btn" type="button" data-action="refresh" ${this.loading || this.busy ? 'disabled' : ''}>
            ${this.loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        ${this.error ? `<div class="err">${esc(this.error)}</div>` : ''}

        ${inviteJoinForm}

        ${rows || (this.loading ? '<div class="muted">Loading…</div>' : '<div class="muted">No groups yet.</div>')}

        <form data-create style="${this.meIsSuper ? '' : 'display:none'}">
          <div class="title">Create group (admin-only MVP)</div>
          <label>Slug</label>
          <input name="slug" placeholder="my-group" pattern="[a-z0-9][a-z0-9-]{1,63}" ${this.busy ? 'disabled' : ''} />
          <label>Name</label>
          <input name="name" placeholder="My Group" ${this.busy ? 'disabled' : ''} />
          <label>Description</label>
          <textarea name="description" placeholder="What is this group about?" ${this.busy ? 'disabled' : ''}></textarea>
          <label>Visibility</label>
          <select name="visibility" ${this.busy ? 'disabled' : ''}>
            <option value="public">public</option>
            <option value="closed">closed</option>
            <option value="secret">secret</option>
          </select>
          <div style="display:flex;justify-content:flex-end;margin-top:10px">
            <button class="btn" type="submit" ${this.busy ? 'disabled' : ''}>Create</button>
          </div>
        </form>
      </div>
    `;
  }
}

customElements.define('bsky-groups-panel', BskyGroupsPanel);
