import { parseSearchQuery } from './query.js';

export const BSKY_SEARCH_EVENT = 'bsky-search-changed';

export function createSearchSpec({ query, targets, mode, filters }) {
	const parsed = parseSearchQuery(query);
	return {
		query: (query ?? '').trim(),
		parsed,
		mode: mode || 'cache', // 'cache' | 'network'
		targets: Array.isArray(targets) ? targets : [],
		filters: filters || {},
	};
}

export function dispatchSearchChanged(spec) {
	window.dispatchEvent(
		new CustomEvent(BSKY_SEARCH_EVENT, {
			detail: spec,
		})
	);
}
