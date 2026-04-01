# Maintenance Guide

This file is the practical “where do I start?” guide for common changes and debugging.

## Useful File Ownership Guide

When making a change, start in the file that owns the behavior instead of patching the nearest place you noticed it.

### Shared Shell

- [sidepanel.html](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sidepanel.html)
  - shared shell layout and global panel styles
  - static script tags for each site's `panel.js`
- [sidepanel-shell.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sidepanel-shell.js)
  - top-level site tabs and site loading
- [manifest.json](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/manifest.json)
  - host permissions
  - `web_accessible_resources`
- [background.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/background.js)
  - shared background entry point
  - `importScripts(...)` list for all site controllers

### GitHub UI

- [sites/github/panel.html](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/github/panel.html)
  - GitHub panel markup
- [sites/github/panel.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/github/panel.js)
  - GitHub status rendering
  - active-tab profile validation
  - JSON load/copy/download helpers

### GitHub Background

- [sites/github/background/github-controller.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/github/background/github-controller.js)
  - profile detection
  - public GitHub API calls
  - README reuse / caching behavior
  - storage writes and final status summaries

### Upwork UI

- [sites/upwork/panel.html](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/panel.html)
  - Upwork panel markup
- [sites/upwork/panel.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/panel.js)
  - Upwork panel rendering, buttons, storage listeners

### Upwork Background

- [sites/upwork/background/controller.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/background/controller.js)
  - debugger orchestration
  - tab setup
  - details capture loop
  - run-status writing for debugger flows
- [sites/upwork/background/upwork-scrape-runner.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/background/upwork-scrape-runner.js)
  - page-context scrape runner
  - run-state setup for injected/page-context flows

### Upwork Injected Helpers

- [sites/upwork/injected/proposal-list-page.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/injected/proposal-list-page.js)
  - proposal list DOM extraction and pagination
- [sites/upwork/injected/proposal-details-page.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/injected/proposal-details-page.js)
  - proposal details parsing helpers
- [sites/upwork/injected/job-post-page.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/injected/job-post-page.js)
  - current job page parsing
- [sites/upwork/injected/find-work-network-monitor.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/injected/find-work-network-monitor.js)
  - Find Work best-matches request interception in the page's main world
- [sites/upwork/injected/find-work-capture-bridge.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/injected/find-work-capture-bridge.js)
  - forwards intercepted Find Work payloads to the background controller
- [sites/upwork/injected/proposal-scrape-run-state.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/injected/proposal-scrape-run-state.js)
  - page-context progress persistence

### Shared Upwork Contract

- [sites/upwork/shared/upwork-run-status.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/shared/upwork-run-status.js)
  - run-state shape and labels

## If You Need To Change X, Start Here

### Add a new site or wire an existing site into the shell

Start with all of:

- `sidepanel-shell.js`
  - add the site to `SITE_REGISTRY`
  - add the mount branch in `activateSite(...)`
- `sidepanel.html`
  - add a static `<script src="sites/<site>/panel.js"></script>`
- `manifest.json`
  - add `panel.html` to `web_accessible_resources`
  - add any page-host permissions and API-host permissions
- `background.js`
  - add the site's background controller to `importScripts(...)` if it has one

If a new site half-works, this shell wiring is the first place to look.

### Change GitHub fetch behavior, caching, or rate-limit handling

Start with:

- `sites/github/background/github-controller.js`

Check:

- `parseGithubProfileTarget(...)`
- repo-list fetch logic
- README reuse rules
- final status summary
- saved snapshot shape

### Change GitHub panel labels or export behavior

Start with:

- `sites/github/panel.html`
- `sites/github/panel.js`

### Change a panel label or status card layout

Start with:

- `sites/upwork/panel.html`
- `sites/upwork/panel.js`

### Add a new field to live Upwork run status

Update all of:

1. `sites/upwork/shared/upwork-run-status.js`
2. the relevant writer:
   - `sites/upwork/injected/proposal-scrape-run-state.js`
   - `sites/upwork/background/controller.js`
