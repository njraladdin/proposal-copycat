# Maintenance Guide

This file is the practical “where do I start?” guide for common changes and debugging.

## Useful File Ownership Guide

When making a change, start in the file that owns the behavior instead of patching the nearest place you noticed it.

### Shared Shell

- [sidepanel.html](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sidepanel.html)
  - shared shell layout and global panel styles
- [sidepanel-shell.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sidepanel-shell.js)
  - top-level site tabs and site loading

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
- [sites/upwork/injected/proposal-scrape-run-state.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/injected/proposal-scrape-run-state.js)
  - page-context progress persistence

### Shared Upwork Contract

- [sites/upwork/shared/upwork-run-status.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/shared/upwork-run-status.js)
  - run-state shape and labels

## If You Need To Change X, Start Here

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

### Change storage keys

Be careful.

Storage key renames should usually include migration logic or a deliberate reset strategy. The Upwork panel, writers, and readers are tightly coupled to stable storage names.

## Common Debugging Tips

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
- Prefer storage-backed state for long-running tasks.
- Avoid reintroducing popup-era assumptions like `window.close()`.
- Keep storage key names stable unless you are intentionally migrating.
- When you add a long-running Upwork action, think about:
  - who starts it
  - where it runs
  - who writes status
  - who reads status
  - how pause/stop should work
