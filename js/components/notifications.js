import { call } from '../api.js';
import { getAuthStatusCached, isNotConnectedError } from '../auth_state.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) =>
  ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[m])
);
const fmtTime = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return ''; } };

// Convert at://did/app.bsky.feed.post/rkey → https://bsky.app/profile/did/post/rkey
const atUriToWebPost = (uri) => {
  const m = String(uri || '').match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)/);
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : '';
};

const REASONS = ['follow','like','reply','repost','mention','quote','subscribed-post','subscribed'];

class BskyNotifications extends HTMLElement {
  constructor(){
    super();
    this.attachShadow({mode:'open'});
    this.items = [];
    this.loading = false;
    this.error = null;
    this.view = 'list'; // 'list' | 'masonry'
    // followMap[did] = { following:boolean, followedBy:boolean, muted:boolean, blocking:boolean }
    this.followMap = {};
    this.filters = { hours:24, reasons:new Set(REASONS), onlyNotFollowed:false };
    this._bulkState = { running:false, done:0, total:0 };

    this._refreshRecentHandler = (e) => {
      const mins = Number(e?.detail?.minutes ?? 2);
      this.refreshRecent(mins);
    };
  }

  connectedCallback(){
    this.render();
    this.load();
    this.shadowRoot.addEventListener('change', (e) => this.onChange(e));
    this.shadowRoot.addEventListener('click',  (e) => this.onClick(e));

    window.addEventListener('bsky-refresh-recent', this._refreshRecentHandler);

    this._authChangedHandler = (e) => {
      const connected = !!e?.detail?.connected;
      if (!connected) {
        this.items = [];
        this.error = 'Bluesky not connected.';
        this.render();
        return;
      }
      this.error = null;
      this.load(true);
    };
    window.addEventListener('bsky-auth-changed', this._authChangedHandler);
  }

  disconnectedCallback(){
    window.removeEventListener('bsky-refresh-recent', this._refreshRecentHandler);
    if (this._authChangedHandler) window.removeEventListener('bsky-auth-changed', this._authChangedHandler);
  }

  notifKey(n){
    const a = n?.author || {};
    return [
      n?.uri || '',
      n?.reason || '',
      n?.reasonSubject || '',
      a?.did || '',
      n?.indexedAt || n?.createdAt || ''
    ].join('|');
  }

  async refreshRecent(minutes=2){
    if (this.loading) return;
    const mins = Math.max(1, Number(minutes || 2));
    const since = Date.now() - (mins * 60 * 1000);

    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) return;

      const reasons = Array.from(this.filters.reasons);
      // DB-first: query cached notifications (cache_status auto-sync keeps DB warm).
      const data = await call('cacheQueryNotifications', {
        hours: 1,
        reasons,
        limit: 200,
        offset: 0,
        newestFirst: true,
      });

      const batch = data.items || data.notifications || [];
      if (!batch.length) return;

      const have = new Set(this.items.map(n => this.notifKey(n)));
      const fresh = [];
      for (const n of batch) {
        const t = new Date(n.indexedAt || n.createdAt || 0).getTime();
        if (!t || Number.isNaN(t) || t < since) continue;
        const k = this.notifKey(n);
        if (have.has(k)) continue;
        have.add(k);
        fresh.push(n);
      }