3. `sites/upwork/panel.js`

### Add a new Upwork run type

Update:

1. `getRunDescriptor(...)` in `sites/upwork/shared/upwork-run-status.js`
2. the flow launcher in `controller.js` or `panel.js`
3. the writer that reports progress
4. the panel if the new run needs special rendering

### Change archived proposal list parsing

Start with:

- `sites/upwork/injected/proposal-list-page.js`

Check:

- heading detection
- table row extraction
- pagination parsing
- network-intercept merge logic

### Change proposal details capture

Start with:

- `sites/upwork/background/controller.js`

Check:

- debugger attach conditions
- GraphQL alias matching
- detail capture wait timing
- detail upsert logic
- run-status updates

### Change current job or saved-job capture

Start with:

- `sites/upwork/background/upwork-scrape-runner.js`
- `sites/upwork/injected/job-post-page.js`

### Change Find Work capture

Start with:

- `sites/upwork/background/controller.js`
- `sites/upwork/injected/find-work-network-monitor.js`
- `sites/upwork/injected/find-work-capture-bridge.js`
- `sites/upwork/panel.html`
- `sites/upwork/panel.js`

### Change storage keys

Be careful.

Storage key renames should usually include migration logic or a deliberate reset strategy. The Upwork panel, writers, and readers are tightly coupled to stable storage names.

The same applies to the GitHub keys:

- `githubProfileSnapshot`
- `githubProfileStatus`
- `githubProfileIsLoading`

## Common Debugging Tips

### A site tab appears, but the panel does not initialize

Check:

- whether the site was added to `SITE_REGISTRY`
- whether `panel.js` was added to `sidepanel.html`
- whether `panel.html` was added to `web_accessible_resources`
- whether the mount function name matches what `sidepanel-shell.js` calls

### A panel sends messages but the background never responds

Check:

- whether the site's background controller was added to `background.js`
- whether the message `action` string matches on both sides

### GitHub says "open a GitHub profile page first"

Check:

- whether the active tab is a root profile URL like `https://github.com/<login>`
- whether `manifest.json` includes page-host permissions for `github.com`
- whether `parseGithubProfileTarget(...)` and `parseGithubProfileTab(...)` still agree on valid URLs

### GitHub refetches too much or not enough

Check:

- `canReuseExistingReadme(...)` in `sites/github/background/github-controller.js`
- whether `pushedAt` still reflects the right reuse boundary
- whether you really want to reuse `missing` results or retry them every run
- whether a repo was previously saved as `error` or `skipped`, which intentionally forces a retry later

### The run card is wrong or stale

Check:

- whether `upworkRunStatus` is being written
- whether `upworkRunControl` got stuck in `paused` or `stopRequested`
- whether the panel listener in `panel.js` is receiving storage updates
- whether the new field was added to both writer and reader

### Debugger-based details capture does not start

Check:

- whether Chrome DevTools is already attached to the target tab
- whether debugger attach succeeded in `controller.js`
- whether the target tab is actually on an Upwork page

### Archived list pagination breaks

Check:

- section heading matching in `proposal-list-page.js`
- DOM selectors for next/prev buttons
- `parsePaginationState(...)`
- whether Upwork changed the table or navigation markup

### The panel UI updated but the extension still behaves like old code

Reload the extension.

This codebase relies on:

- background service worker code
- side panel scripts
- injected content scripts

Changes in any of those layers often require a full extension reload and then a page refresh.

## Maintenance Rules That Have Paid Off

- Keep shared shell concerns in the shell files.
- Keep site-specific behavior inside `sites/<site>/...`.
- Document shell wiring when you add a site; this codebase mixes static script loading and lazy HTML loading.
- Prefer storage-backed state for long-running tasks.
- Avoid reintroducing popup-era assumptions like `window.close()`.
- Keep storage key names stable unless you are intentionally migrating.
- Treat page-host permissions and API-host permissions as different requirements.
- When you add a long-running Upwork action, think about:
  - who starts it
  - where it runs
  - who writes status
  - who reads status
  - how pause/stop should work
