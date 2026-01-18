# Panel Components

These modules are the **panel-level web components** and related UI pieces that get mounted inside the panel system.

Hierarchy intent:

- Root UI shell: `js/app/bsky_app.js` (top-level HTML)
- Panel system: `js/panels/*` (tabs, layouts, scroll contracts)
- Panel components: `js/panels/components/*` (Posts/Connections/Notifications/Search/etc)
- Entry components/templates: `js/panels/entries/*` (entry rendering + lazy media)

During migration we keep `js/components/*` as legacy entrypoints (compat shims) while the canonical imports move here.

Related docs:

- Panel system contract: `PANELS_API.md`
- Entry-level components/templates: `PANELS_ENTRIES.md`, `PANELS_ENTRY_TEMPLATES.md`
- Search router (HUD query language): `SEARCH.md`