      if (fresh.length) {
        this.items = [...fresh, ...this.items];

        const dids = Array.from(new Set(fresh.map(n => n?.author?.did).filter(Boolean)))
          .filter(did => !this.followMap[did]);
        if (dids.length) {
          await this.populateRelationships(dids);
        }

        this.render();
      }
    } catch (e) {
      // Silent; auto refresh shouldn't disrupt the UI.
      console.warn('notifications refreshRecent failed', e);
    }
  }

  onChange(e){
    if (e.target.id === 'range') {
      this.filters.hours = Number(e.target.value || 24);
      this.load(true);
      return;
    }
    if (e.target.id === 'only-not-followed') {
      this.filters.onlyNotFollowed = !!e.target.checked;
      this.render();
      return;
    }
    const reason = e.target?.getAttribute?.('data-reason');
    if (reason) {
      if (e.target.checked) this.filters.reasons.add(reason);
      else this.filters.reasons.delete(reason);
      this.load(true);
    }

    if (e.target.id === 'view') {
      this.view = String(e.target.value || 'list');
      this.render();
      return;
    }
  }

  onClick(e){
    if (e.target.closest('#reload'))      { this.load(true); return; }
    if (e.target.closest('#follow-all'))  { this.followAll(e.target.closest('#follow-all')); return; }
    const followBtn = e.target.closest('[data-follow-did]');
    if (followBtn) { this.followOne(followBtn.getAttribute('data-follow-did'), followBtn); return; }
  }

  async load(reset=false){
    if (this.loading) return;
    this.loading = true;
    if (reset) this.items = [];
    this.render();

    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) {
        this.items = [];
        this.error = 'Not connected. Use the Connect button.';
        return;
      }

      const reasons = Array.from(this.filters.reasons);
      // DB-first: query cached notifications.
      let data = await call('cacheQueryNotifications', {
        hours: this.filters.hours,
        reasons,
        limit: 500,
        offset: 0,
        newestFirst: true,
      });

      // If cache is empty on a reset load, seed with a recent sync.
      const firstBatch = data.items || data.notifications || [];
      if (reset && firstBatch.length === 0) {
        await call('cacheSyncRecent', { minutes: 60 });
        data = await call('cacheQueryNotifications', {
          hours: this.filters.hours,
          reasons,
          limit: 500,
          offset: 0,
          newestFirst: true,
        });
      }

      this.items = data.items || data.notifications || [];

      // collect unique DIDs we need relationship info for
      const dids = Array.from(new Set(this.items.map(n => n?.author?.did).filter(Boolean)));
      if (dids.length) {
        await this.populateRelationships(dids);
      }

      this.error = null;
    } catch(e) {
      this.error = isNotConnectedError(e) ? 'Not connected. Use the Connect button.' : e.message;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  async populateRelationships(dids){
    // client-side chunking (≤25) in case the server ever changes or other endpoints call it
    const chunks = [];
    for (let i = 0; i < dids.length; i += 25) chunks.push(dids.slice(i, i+25));

    const map = {...this.followMap};
    for (const chunk of chunks) {
      try {
        const rel = await call('getRelationships', { actors: chunk });
        (rel.relationships || []).forEach(r => {
          map[r.did] = {
            following: !!r.following,
            followedBy: !!r.followedBy,
            muted: !!r.muted,
            blocking: !!r.blockedBy || !!r.blocking
          };
        });
      } catch (err) {
        // Fallback: use profiles.viewer flags (server also chunks getProfiles)
        try {
          const prof = await call('getProfiles', { actors: chunk });
          (prof.profiles || []).forEach(p => {
            const v = p.viewer || {};
            map[p.did] = {
              following: !!v.following,
              followedBy: !!v.followedBy,
              muted: !!v.muted,
              blocking: !!v.blockedBy || !!v.blocking
            };
          });
        } catch (_) { /* swallow; we’ll just show raw notifications */ }
      }
    }
    this.followMap = map;
  }

  async followOne(did, btn){
    if (!did) return;
    btn?.setAttribute('disabled','disabled');
    try {
      await call('follow', { did });
      this.followMap[did] = { ...(this.followMap[did] || {}), following: true };
      btn.textContent = 'Following';
      btn.classList.add('following');
    } catch(e) {
      alert('Follow failed: ' + e.message);
      btn?.removeAttribute('disabled');
    }
  }

  async followAll(btn){
    const source = this.filteredItems(); // respect current filters
    const toFollow = Array.from(new Set(
      source
        .map(n => n?.author?.did)
        .filter(did => did && !this.followMap[did]?.following)
    ));
    if (!toFollow.length) return;

    this._bulkState = { running:true, done:0, total:toFollow.length };
    this.render();

    // chunk bulk follow (avoid giant payloads)
    const chunkSize = 50;
    for (let i = 0; i < toFollow.length; i += chunkSize) {
      const chunk = toFollow.slice(i, i + chunkSize);
      try {
        const res = await call('followMany', { dids: chunk });
        Object.keys(res.results || {}).forEach(did => {
          if (res.results[did]?.ok) this.followMap[did] = { ...(this.followMap[did] || {}), following: true };
        });
      } catch (e) {
        // continue; partial success is fine
        console.warn('followMany chunk failed', e);
      } finally {
        this._bulkState.done = Math.min(this._bulkState.total, this._bulkState.done + chunk.length);
        this.render();
      }
    }

    this._bulkState.running = false;
    this.render();
  }

  labelFor(n){
    const who = n.author?.displayName || n.author?.handle || n.author?.did || 'Someone';
    switch (n.reason) {
      case 'like': return `${who} liked your post`;
      case 'reply': return `${who} replied to you`;
      case 'repost': return `${who} reposted you`;
      case 'mention': return `${who} mentioned you`;
      case 'quote': return `${who} quoted your post`;
      case 'follow': return `${who} started following you`;
      case 'subscribed':
      case 'subscribed-post': return `New post from ${who}`;
      default: return `${who} ${n.reason || ''}`.trim();
    }
  }

  filteredItems(){
    const onlyNotFollowed = this.filters.onlyNotFollowed;
    const items = this.items.filter(n => {
      if (!this.filters.reasons.has(n.reason)) return false;
      if (!onlyNotFollowed) return true;
      const did = n.author?.did;
      return did && !this.followMap[did]?.following;
    });
    // Newest first
    items.sort((a,b) => new Date(b.indexedAt || b.createdAt || 0) - new Date(a.indexedAt || a.createdAt || 0));
    return items;
  }

  render(){
    const bulkBadge = this._bulkState.running
      ? `<span class="bulk-progress">Following ${this._bulkState.done}/${this._bulkState.total}…</span>`
      : '';

    const filters = `
      <div class="filters">
        <label>Range:
          <select id="range">
            <option value="24" ${this.filters.hours===24?'selected':''}>Last 24h</option>
            <option value="72" ${this.filters.hours===72?'selected':''}>Last 3 days</option>
            <option value="168" ${this.filters.hours===168?'selected':''}>Last 7 days</option>
            <option value="720" ${this.filters.hours===720?'selected':''}>Last 30 days</option>
          </select>
        </label>
        <label class="only-not"><input type="checkbox" id="only-not-followed" ${this.filters.onlyNotFollowed?'checked':''}> Only not-followed</label>
        <div class="reasons">
          ${REASONS.map(r => `
            <label><input type="checkbox" data-reason="${r}" ${this.filters.reasons.has(r)?'checked':''}> ${r}</label>
          `).join('')}
        </div>
        <div class="bulk">
          <label>View:
            <select id="view">
              <option value="list" ${this.view==='list'?'selected':''}>List</option>
              <option value="masonry" ${this.view==='masonry'?'selected':''}>Masonry</option>
            </select>
          </label>
          <button id="reload" ${this.loading?'disabled':''}>Refresh</button>
          <button id="follow-all" ${this.loading || this._bulkState.running?'disabled':''}>Follow all shown</button>
          ${bulkBadge}
        </div>
      </div>
    `;

    const rows = this.filteredItems().map(n => {
      const a = n.author || {};
      const t = fmtTime(n.indexedAt || n.createdAt || '');
      const rel = this.followMap[a.did] || {};
      const following = !!rel.following;
      const followsYou = !!rel.followedBy;
      const open = atUriToWebPost(n.reasonSubject);
      const cta = a.did && !following
        ? `<button class="follow-btn" data-follow-did="${esc(a.did)}">${followsYou ? 'Follow back' : 'Follow'}</button>`
        : `<span class="following-badge" ${following?'':'style="display:none"'}>${followsYou ? 'Mutuals' : 'Following'}</span>`;

      return `<div class="n">
        <img class="av" src="${esc(a.avatar || '')}" alt="" onerror="this.style.display='none'">
        <div class="txt">
          <div class="line">${esc(this.labelFor(n))} ${followsYou ? '<span class="chip">Follows you</span>' : ''}</div>
          <div class="sub">@${esc(a.handle || '')} • ${esc(t)}${open ? ` • <a class="open" href="${esc(open)}" target="_blank" rel="noopener">Open</a>` : ''}</div>
        </div>
        <div class="act">${cta}</div>
      </div>`;
    }).join('');

    this.shadowRoot.innerHTML = `
      <style>
        :host, *, *::before, *::after{box-sizing:border-box}
        :host{display:block;margin:12px 0}
        .wrap{border:1px solid #333;border-radius:12px;padding:10px;background:#070707;color:#fff}
        .head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
        .filters{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
        .filters label{color:#ddd}
        .only-not{margin-left:6px}
        .reasons{display:flex;gap:10px;flex-wrap:wrap}
        .bulk{margin-left:auto;display:flex;gap:8px;align-items:center}
        .bulk-progress{color:#bbb;font-size:.9rem}

        .list{width:100%}
        .list.masonry{column-width:350px; column-gap:12px}
        .list.masonry .n{break-inside:avoid; display:inline-flex; width:100%}

        .n{display:flex;align-items:center;gap:10px;border:1px solid #333;border-radius:10px;padding:8px;margin:8px 0;background:#0f0f0f}
        .av{width:32px;height:32px;border-radius:50%;background:#222;object-fit:cover}
        .sub{color:#bbb;font-size:.9rem}
        .chip{background:#1e2e1e;color:#89f0a2;border:1px solid #2e5a3a;border-radius:999px;padding:1px 6px;font-size:.75rem;margin-left:6px}
        .following-badge{color:#7bdc86;font-size:.9rem}
        .open{color:#9cd3ff}
        .muted{color:#aaa}
        button{background:#111;border:1px solid #555;color:#fff;padding:6px 10px;border-radius:8px;cursor:pointer}
        button:disabled{opacity:.6;cursor:not-allowed}
        select{background:#0f0f0f;color:#fff;border:1px solid #333;border-radius:10px;padding:6px 10px}
      </style>
      <div class="wrap">
        <div class="head"><div><strong>Notifications</strong></div></div>
        ${filters}
        <div class="list ${esc(this.view)}">
          ${rows || (this.loading ? '<div class="muted">Loading…</div>' : '<div class="muted">No notifications in this range.</div>')}
        </div>
        ${this.error ? `<div class="muted" style="color:#f88">Error: ${esc(this.error)}</div>` : ''}
      </div>`;
  }
}
customElements.define('bsky-notifications', BskyNotifications);
