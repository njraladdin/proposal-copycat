# System Overview

This project uses a Chrome side panel as the main extension UI.

The fastest mental model is:

1. `sidepanel.html` is the persistent shell.
2. `sidepanel-shell.js` switches between site panels.
3. `sidepanel.html` statically loads each site's `panel.js`.
4. `sidepanel-shell.js` lazy-loads each site's `panel.html` and then calls its mount function.
5. Background code orchestrates long-running work.
6. Site-specific injected scripts run inside the target website only when a site actually needs them.

## Big Picture

- `manifest.json`
  - `side_panel.default_path` points to `sidepanel.html`
  - `background.service_worker` points to `background.js`
- `background.js`
  - loads shared/background modules with `importScripts(...)`
  - configures side panel behavior with `chrome.sidePanel.setPanelBehavior(...)`
- `sidepanel.html`
  - is the main shell page
  - statically loads shared shell code plus every site's `panel.js`
- `sidepanel-shell.js`
  - owns top-level site switching
  - lazy-loads each site's `panel.html`
  - calls the matching `window.mount<SiteName>Panel()`

If you are changing layout, panel switching, or global side-panel behavior, start with the shell files.

## Important Wiring Details

These details are easy to miss when adding or debugging a site.

### `panel.html` and `panel.js` do not load the same way

- `sidepanel-shell.js` fetches `sites/<site>/panel.html` on demand.
- `sidepanel.html` statically loads `sites/<site>/panel.js` up front.
- Adding a site to `SITE_REGISTRY` is not enough by itself.
- If `panel.html` loads but the UI does not initialize, check whether `panel.js` was added to `sidepanel.html`.

### Background modules are manually registered

- `background.js` uses `importScripts(...)`.
- Every site background controller must be added there explicitly.
- If a panel sends messages but nothing responds, check `background.js` first.

### Page permissions and API permissions are separate

- `https://github.com/*` and `https://api.github.com/*` solve different problems.
- Page-host permissions are needed when the extension must inspect or target a browser tab on that site.
- API-host permissions are needed when the extension must `fetch(...)` data from that remote host.
- A site can need one, the other, or both.

### `panel.html` fetches depend on `web_accessible_resources`

- If `sidepanel-shell.js` fails to inject a site's `panel.html`, check `manifest.json`.
- The panel HTML must be exposed in `web_accessible_resources`.

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
- GitHub: `window.mountGithubPanel`

## Current Site Styles

- Upwork
  - mixed debugger + injected-script scraping
  - most complex integration in the project
- TikTok
  - lightweight injected-script monitoring
  - page DOM is the primary data source
- GitHub
  - API-backed integration
  - no injected scripts
  - browser tab is only used to identify the current profile
  - README fetches are cached and reused when repos have not changed

## Adding Another Site

1. Add the site to `SITE_REGISTRY` in `sidepanel-shell.js`.
2. Create `sites/<site>/panel.html`.
3. Create `sites/<site>/panel.js` and expose `window.mount<SiteName>Panel`.
4. Add the site's `panel.js` script tag to `sidepanel.html`.
5. Add the site's `panel.html` to `web_accessible_resources` in `manifest.json`.
6. Add any needed page-host permissions and API-host permissions to `manifest.json`.
7. Add any needed background modules to `background.js`.
8. If the site needs long-running progress, use a storage-backed status model instead of a transient in-page widget.
9. If the site needs DOM/page scraping, add injected scripts under `sites/<site>/injected/`.

## Current Entry Points

- Root readme: [README.md](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/README.md)
- Docs index: [docs/README.md](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/docs/README.md)
- GitHub panel: [sites/github/panel.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/github/panel.js)
- GitHub background orchestration: [sites/github/background/github-controller.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/github/background/github-controller.js)
- Upwork panel: [sites/upwork/panel.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/panel.js)
- Upwork background orchestration: [sites/upwork/background/controller.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/background/controller.js)
