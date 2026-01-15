# Entries

This folder contains **entry-level** web components and templates used by multiple panels/bars.

Goal: avoid each panel inventing its own heavy DOM/media strategy (e.g. loading thousands of images/iframes at once).

## Components

- `<bsky-lazy-img>`: scroller-aware image loader/unloader.
- `<bsky-lazy-mount>`: scroller-aware mount/unmount for arbitrary HTML (iframes, embeds, custom blocks).

## Templates

`templates/` is reserved for standardized entry templates (per entry kind) that panels can reuse.
