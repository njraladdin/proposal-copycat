# Workflow Notes

## Extension UI Architecture

- The active extension UI is a Chrome side panel, not a popup.
- `manifest.json` points `side_panel.default_path` to `sidepanel.html`.
- `background.js` calls `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` so clicking the toolbar icon opens the side panel.
- `sidepanel.html` is now the main shell page for the extension UI.
- `sidepanel-shell.js` is the shared shell controller for the side panel. It renders top-level site tabs and lazy-loads each site's `panel.html`.
- `popup.html` has been removed. Reintroduce it only if we intentionally bring back popup mode.

## Site Panel Pattern

- Top-level site tabs are defined in `sidepanel-shell.js` via `SITE_REGISTRY`.
- Each site owns:
  - `sites/<site>/panel.html`
  - `sites/<site>/panel.js`
  - optional background/controller files
  - optional injected/page-context scraper files
- Each site panel boots through a mount function exposed on `window`.
  - Upwork: `window.mountUpworkPanel`
  - TikTok: `window.mountTiktokPanel`

### Adding Another Site

1. Add the site entry to `SITE_REGISTRY` in `sidepanel-shell.js`.
2. Create `sites/<site>/panel.html`.
3. Create `sites/<site>/panel.js` and expose `window.mount<SiteName>Panel`.
4. Add any needed background/injected files to `background.js` and `manifest.json`.
5. If the site needs persistent run state, follow the Upwork storage-backed status pattern instead of relying on transient DOM UI.

## Upwork Pipeline

### 1. Archived Proposal List Capture

- Triggered from the Upwork panel "Capture Proposal List" action.
- Uses `chrome.debugger` + GraphQL interception for `gql-query-proposalsbytype`.
- Stores results in `chrome.storage.local.proposalList`.
- DOM is still used for pagination orchestration.

### 2. Proposal Details Capture

- Triggered from the Upwork panel "Capture Proposal Details" action.
- Runs from `sites/upwork/background/controller.js`.
- Uses `chrome.debugger` + GraphQL interception for `gql-query-get-auth-job-details`.
- Navigates each saved proposal URL and stores captured details in `chrome.storage.local.proposals`.
- Run progress is stored in `chrome.storage.local.proposalDetailsCaptureSummary`.
- This flow is debugger-driven and does not use the page-context `runUpworkScrape()` live run status channel.

### 3. Current Job Post Scrape

- Triggered from the Upwork Job Posts tab.
- Runs `runUpworkScrape({ scrapeCurrentJobPost: true })` in the page context.
- Extracts job post data from the active `upwork.com/jobs/...` page.
- Stores the result in `chrome.storage.local.activeJobPost`.

### 4. Job Posts From Saved Proposals

- Triggered from the Upwork Job Posts tab via "Scrape From Saved Proposals".
- Runs `runUpworkScrape({ scrapeJobPostsFromSavedList: true })` in the page context.
- Reads saved proposal details, derives job URLs, fetches/parses job pages, and stores results in `chrome.storage.local.jobPosts`.

## Upwork Live Run Status Model

- The old injected status card has been removed.
- The side panel is now the source of truth for live Upwork page-driven runs.
- `sites/upwork/background/upwork-scrape-runner.js` writes live status into `chrome.storage.local.upworkRunStatus`.
- The Upwork panel reads and renders that status in `sites/upwork/panel.js`.
- Pause/resume and stop requests are controlled through `chrome.storage.local.upworkRunControl`.
- This storage-backed approach survives tab navigation, which is why it fits the side panel better than a popup or injected page card.

### Flows That Use `upworkRunStatus`

- Archived proposal list capture
- Current job post scrape
- Job posts from saved proposal details
- Any future page-context Upwork scrape that runs through `runUpworkScrape()`

### Flows That Do Not Use `upworkRunStatus`

- Debugger-only proposal details capture
- That flow still uses `proposalDetailsCaptureSummary`

### Run Controls

- `runUpworkScrape()` no longer renders an in-page overlay.
- Live progress and control actions should be added to the side panel instead of the page.

## Important Storage Keys

### Extension/UI

- `activeSiteTab`
  - Active top-level site tab in the shared shell.
- `upworkActiveSubTab`
  - Active Upwork sub-tab (`proposalsPanel` or `jobPostsPanel`).
- `scrapeMode`
  - Upwork scrape mode (`successful` or `all`).

### Upwork Data

- `proposalList[]`
  - `href`, `text`, `reason`, `submissionTime`, `rawGraphql`, `scrapedAt`, `source`
- `proposals[]`
  - `proposalListPage`
  - `proposalDetailsPage.rawGraphql`
  - `proposalDetailsPage.jobPostHref`
  - `jobPostPage.url`
  - If storage pressure occurs, heavy blobs can be dropped and the record is retained in a compact form
- `activeJobPost[]`
  - Single active job-page capture
- `jobPosts[]`
  - Saved job-post captures derived from proposal details
- `proposalDetailsCaptureSummary`
  - Progress/status for debugger-only proposal-details capture
- `upworkRunStatus`
  - Live status for page-context Upwork runs
  - Includes action text, item counts, ETA, error summary, pause state, run kind, and timestamps
- `upworkRunControl`
  - Currently used for pause/resume and stop requests
  - Shape: `{ paused, stopRequested, updatedAt }`

### TikTok Data

- `tiktokComments[]`
- `tiktokIsMonitoring`
- `tiktokMaxLimit`
- `tiktokMonitorStatus`

## File Ownership Guide

- `sidepanel.html`
  - Shared shell layout and styles for the side panel container
- `sidepanel-shell.js`
  - Shared shell controller that renders top-level site tabs and mounts site panels
- `sites/upwork/panel.html`
  - Upwork side panel markup
- `sites/upwork/panel.js`
  - Upwork side panel behavior, storage listeners, live status rendering, export/clear actions
- `sites/upwork/background/controller.js`
  - Upwork background orchestration, debugger flows, saved-data repair utilities
- `sites/upwork/background/upwork-scrape-runner.js`
  - Upwork page-context scraping and storage-backed live run publishing
- `sites/tiktok/panel.html` / `sites/tiktok/panel.js`
  - TikTok panel UI and actions
- `sites/tiktok/background/tiktok-controller.js`
  - TikTok background orchestration

## Maintenance Notes

- For UI changes, prefer keeping the shell/site-panel split intact:
  - shared container concerns in `sidepanel.html` or `sidepanel-shell.js`
  - site-specific behavior in `sites/<site>/panel.*`
- For new long-running Upwork actions, write progress to storage and render it from the side panel.
- Avoid `window.close()` in panel actions. That made sense for popup mode but works against side panel UX.
- Keep storage key names stable unless we also add migration logic.
- If a new feature needs live state in the Upwork panel, update both:
  - the writer in `upwork-scrape-runner.js` or the background controller
  - the reader in `sites/upwork/panel.js`
- If a new site needs persistent run controls, mirror the `upworkRunStatus` / `upworkRunControl` pattern rather than inventing an isolated page-only widget.

## Storage Notes

- The extension uses `unlimitedStorage` to avoid the default `chrome.storage.local` quota ceiling.
- Upwork detail records still include quota-safety behavior and may trim old heavy `rawGraphql` payloads if necessary.
