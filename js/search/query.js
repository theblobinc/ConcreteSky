// Shared HUD/panel search parsing + matching.
// Intentionally lightweight (no dependencies) so we can reuse everywhere.

function normalizeText(value) {
	if (value == null) return '';
	return String(value).toLowerCase();
}

function tokenize(query) {
	const tokens = [];
	let i = 0;
	let current = '';
	let inQuotes = false;

	const pushCurrent = () => {
		const t = current.trim();
		if (t) tokens.push(t);
		current = '';
	};

	while (i < query.length) {
		const ch = query[i];
		if (ch === '"') {
			inQuotes = !inQuotes;
			i++;
			continue;
		}
		if (!inQuotes && /\s/.test(ch)) {
			pushCurrent();
			i++;
			continue;
		}
		current += ch;
		i++;
	}
	pushCurrent();
	return tokens;
}

function parseFieldToken(token) {
	// Supports: field:value, -field:value, field:"multi word" is handled by tokenizer.
	let negated = false;
	let t = token;
	if (t.startsWith('-')) {
		negated = true;
		t = t.slice(1);
	}
	const idx = t.indexOf(':');
	if (idx <= 0) return null;
	const field = t.slice(0, idx).trim().toLowerCase();
	const value = t.slice(idx + 1).trim();
	if (!field || !value) return null;
	return { field, value, negated };
}

export function parseSearchQuery(rawQuery) {
	const raw = (rawQuery ?? '').trim();
	if (!raw) {
		return {
			raw: '',
			valid: true,
			mode: 'text',
			ast: { type: 'empty' },
			fields: [],
			terms: [],
		};
	}

	// regex mode: /.../ or /.../i
	if (raw.length >= 2 && raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
		const lastSlash = raw.lastIndexOf('/');
		const pattern = raw.slice(1, lastSlash);
		const flags = raw.slice(lastSlash + 1);
		try {
			if (pattern.length > 240) {
				throw new Error('Regex too long');
			}
			if (flags && !/^[gimsuy]*$/.test(flags)) {
				throw new Error('Invalid regex flags');
			}
			const re = new RegExp(pattern, flags || 'i');
			return {
				raw,
				valid: true,
				mode: 'regex',
				regex: { pattern, flags: flags || 'i' },
				ast: { type: 'regex', re },
				fields: [],
				terms: [],
			};
		} catch (e) {
			return {
				raw,
				valid: false,
				mode: 'regex',
				error: String(e?.message || e),
				ast: { type: 'invalid' },
				fields: [],
				terms: [],
			};
		}
	}

	const tokens = tokenize(raw);
	const fields = [];
	const terms = [];
	for (const token of tokens) {
		const upper = token.toUpperCase();
		if (upper === 'AND' || upper === 'OR' || upper === 'NOT') {
			terms.push({ type: 'op', op: upper });
			continue;
		}
		if (token === '|' || token === '||') {
			terms.push({ type: 'op', op: 'OR' });
			continue;
		}
		const fieldTok = parseFieldToken(token);
		if (fieldTok) {
			fields.push(fieldTok);
			terms.push({ type: 'field', ...fieldTok });
			continue;
		}
		let negated = false;
		let value = token;
		if (value.startsWith('-') && value.length > 1) {
			negated = true;
			value = value.slice(1);
		}
		terms.push({ type: 'term', value, negated });
	}

	// Convert to a simple AST: OR groups of AND terms, with NOT supported per-term.
	// This is intentionally conservative: if user doesn't specify operators, default AND.
	const orGroups = [];
	let currentAnd = [];
	let pendingOp = null;

	const flushAnd = () => {
		if (currentAnd.length) orGroups.push({ type: 'and', items: currentAnd });
		currentAnd = [];
	};

	for (const part of terms) {
		if (part.type === 'op') {
			pendingOp = part.op;
			continue;
		}

		if (pendingOp === 'OR') {
			flushAnd();
		}
		// For NOT, we treat it as negation of next item if that item isn't already negated.
		if (pendingOp === 'NOT') {
			if (part.type === 'term' || part.type === 'field') {
				part.negated = !part.negated;
			}
		}
		currentAnd.push(part);
		pendingOp = null;
	}
	flushAnd();

	return {
		raw,
		valid: true,
		mode: 'text',
		ast: { type: 'or', groups: orGroups.length ? orGroups : [{ type: 'and', items: [] }] },
		fields,
		terms,
	};
}

function getFieldValue(fields, fieldName) {
	if (!fields) return '';
	const v = fields[fieldName];
	if (Array.isArray(v)) return v.map((x) => normalizeText(x)).join(' ');
	return normalizeText(v);
}

function matchTermInText(termValue, haystack) {
	const needle = normalizeText(termValue);
	if (!needle) return true;
	return haystack.includes(needle);
}

function fuzzyMatch(query, text) {
	const q = normalizeText(query).trim();
	if (!q) return true;
	const t = normalizeText(text);
	let i = 0;
	for (const ch of q) {
		i = t.indexOf(ch, i);
		if (i === -1) return false;
		i++;
	}
	return true;
}

export function compileSearchMatcher(parsed) {
	if (!parsed || parsed.ast?.type === 'empty') {
		return () => true;
	}
	if (parsed.ast?.type === 'invalid') {
		return () => false;
	}
	if (parsed.ast?.type === 'regex') {
		const re = parsed.ast.re;
		return (text, fields) => {
			const haystack = normalizeText(text) + ' ' + normalizeText(JSON.stringify(fields || {}));
			return re.test(haystack);
		};
	}

	const globalFuzzy = (() => {
		try {
			for (const f of parsed.fields || []) {
				if (String(f?.field || '').toLowerCase() !== 'fuzzy') continue;
				const v = String(f?.value || '').toLowerCase();
				const on = (v === '1' || v === 'true' || v === 'yes' || v === 'on');
				if (f?.negated) return false;
				if (on) return true;
			}
		} catch {}
		return false;
	})();

	const orGroups = parsed.ast?.groups || [];
	return (text, fields) => {
		const haystack = normalizeText(text);
		for (const group of orGroups) {
			let ok = true;
			for (const item of group.items) {
				if (item.type === 'term') {
					const raw = String(item.value || '');
					const termFuzzy = globalFuzzy || raw.startsWith('~');
					const val = raw.startsWith('~') ? raw.slice(1) : raw;
					const matched = termFuzzy ? fuzzyMatch(val, haystack) : matchTermInText(val, haystack);
					if (item.negated ? matched : !matched) {
						ok = false;
						break;
					}
				} else if (item.type === 'field') {
					const fieldText = getFieldValue(fields, item.field);
					const raw = String(item.value || '');
					const termFuzzy = globalFuzzy || raw.startsWith('~');
					const val = raw.startsWith('~') ? raw.slice(1) : raw;
					const matched = termFuzzy ? fuzzyMatch(val, fieldText) : matchTermInText(val, fieldText);
					if (item.negated ? matched : !matched) {
						ok = false;
						break;
					}
				}
			}
			if (ok) return true;
		}
		return false;
	};
}
