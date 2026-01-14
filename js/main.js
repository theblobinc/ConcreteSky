// App bootstrap: register the top-level UI shell.
// All markup + layout CSS lives in the `bsky-app` web component so it can be ported
// outside ConcreteCMS with minimal changes (only config injection).
import './app/bsky_app.js';

console.log('[BSKY main] boot', {
  apiPath: window.BSKY?.apiPath,
  csrf: !!window.BSKY?.csrf
});
