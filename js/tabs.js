// Back-compat entrypoint.
// Implementation lives in `js/panels/` so the tabs/panels subsystem can grow without
// becoming a single hard-to-maintain file.
export { bootTabs } from './panels/index.js';
