# System Overview

This project uses a Chrome side panel as the main extension UI.

The fastest mental model is:

1. `sidepanel.html` is the persistent shell.
2. `sidepanel-shell.js` switches between site panels.
3. Each site owns its own `panel.html` and `panel.js`.
4. Background code orchestrates long-running work.
5. Site-specific injected scripts run inside the target website when needed.

## Big Picture

- `manifest.json`
  - `side_panel.default_path` points to `sidepanel.html`
  - `background.service_worker` points to `background.js`
- `background.js`
  - loads shared/background modules with `importScripts(...)`
  - configures side panel behavior with `chrome.sidePanel.setPanelBehavior(...)`
- `sidepanel.html`
  - is the main shell page
  - loads the shared shell plus site panel scripts
- `sidepanel-shell.js`
  - owns top-level site switching
  - lazy-loads each site's `panel.html`

If you are changing layout, panel switching, or global side-panel behavior, start with the shell files.

## Site Panel Pattern

Each site follows this pattern:

- `sites/<site>/panel.html`
  - markup for that site's panel
- `sites/<site>/panel.js`
  - panel behavior and storage listeners
- optional `sites/<site>/background/*`
  - background orchestration
- optional `sites/<site>/injected/*`
  - code injected into the website
- optional `sites/<site>/shared/*`
  - shared helpers used by panel/background/injected code

Mount functions:

- Upwork: `window.mountUpworkPanel`
- TikTok: `window.mountTiktokPanel`

## Adding Another Site

1. Add the site to `SITE_REGISTRY` in `sidepanel-shell.js`.
2. Create `sites/<site>/panel.html`.
3. Create `sites/<site>/panel.js` and expose `window.mount<SiteName>Panel`.
4. Add any needed background modules to `background.js`.
5. Add any required permissions or `web_accessible_resources` to `manifest.json`.
6. If the site needs long-running progress, use a storage-backed status model instead of a transient in-page widget.

## Current Entry Points

- Root readme: [README.md](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/README.md)
- Docs index: [docs/README.md](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/docs/README.md)
- Upwork panel: [sites/upwork/panel.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/panel.js)
- Upwork background orchestration: [sites/upwork/background/controller.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/background/controller.js)
