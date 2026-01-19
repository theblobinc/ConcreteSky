import { loadJson, saveJson } from '../panels/storage.js';
import { saveDraftMedia, loadDraftMedia, deleteDraftMedia } from '../panels/draft_media_store.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));

export class BskyCommentComposer extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: 'open' });
		this._replyTo = null; // { uri, cid, author }
		this._submitting = false;
		this._maxChars = 300;
		this._threadEnabled = false;
		this._mode = 'reply'; // 'reply' | 'post'
		this._parts = [{ text: '', images: [] }]; // [{ text, images:[{ name, mime, dataBase64, alt }] }]
		this._activePart = 0;
		this._imagesTargetPart = 0;
		this._emojiOpen = false;
		this._settingsOpen = false;

		// Interaction settings (Bluesky threadgate/postgate)
		this._quotesAllowed = true; // postgate embeddingRules disableRule when false
		this._replyGateMode = 'everyone'; // 'everyone' | 'nobody' | 'custom'
		this._replyAllow = { mentions: false, followers: false, following: false, list: false };
		this._replyListUri = '';
		this._lists = null; // [{ uri, name }]
		this._listsLoading = false;
		this._listsError = '';

		// Scheduling (top-level posts only). Stored as a datetime-local string.
		this._scheduledAtLocal = '';

		// Drafts/autosave
		this._draftTimer = null;
	}

	static get observedAttributes() {
		return ['maxchars', 'thread', 'mode'];
	}

	attributeChangedCallback(name, _oldValue, _newValue) {
		if (name === 'maxchars') {
			const raw = Number.parseInt(String(this.getAttribute('maxchars') || '').trim(), 10);
			this._maxChars = Number.isFinite(raw) && raw > 0 ? raw : 300;
			this.render();
			return;
		}
		if (name === 'thread') {
			const v = this.getAttribute('thread');
			this._threadEnabled = (v !== null) && (v !== '0') && (v !== 'false');
			this.render();
			return;
		}
		if (name === 'mode') {
			const v = String(this.getAttribute('mode') || '').trim().toLowerCase();
			this._mode = (v === 'post') ? 'post' : 'reply';
			this.render();
			return;
		}
	}

	setReplyTo(replyTo) {
		this._replyTo = replyTo || null;
		// Reset drafts when switching targets to avoid accidentally posting to the wrong thread.
		this._parts = [{ text: '', images: [] }];
		this._activePart = 0;
		this._imagesTargetPart = 0;
		this._emojiOpen = false;
		this._settingsOpen = false;
		this._loadDraft();
		this.render();
	}

	_draftStorageKey() {
		const scope = String(this.getAttribute('draftscope') || '').trim();
		const mode = String(this._mode || 'reply');
		const replyUri = String(this._replyTo?.uri || '').trim();
		const base = (mode === 'post') ? 'post' : (replyUri ? `reply:${replyUri}` : 'reply');
		const key = scope ? `${scope}|${base}` : base;
		return `bsky:draft:${key}`;
	}

	_scheduleDraftSave() {
		try { clearTimeout(this._draftTimer); } catch {}
		this._draftTimer = setTimeout(() => {
			this._draftTimer = null;
			this._saveDraftNow();
		}, 500);
	}

	_saveDraftNow() {
		const key = this._draftStorageKey();
		try {
			const draft = {
				v: 1,
				ts: Date.now(),
				mode: String(this._mode || 'reply'),
				replyUri: String(this._replyTo?.uri || ''),
				parts: (Array.isArray(this._parts) ? this._parts : []).map((p) => ({ text: String(p?.text || '') })),
				activePart: Number.isFinite(this._activePart) ? this._activePart : 0,
				settings: {
					quotesAllowed: !!this._quotesAllowed,
					replyGateMode: String(this._replyGateMode || 'everyone'),
					replyAllow: { ...this._replyAllow },
					replyListUri: String(this._replyListUri || ''),
					scheduledAtLocal: String(this._scheduledAtLocal || ''),
				},
			};

			const anyText = draft.parts.some((p) => String(p?.text || '').trim());
			const anyImages = (Array.isArray(this._parts) ? this._parts : []).some((p) => Array.isArray(p?.images) && p.images.length);
			if (!anyText && !anyImages) {
				try { localStorage.removeItem(key); } catch {}
				deleteDraftMedia(key).catch(() => {});
				return;
			}
			saveJson(key, draft);
			saveDraftMedia(key, this._parts, draft).catch(() => {});
		} catch {
			// ignore
		}
	}

	_clearDraft() {
		const key = this._draftStorageKey();
		try { localStorage.removeItem(key); } catch {}
		deleteDraftMedia(key).catch(() => {});
	}

	_loadDraft() {
		try {
			const key = this._draftStorageKey();
			const d = loadJson(key, null);
			if (!d || d.v !== 1) {
				// Recovery path: attempt to restore draft snapshot from IndexedDB.
				loadDraftMedia(key).then((media) => {
					try {
						const snap = media?.draft;
						if (!snap || snap.v !== 1) return;
						// Only restore if the snapshot matches our current context.
						const sMode = String(snap.mode || 'reply');
						const sReply = String(snap.replyUri || '');
						if (sMode !== String(this._mode || 'reply')) return;
						if (sMode !== 'post' && sReply !== String(this._replyTo?.uri || '')) return;

						let parts = Array.isArray(snap.parts) ? snap.parts.map((p) => ({ text: String(p?.text || ''), images: [] })) : [];
						parts = parts.slice(0, 10);
						if (!parts.length) parts = [{ text: '', images: [] }];
						if (!this._threadEnabled && parts.length > 1) parts = [parts[0]];
						this._parts = parts;
						this._activePart = Math.max(0, Math.min(Number(snap.activePart || 0), this._parts.length - 1));
						this._imagesTargetPart = this._activePart;

						const s = snap.settings || {};
						this._quotesAllowed = (s.quotesAllowed !== undefined) ? !!s.quotesAllowed : this._quotesAllowed;
						this._replyGateMode = String(s.replyGateMode || this._replyGateMode || 'everyone');
						if (s.replyAllow && typeof s.replyAllow === 'object') {
							this._replyAllow = { ...this._replyAllow, ...s.replyAllow };
						}
						this._replyListUri = (s.replyListUri !== undefined) ? String(s.replyListUri || '') : this._replyListUri;
						this._scheduledAtLocal = (s.scheduledAtLocal !== undefined) ? String(s.scheduledAtLocal || '') : this._scheduledAtLocal;

						// Hydrate images from the same record.
						const mParts = Array.isArray(media?.parts) ? media.parts : [];
						for (let i = 0; i < this._parts.length; i++) {
							const imgs = Array.isArray(mParts[i]?.images) ? mParts[i].images : [];
							this._parts[i].images = imgs.slice(0, 4).map((img) => ({
								name: String(img?.name || ''),
								mime: String(img?.mime || ''),
								dataBase64: String(img?.dataBase64 || ''),
								alt: String(img?.alt || ''),
							})).filter((img) => img.dataBase64 && img.mime);
						}

						this.render();
					} catch {
						// ignore
					}
				}).catch(() => {});
				return;
			}

			// Ensure we're restoring into the same context.
			const dMode = String(d.mode || 'reply');
			const dReply = String(d.replyUri || '');
			if (dMode !== String(this._mode || 'reply')) return;
			if (dMode !== 'post' && dReply !== String(this._replyTo?.uri || '')) return;

			let parts = Array.isArray(d.parts) ? d.parts.map((p) => ({ text: String(p?.text || ''), images: [] })) : [];
			parts = parts.slice(0, 10);
			if (!parts.length) parts = [{ text: '', images: [] }];
			if (!this._threadEnabled && parts.length > 1) parts = [parts[0]];
			this._parts = parts;
			this._activePart = Math.max(0, Math.min(Number(d.activePart || 0), this._parts.length - 1));
			this._imagesTargetPart = this._activePart;

			const s = d.settings || {};
			this._quotesAllowed = (s.quotesAllowed !== undefined) ? !!s.quotesAllowed : this._quotesAllowed;
			this._replyGateMode = String(s.replyGateMode || this._replyGateMode || 'everyone');
			if (s.replyAllow && typeof s.replyAllow === 'object') {
				this._replyAllow = { ...this._replyAllow, ...s.replyAllow };
			}
			this._replyListUri = (s.replyListUri !== undefined) ? String(s.replyListUri || '') : this._replyListUri;
			this._scheduledAtLocal = (s.scheduledAtLocal !== undefined) ? String(s.scheduledAtLocal || '') : this._scheduledAtLocal;

			// Media is stored separately (IndexedDB) to survive reloads without bloating localStorage.
			loadDraftMedia(key).then((media) => {
				try {
					if (!media || (media.v !== 1 && media.v !== 2)) return;
					const mParts = Array.isArray(media.parts) ? media.parts : [];
					for (let i = 0; i < this._parts.length; i++) {
						const imgs = Array.isArray(mParts[i]?.images) ? mParts[i].images : [];
						this._parts[i].images = imgs.slice(0, 4).map((img) => ({
							name: String(img?.name || ''),
							mime: String(img?.mime || ''),
							dataBase64: String(img?.dataBase64 || ''),
							alt: String(img?.alt || ''),
						})).filter((img) => img.dataBase64 && img.mime);
					}
					this.render();
				} catch {
					// ignore
				}
			}).catch(() => {});
		} catch {
			// ignore
		}
	}

	setLists(lists) {
		const inArr = Array.isArray(lists) ? lists : [];
		this._lists = inArr
			.map((l) => ({ uri: String(l?.uri || l?.list?.uri || ''), name: String(l?.name || l?.list?.name || '') }))
			.filter((l) => l.uri)
			.map((l) => ({ uri: l.uri, name: l.name || l.uri }));
		this._listsLoading = false;
		this._listsError = '';
		this.render();
	}

	setListsLoading(v) {
		this._listsLoading = !!v;
		if (this._listsLoading) this._listsError = '';
		this.render();
	}

	setListsError(msg) {
		this._listsLoading = false;
		this._listsError = String(msg || 'Failed to load lists');
		this.render();
	}

	_requestLists() {
		if (this._listsLoading) return;
		this._listsLoading = true;
		this._listsError = '';
		this.render();
		this.dispatchEvent(new CustomEvent('bsky-request-lists', {
			detail: {},
			bubbles: true,
			composed: true,
		}));
	}

	focus() {
		try { this.shadowRoot?.querySelector?.('textarea')?.focus?.(); } catch {}
	}

	connectedCallback() {
		// Prime from attributes.
		this.attributeChangedCallback('maxchars');
		this.attributeChangedCallback('thread');
		this.attributeChangedCallback('mode');
		this._loadDraft();
		this.render();
		this.shadowRoot.addEventListener('click', (e) => this.onClick(e));
		this.shadowRoot.addEventListener('change', (e) => this.onChange(e));
		this.shadowRoot.addEventListener('input', (e) => this.onInput(e));
	}

	onClick(e) {
		if (e.target?.closest?.('[data-clear]')) {
			this.setReplyTo(null);
			this.dispatchEvent(new CustomEvent('bsky-reply-to', { detail: null, bubbles: true, composed: true }));
			return;
		}

		if (e.target?.closest?.('[data-add-images]')) {
			this._imagesTargetPart = this._activePart;
			const inp = this.shadowRoot.getElementById('imgs');
			inp?.click?.();
			return;
		}

		if (e.target?.closest?.('[data-add-gif]')) {
			const url = String(prompt('Paste a GIF URL (it will be inserted into your post text):', '') || '').trim();
			if (!url) return;
			this._insertTextAtCaret(url);
			return;
		}

		const emojiToggle = e.target?.closest?.('[data-emoji-toggle]');
		if (emojiToggle) {
			this._emojiOpen = !this._emojiOpen;
			this._settingsOpen = false;
			this.render();
			return;
		}

		const settingsToggle = e.target?.closest?.('[data-settings-toggle]');
		if (settingsToggle) {
			this._settingsOpen = !this._settingsOpen;
			this._emojiOpen = false;
			if (this._settingsOpen && this._replyGateMode === 'custom' && this._replyAllow?.list && !this._lists && !this._replyTo?.uri) {
				this._requestLists();
			}
			this.render();
			return;
		}

		if (e.target?.closest?.('[data-action="export-draft"]')) {
			this._exportDraft().catch(() => {});
			return;
		}
		if (e.target?.closest?.('[data-action="import-draft"]')) {
			this._importDraft().catch(() => {});
			return;
		}
		if (e.target?.closest?.('[data-action="clear-draft"]')) {
			if (!confirm('Clear this draft?')) return;
			this._parts = [{ text: '', images: [] }];
			this._activePart = 0;
			this._imagesTargetPart = 0;
			this._scheduledAtLocal = '';
			this._clearDraft();
			this.render();
			return;
		}

		if (e.target?.closest?.('[data-clear-schedule]')) {
			this._scheduledAtLocal = '';
			this._scheduleDraftSave();
			this.render();
			return;
		}

		const refreshLists = e.target?.closest?.('[data-refresh-lists]');
		if (refreshLists) {
			this._requestLists();
			return;
		}

		const emoji = e.target?.closest?.('[data-emoji]')?.getAttribute?.('data-emoji');
		if (emoji) {
			this._insertTextAtCaret(String(emoji));
			return;
		}

		const partTab = e.target?.closest?.('[data-part]');
		if (partTab) {
			const idx = Number(partTab.getAttribute('data-part') || -1);
			if (Number.isFinite(idx) && idx >= 0 && idx < this._parts.length) {
				this._activePart = idx;
				this._emojiOpen = false;
				this._settingsOpen = false;
				this.render();
				this.focus();
			}
			return;
		}

		if (e.target?.closest?.('[data-add-part]')) {
			if (!this._threadEnabled) return;
			if (this._parts.length >= 10) return;
			const cur = this._parts[this._activePart] || { text: '', images: [] };
			const curText = String(cur.text || '').trim();
			if (!curText) return;
			this._parts.push({ text: '', images: [] });
			this._activePart = this._parts.length - 1;
			this._emojiOpen = false;
			this._settingsOpen = false;
			this._scheduleDraftSave();
			this.render();
			this.focus();
			return;
		}

		const rmPart = e.target?.closest?.('[data-remove-part]');
		if (rmPart) {
			const idx = Number(rmPart.getAttribute('data-remove-part') || -1);
			if (!Number.isFinite(idx) || idx < 0 || idx >= this._parts.length) return;
			if (this._parts.length <= 1) return;
			this._parts.splice(idx, 1);
			this._activePart = Math.max(0, Math.min(this._activePart, this._parts.length - 1));
			this._emojiOpen = false;
			this._settingsOpen = false;
			this._scheduleDraftSave();
			this.render();
			return;
		}

		const rm = e.target?.closest?.('[data-remove-img]');
		if (rm) {
			const idx = Number(rm.getAttribute('data-remove-img') || -1);
			const pidx = Number(rm.getAttribute('data-remove-img-part') || this._activePart);
			const part = this._parts[pidx];
			if (!part) return;
			if (Number.isFinite(idx) && idx >= 0 && idx < (part.images || []).length) {
				part.images.splice(idx, 1);
				this._scheduleDraftSave();
				this.render();
			}
			return;
		}

		if (e.target?.closest?.('[data-submit]')) {
			const max = Number.isFinite(this._maxChars) && this._maxChars > 0 ? this._maxChars : 300;
			const parts = this._parts
				.map((p) => ({
					text: String(p?.text || ''),
					media: {
						images: Array.isArray(p?.images) ? p.images.map((i) => ({
							name: i?.name || '',
							mime: i?.mime || '',
							dataBase64: i?.dataBase64 || '',
							alt: i?.alt || '',
						})) : [],
					},
				}))
				.filter((p) => String(p.text || '').trim());

			if (!parts.length) return;
			for (const p of parts) {
				if (String(p.text || '').length > max) return;
			}

			// Scheduling is only supported for top-level posts (not replies).
			let scheduledAt = '';
			if (this._mode === 'post' && !(this._replyTo && this._replyTo.uri)) {
				scheduledAt = this._scheduledAtIsoOrEmpty();
				if (scheduledAt) {
					try {
						const ts = Date.parse(scheduledAt);
						if (!Number.isFinite(ts) || ts <= (Date.now() + 10_000)) {
							alert('Scheduled time must be at least ~10 seconds in the future.');
							return;
						}
					} catch {
						scheduledAt = '';
					}
				}
			}

			const replyGateDisabled = !!(this._replyTo && this._replyTo.uri);
			const replyMode = replyGateDisabled ? 'everyone' : String(this._replyGateMode || 'everyone');
			const allow = (() => {
				if (replyMode !== 'custom') return null;
				const a = [];
				if (this._replyAllow?.mentions) a.push('mention');
				if (this._replyAllow?.followers) a.push('followers');
				if (this._replyAllow?.following) a.push('following');
				if (this._replyAllow?.list) a.push('list');
				return a;
			})();
			const interactions = {
				quotes: { allow: !!this._quotesAllowed },
				reply: {
					mode: replyMode,
					allow,
					listUri: String(this._replyListUri || '').trim(),
				},
			};

			if (!replyGateDisabled && replyMode === 'custom' && this._replyAllow?.list && !String(this._replyListUri || '').trim()) {
				try { alert('Please paste a list AT-URI for the list reply rule.'); } catch {}
				return;
			}

			if (parts.length === 1 && !this._threadEnabled) {
				this.dispatchEvent(new CustomEvent('bsky-submit-comment', {
					detail: {
						text: String(parts[0].text || '').trim(),
						replyTo: this._replyTo,
						media: parts[0].media,
						interactions,
						...(scheduledAt ? { scheduledAt } : {}),
					},
					bubbles: true,
					composed: true,
				}));
			} else {
				this.dispatchEvent(new CustomEvent('bsky-submit-thread', {
					detail: {
						parts: parts.map((p) => ({ text: String(p.text || '').trim(), media: p.media })),
						replyTo: this._replyTo,
						maxChars: max,
						interactions,
						...(scheduledAt ? { scheduledAt } : {}),
					},
					bubbles: true,
					composed: true,
				}));
			}

			this._clearDraft();
			this._parts = [{ text: '', images: [] }];
			this._activePart = 0;
			this._imagesTargetPart = 0;
			this._emojiOpen = false;
			this._settingsOpen = false;
			this._scheduledAtLocal = '';
			this.render();
		}
	}

	_exportDraftObj() {
		return {
			v: 1,
			ts: Date.now(),
			mode: String(this._mode || 'reply'),
			replyUri: String(this._replyTo?.uri || ''),
			activePart: Number.isFinite(this._activePart) ? this._activePart : 0,
			settings: {
				quotesAllowed: !!this._quotesAllowed,
				replyGateMode: String(this._replyGateMode || 'everyone'),
				replyAllow: { ...this._replyAllow },
				replyListUri: String(this._replyListUri || ''),
				scheduledAtLocal: String(this._scheduledAtLocal || ''),
			},
			parts: (Array.isArray(this._parts) ? this._parts : []).slice(0, 10).map((p) => ({
				text: String(p?.text || ''),
				images: (Array.isArray(p?.images) ? p.images : []).slice(0, 4).map((img) => ({
					name: String(img?.name || ''),
					mime: String(img?.mime || ''),
					dataBase64: String(img?.dataBase64 || ''),
					alt: String(img?.alt || ''),
				})).filter((img) => img.dataBase64 && img.mime),
			})),
		};
	}

	async _exportDraft() {
		const json = JSON.stringify(this._exportDraftObj());
		try {
			await navigator.clipboard.writeText(json);
			alert('Draft copied to clipboard.');
			return;
		} catch {
			// Fallback: show in prompt.
		}
		try {
			prompt('Draft JSON (copy/paste):', json);
		} catch {
			// ignore
		}
	}

	async _importDraft() {
		let raw = '';
		try {
			raw = String(prompt('Paste draft JSON to import:', '') || '').trim();
		} catch {
			return;
		}
		if (!raw) return;

		let d = null;
		try {
			d = JSON.parse(raw);
		} catch {
			alert('Invalid JSON.');
			return;
		}
		if (!d || d.v !== 1) {
			alert('Unsupported draft format.');
			return;
		}

		let parts = Array.isArray(d.parts) ? d.parts : [];
		parts = parts.slice(0, 10).map((p) => ({
			text: String(p?.text || ''),
			images: (Array.isArray(p?.images) ? p.images : []).slice(0, 4).map((img) => ({
				name: String(img?.name || ''),
				mime: String(img?.mime || ''),
				dataBase64: String(img?.dataBase64 || ''),
				alt: String(img?.alt || ''),
			})).filter((img) => img.dataBase64 && img.mime),
		}));

		if (!parts.length) parts = [{ text: '', images: [] }];
		if (!this._threadEnabled && parts.length > 1) parts = [parts[0]];
		this._parts = parts;

		const ap = Number(d.activePart || 0);
		this._activePart = Math.max(0, Math.min(Number.isFinite(ap) ? ap : 0, this._parts.length - 1));
		this._imagesTargetPart = this._activePart;

		const s = (d.settings && typeof d.settings === 'object') ? d.settings : {};
		this._quotesAllowed = (s.quotesAllowed !== undefined) ? !!s.quotesAllowed : this._quotesAllowed;
		this._replyGateMode = String(s.replyGateMode || this._replyGateMode || 'everyone');
		if (s.replyAllow && typeof s.replyAllow === 'object') {
			this._replyAllow = { ...this._replyAllow, ...s.replyAllow };
		}
		this._replyListUri = (s.replyListUri !== undefined) ? String(s.replyListUri || '') : this._replyListUri;
		this._scheduledAtLocal = (s.scheduledAtLocal !== undefined) ? String(s.scheduledAtLocal || '') : this._scheduledAtLocal;

		this._saveDraftNow();
		this.render();
		alert('Draft imported.');
	}

	onInput(e) {
		const el = e.target;
		if (!el) return;

		const setting = String(el?.getAttribute?.('data-setting') || '');
		if (setting === 'listUri') {
			this._replyListUri = String(el.value || '');
			this._scheduleDraftSave();
			return;
		}
		if (setting === 'listSelect') {
			this._replyListUri = String(el.value || '');
			this._scheduleDraftSave();
			return;
		}

		if (String(el?.tagName || '').toLowerCase() === 'textarea') {
			const part = this._parts[this._activePart];
			if (!part) return;
			part.text = String(el.value || '');
			this._scheduleDraftSave();
			return;
		}

		const idxAttr = el.getAttribute?.('data-alt-idx');
		if (idxAttr == null) return;
		const partAttr = el.getAttribute?.('data-alt-part');
		const pidx = Number(partAttr == null ? this._activePart : partAttr);
		const part = this._parts[pidx];
		if (!part) return;
		const idx = Number(idxAttr);
		if (!Number.isFinite(idx) || idx < 0 || idx >= (part.images || []).length) return;
		part.images[idx].alt = String(el.value || '');
		this._scheduleDraftSave();
	}

	onChange(e) {
		// Preserve existing file input handling by delegating when needed.
		return this._onChangeInternal(e);
	}

	async _onChangeInternal(e) {
		const inp = e.target;
		if (inp?.id === 'imgs') {
			return await this._onImagesChanged(e);
		}

		const name = String(inp?.getAttribute?.('data-setting') || '');
		if (!name) return;

		if (name === 'quotesAllowed') {
			this._quotesAllowed = !!inp?.checked;
			this._scheduleDraftSave();
			this.render();
			return;
		}
		if (name === 'replyMode') {
			this._replyGateMode = String(inp?.value || 'everyone');
			this._scheduleDraftSave();
			this.render();
			return;
		}
		if (name === 'allowMentions') { this._replyAllow.mentions = !!inp?.checked; this._scheduleDraftSave(); this.render(); return; }
		if (name === 'allowFollowers') { this._replyAllow.followers = !!inp?.checked; this._scheduleDraftSave(); this.render(); return; }
		if (name === 'allowFollowing') { this._replyAllow.following = !!inp?.checked; this._scheduleDraftSave(); this.render(); return; }
		if (name === 'allowList') {
			this._replyAllow.list = !!inp?.checked;
			this._scheduleDraftSave();
			if (this._replyAllow.list && this._settingsOpen && this._replyGateMode === 'custom' && !this._lists && !this._replyTo?.uri) {
				this._requestLists();
				return;
			}
			this.render();
			return;
		}
		if (name === 'scheduledAt') {
			this._scheduledAtLocal = String(inp?.value || '');
			this._scheduleDraftSave();
			this.render();
			return;
		}
		if (name === 'listUri') { this._replyListUri = String(inp?.value || ''); this._scheduleDraftSave(); return; }
		if (name === 'listSelect') { this._replyListUri = String(inp?.value || ''); this._scheduleDraftSave(); return; }
	}

	async _onImagesChanged(e) {
		// Moved original file-input handler here so onChange can also handle settings.
		const inp = e.target;
		if (inp?.id !== 'imgs') return;

		const files = Array.from(inp.files || []);
		if (!files.length) return;

		const part = this._parts[this._imagesTargetPart] || this._parts[this._activePart];
		if (!part) return;

		// Limit to 4 images per Bluesky embed.images.
		const existing = Array.isArray(part.images) ? part.images : [];
		const remaining = Math.max(0, 4 - existing.length);
		const take = files.slice(0, remaining);

		const readOne = (file) => new Promise((resolve) => {
			try {
				const r = new FileReader();
				r.onload = () => {
					const url = String(r.result || '');
					const m = url.match(/^data:([^;]+);base64,(.*)$/);
					if (!m) return resolve(null);
					resolve({
						name: String(file?.name || ''),
						mime: String(m[1] || ''),
						dataBase64: String(m[2] || ''),
						alt: '',
					});
				};
				r.onerror = () => resolve(null);
				r.readAsDataURL(file);
			} catch {
				resolve(null);
			}
		});

		const added = [];
		for (const f of take) {
			const mt = String(f?.type || '');
			if (!mt.startsWith('image/')) continue;
			if (Number(f?.size || 0) > (2 * 1024 * 1024)) continue;
			const item = await readOne(f);
			if (item && item.mime && item.dataBase64) added.push(item);
		}

		if (added.length) {
			part.images = [...existing, ...added].slice(0, 4);
			this.render();
		}

		try { inp.value = ''; } catch {}
	}

	_insertTextAtCaret(text) {
		const ta = this.shadowRoot?.querySelector?.('textarea');
		if (!ta) return;
		try {
			const v = String(ta.value || '');
			const s = (typeof ta.selectionStart === 'number') ? ta.selectionStart : v.length;
			const e = (typeof ta.selectionEnd === 'number') ? ta.selectionEnd : s;
			const ins = String(text || '');
			const next = v.slice(0, s) + ins + v.slice(e);
			ta.value = next;
			try { ta.selectionStart = ta.selectionEnd = s + ins.length; } catch {}
			const part = this._parts[this._activePart];
			if (part) part.text = next;
			this._scheduleDraftSave();
			this.render();
			try { ta.focus(); } catch {}
		} catch {
			// ignore
		}
	}

	_scheduledAtIsoOrEmpty() {
		const raw = String(this._scheduledAtLocal || '').trim();
		if (!raw) return '';
		try {
			const d = new Date(raw);
			if (!Number.isFinite(d.getTime())) return '';
			return d.toISOString();
		} catch {
			return '';
		}
	}

	render() {
		const max = Number.isFinite(this._maxChars) && this._maxChars > 0 ? this._maxChars : 300;
		const who = (this._mode === 'post') ? 'Write a post' : (this._replyTo?.author ? `Reply to ${String(this._replyTo.author || '')}` : 'Reply');
		const cur = this._parts[this._activePart] || { text: '', images: [] };
		const curText = String(cur.text || '');
		const curLen = curText.length;
		const remaining = max - curLen;
		const over = remaining < 0;
		const warn = !over && remaining <= 50;
		const ringColor = over ? '#ff4d4d' : (warn ? '#ffb020' : '#7bd88f');
		const r = 12;
		const circ = Math.round(2 * Math.PI * r);
		const ratio = max > 0 ? Math.min(1, Math.max(0, curLen / max)) : 0;
		const dash = Math.round(circ * ratio);

		const canSubmit = (() => {
			const parts = Array.isArray(this._parts) ? this._parts : [];
			let any = false;
			for (const p of parts) {
				const t = String(p?.text || '').trim();
				if (!t) continue;
				any = true;
				if (t.length > max) return false;
			}
			return any;
		})();

		const replyGateDisabled = !!(this._replyTo && this._replyTo.uri);
		const mode = String(this._replyGateMode || 'everyone');
		const allowMentions = !!this._replyAllow?.mentions;
		const allowFollowers = !!this._replyAllow?.followers;
		const allowFollowing = !!this._replyAllow?.following;
		const allowList = !!this._replyAllow?.list;
		const listUri = String(this._replyListUri || '').trim();
		const lists = Array.isArray(this._lists) ? this._lists : null;
		const listsLoading = !!this._listsLoading;
		const listsError = String(this._listsError || '').trim();

		const scheduleAllowed = (this._mode === 'post') && !(this._replyTo && this._replyTo.uri);
		const scheduledAtLocal = String(this._scheduledAtLocal || '').trim();

		this.shadowRoot.innerHTML = `
			<style>
				:host, *, *::before, *::after{box-sizing:border-box}
				:host{display:block}
				.bar{display:flex; align-items:center; gap:8px; margin-bottom:6px; color:#bbb}
				.bar .who{font-weight:700; color:#eaeaea; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
				.bar button{margin-left:auto}

				.parts{display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin:6px 0}
				.pill{display:inline-flex; align-items:center; gap:6px; padding:4px 8px; border:1px solid #222; background:#0b0b0b; color:#fff; border-radius:999px; cursor:pointer; font-size:12px}
				.pill[data-active="1"]{border-color:#3b5a8f; box-shadow:0 0 0 2px rgba(47,75,122,.18)}
				.pill .x{display:inline-block; width:16px; height:16px; border-radius:999px; border:1px solid #333; background:#111; color:#bbb; line-height:14px; text-align:center; font-size:12px}
				.pill .x:hover{border-color:#3b5a8f; color:#fff}
				.pillAdd{padding:4px 10px}

				.media{margin-top:8px}
				.thumbs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:6px}
				.thumb{border:1px solid #222;background:#0b0b0b;padding:6px}
				.thumb img{width:100%;height:auto;display:block;background:#111}
				.thumb input{width:100%;margin-top:6px;background:#0b0b0b;color:#fff;border:1px solid #222;padding:6px}
				.thumb .rm{margin-top:6px;width:100%}

				textarea{width:100%; min-height:80px; resize:vertical; border-radius: var(--bsky-radius, 0px); border:1px solid #222; background:#0b0b0b; color:#fff; padding:8px; outline:none}
				textarea[data-over="1"]{border-color:#ff4d4d; box-shadow:0 0 0 2px rgba(255,77,77,.2)}
				textarea:focus{border-color:#2f4b7a; box-shadow:0 0 0 2px rgba(47,75,122,.25)}

				.tools{display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:8px}
				.toolBtns{display:flex; align-items:center; gap:6px}
				.iconBtn{appearance:none; border:1px solid #222; background:#0b0b0b; color:#fff; border-radius:999px; padding:6px 8px; cursor:pointer; line-height:1}
				.iconBtn:hover{border-color:#3b5a8f}
				.counter{display:flex; align-items:center; gap:8px; color:#ddd; font-variant-numeric: tabular-nums}
				.counter .n{min-width:36px; text-align:right; color:${esc(over ? '#ff4d4d' : (warn ? '#ffb020' : '#fff'))}}
				.counter svg{display:block}
				.counter .bg{stroke:#232E3E}
				.counter .fg{stroke:${esc(ringColor)}}

				.emoji{position:relative}
				.emojiPop{position:absolute; left:0; bottom:42px; background:#0b0b0b; border:1px solid #222; border-radius:12px; padding:8px; display:grid; grid-template-columns:repeat(10, 1fr); gap:6px; width:min(340px, 90vw); z-index:5}
				.emojiPop button{padding:6px 0; border-radius:8px}

				.settings{margin-top:10px;border:1px solid #222;background:#070707;padding:10px}
				.settings h4{margin:0 0 8px 0;font-size:13px;color:#ddd}
				.settings .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
				.settings label{display:flex;gap:6px;align-items:center;color:#ddd}
				.settings .note{color:#aaa;font-size:12px;margin-top:6px}
				.settings input[type="text"], .settings input[type="datetime-local"]{background:#0b0b0b;color:#fff;border:1px solid #222;padding:6px 8px;border-radius:0;min-width:min(420px, 90vw)}
				.settings select{background:#0b0b0b;color:#fff;border:1px solid #222;padding:6px 8px;border-radius:0;min-width:min(420px, 90vw)}

				.actions{display:flex; justify-content:flex-end; gap:8px; margin-top:8px}
				button{appearance:none; border:1px solid #333; background:#111; color:#fff; border-radius: var(--bsky-radius, 0px); padding:6px 10px; cursor:pointer}
				button:hover{border-color:#3b5a8f}
				button:disabled{opacity:.6; cursor:not-allowed}
				.muted{color:#aaa}
			</style>

			<div class="bar">
				<div class="who">${esc(who)}</div>
				${this._replyTo ? `<button type="button" data-clear title="Clear reply target">Clear</button>` : ''}
			</div>

			${this._threadEnabled ? `
				<div class="parts" aria-label="Thread parts">
					${this._parts.map((p, i) => {
						const t = String(p?.text || '').trim();
						const label = `Part ${i + 1}` + (t ? '' : ' (empty)');
						return `
							<button type="button" class="pill" data-part="${i}" data-active="${i === this._activePart ? '1' : '0'}" title="${esc(label)}">
								${esc(i + 1)}
								${this._parts.length > 1 ? `<span class="x" data-remove-part="${i}" title="Remove">×</span>` : ''}
							</button>
						`;
					}).join('')}
					<button type="button" class="pill pillAdd" data-add-part title="Add another post to this reply thread">+</button>
				</div>
			` : ''}

			<textarea placeholder="${esc(who)}..." data-over="${over ? '1' : '0'}">${esc(curText)}</textarea>

			<div class="tools">
				<div class="toolBtns">
					<button type="button" class="iconBtn" data-add-images title="Add images">🖼</button>
					<button type="button" class="iconBtn" data-add-gif title="Insert GIF link">GIF</button>
					<button type="button" class="iconBtn" data-settings-toggle title="Post interaction settings">⚙</button>
					<span class="emoji">
						<button type="button" class="iconBtn" data-emoji-toggle title="Emoji">☺</button>
						${this._emojiOpen ? `
							<div class="emojiPop" role="dialog" aria-label="Emoji picker">
								${[
									'😀','😅','😂','😊','😍','🤔','😎','😭','😡','👍',
									'👎','🙏','🎉','🔥','💯','✨','🫡','🤝','🧠','👀',
									'💙','❤️','🖤','💚','💛','🤍','💜','🧡','🌟','🚀',
								].map((em) => `<button type="button" class="iconBtn" data-emoji="${esc(em)}" title="${esc(em)}">${esc(em)}</button>`).join('')}
							</div>
						` : ''}
					</span>
				</div>
				<div class="counter" title="${esc(curLen)} / ${esc(max)}">
					<div class="n">${esc(remaining)}</div>
					<svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
						<circle class="bg" cx="15" cy="15" r="${r}" fill="none" stroke-width="2"></circle>
						<circle class="fg" cx="15" cy="15" r="${r}" fill="none" stroke-width="3" stroke-dasharray="${dash} ${Math.max(0, Math.round(circ - dash))}" transform="rotate(-90 15 15)"></circle>
					</svg>
				</div>
			</div>

			${this._settingsOpen ? `
				<div class="settings" role="group" aria-label="Post interaction settings">
					<h4>Interaction settings</h4>
					<div class="row">
						<label><input type="checkbox" data-setting="quotesAllowed" ${this._quotesAllowed ? 'checked' : ''}> Allow quote posts</label>
					</div>
					<div class="note">Turning this off creates a postgate (disables embedding/quotes).</div>

					<h4 style="margin-top:12px">Who can reply</h4>
					${replyGateDisabled ? `
						<div class="note">Reply controls apply to new root posts. This composer is replying to an existing post, so reply controls are disabled here.</div>
					` : `
						<div class="row">
							<label><input type="radio" name="replymode" data-setting="replyMode" value="everyone" ${mode==='everyone' ? 'checked' : ''}> Everyone</label>
							<label><input type="radio" name="replymode" data-setting="replyMode" value="nobody" ${mode==='nobody' ? 'checked' : ''}> Nobody</label>
							<label><input type="radio" name="replymode" data-setting="replyMode" value="custom" ${mode==='custom' ? 'checked' : ''}> Custom</label>
						</div>
						${mode==='custom' ? `
							<div class="row" style="margin-top:8px">
								<label><input type="checkbox" data-setting="allowMentions" ${allowMentions ? 'checked' : ''}> Mentioned users</label>
								<label><input type="checkbox" data-setting="allowFollowers" ${allowFollowers ? 'checked' : ''}> Followers</label>
								<label><input type="checkbox" data-setting="allowFollowing" ${allowFollowing ? 'checked' : ''}> People you follow</label>
								<label><input type="checkbox" data-setting="allowList" ${allowList ? 'checked' : ''}> A list</label>
								<button type="button" class="iconBtn" data-refresh-lists title="Refresh lists" ${allowList ? '' : 'disabled'}>${listsLoading ? '…' : '↻'}</button>
							</div>
							${allowList ? `
								<div class="row" style="margin-top:8px">
									<label style="width:100%">List
										${lists && lists.length ? `
											<select data-setting="listSelect">
												<option value="">(choose a list)</option>
												${lists.map((l) => `<option value="${esc(l.uri)}" ${String(l.uri)===listUri ? 'selected' : ''}>${esc(l.name || l.uri)}</option>`).join('')}
											</select>
										` : `
											<input type="text" data-setting="listUri" value="${esc(listUri)}" placeholder="at://did:plc:.../app.bsky.graph.list/...">
										`}
									</label>
								</div>
								${listsError ? `<div class="note">${esc(listsError)}</div>` : ''}
								${(!lists || !lists.length) ? `<div class="note">Tip: click ↻ to load your lists (falls back to paste AT-URI).</div>` : ''}
							` : ''}
							<div class="note">Custom reply controls create a threadgate record on the root post. If you select no rules, nobody can reply.</div>
						` : ''}
					`}

					<h4 style="margin-top:12px">Draft</h4>
					<div class="row">
						<button type="button" class="iconBtn" data-action="export-draft" title="Copy this draft as JSON">Export</button>
						<button type="button" class="iconBtn" data-action="import-draft" title="Import a draft JSON into this composer">Import</button>
						<button type="button" class="iconBtn" data-action="clear-draft" title="Clear this draft">Clear</button>
					</div>
					<div class="note">Export/import is for power users (JSON). Imported drafts are saved to this context.</div>

					<h4 style="margin-top:12px">Schedule</h4>
					${!scheduleAllowed ? `
						<div class="note">Scheduling is available for new posts (not replies).</div>
					` : `
						<div class="row">
							<label style="width:100%">Publish at
								<input type="datetime-local" data-setting="scheduledAt" value="${esc(scheduledAtLocal)}">
							</label>
							<button type="button" class="iconBtn" data-clear-schedule ${scheduledAtLocal ? '' : 'disabled'}>Clear</button>
						</div>
						<div class="note">Uses your local timezone. Leave blank to post immediately.</div>
					`}
				</div>
			` : ''}

			<div class="media">
				<div class="bar" style="margin:6px 0 0 0">
					<div class="who">Media</div>
					<button type="button" data-add-images ${Array.isArray(cur.images) && cur.images.length >= 4 ? 'disabled' : ''}>Add images</button>
				</div>
				<input id="imgs" type="file" accept="image/*" multiple hidden>

				${Array.isArray(cur.images) && cur.images.length ? `
					<div class="thumbs">
						${cur.images.map((img, i) => {
							const src = img.mime && img.dataBase64 ? `data:${img.mime};base64,${img.dataBase64}` : '';
							return `
								<div class="thumb">
									${src ? `<img src="${esc(src)}" alt="">` : ''}
									<input type="text" placeholder="Alt text" value="${esc(img.alt || '')}" data-alt-idx="${i}" data-alt-part="${this._activePart}">
									<button class="rm" type="button" data-remove-img="${i}" data-remove-img-part="${this._activePart}">Remove</button>
								</div>
							`;
						}).join('')}
					</div>
				` : '<div class="muted" style="margin-top:6px">(Optional) Attach up to 4 images.</div>'}
			</div>

			<div class="actions">
				<button type="button" data-submit ${!canSubmit ? 'disabled' : ''}>Send</button>
			</div>
		`;
	}
}

if (!customElements.get('bsky-comment-composer')) {
	customElements.define('bsky-comment-composer', BskyCommentComposer);
}
