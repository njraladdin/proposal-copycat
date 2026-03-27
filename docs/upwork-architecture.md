# Upwork Architecture

Upwork is the most complex part of the extension because it mixes:

- side panel UI
- background debugger orchestration
- page-context scraping
- injected DOM/network helpers
- persistent storage-backed run status

## Main Upwork Files

- [background.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/background.js)
  - loads the Upwork background modules
- [sites/upwork/panel.html](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/panel.html)
  - Upwork panel markup
- [sites/upwork/panel.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/panel.js)
  - Upwork panel behavior
  - renders current run status
  - sends start requests
  - listens to storage updates
- [sites/upwork/background/controller.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/background/controller.js)
  - background orchestration
  - debugger attach/detach
  - debugger-driven proposal list/details capture
  - saved-data repair helpers
- [sites/upwork/background/upwork-scrape-runner.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/background/upwork-scrape-runner.js)
  - page-context run entry point: `runUpworkScrape(...)`
  - current job scrape
  - archived list DOM/network-assisted scrape
  - job posts from saved proposal details
- [sites/upwork/injected/proposal-list-page.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/injected/proposal-list-page.js)
  - archived proposals list DOM scraping
  - pagination parsing
  - network-monitor bridge support
- [sites/upwork/injected/proposal-details-page.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/injected/proposal-details-page.js)
  - proposal details parsing in page context
- [sites/upwork/injected/job-post-page.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/injected/job-post-page.js)
  - current job page parsing
- [sites/upwork/injected/proposal-scrape-run-state.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/injected/proposal-scrape-run-state.js)
  - page-context run state writer
  - pause/stop polling logic
- [sites/upwork/shared/upwork-run-status.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/shared/upwork-run-status.js)
  - shared run-status contract
  - shared run descriptors and storage keys

## Upwork Run Types

There are four main Upwork flows.

### Archived Proposal List Capture

Triggered from the Proposals tab via `Capture Proposal List`.

Purpose:

- read archived proposals pages
- save lightweight list entries into `proposalList`

How it runs:

1. Panel sends `startArchivedListScraping`.
2. Background controller ensures the archived proposals tab exists.
3. Background controller may attach the debugger for GraphQL capture.
4. Injected helpers are loaded into the page.
5. `runUpworkScrape({ scrapeArchivedListOnly: true, ... })` runs in page context.
6. The list page helper coordinates pagination and extracts links.

Primary storage output:

- `chrome.storage.local.proposalList`

Important code:

- `startArchivedListScrapingFlow(...)` in `controller.js`
- `runUpworkScrape(...)` in `upwork-scrape-runner.js`
- proposal list DOM helpers in `proposal-list-page.js`

### Proposal Details Capture

Triggered from the Proposals tab via `Capture Proposal Details`.

Purpose:

- iterate saved proposal list links
- capture detailed proposal GraphQL payloads
- save enriched detail records into `proposals`
- keep raw debugger payloads and cleaned page-derived detail data side by side

How it runs:

1. Panel sends `startScraping`.
2. Background controller opens or reuses the archived proposals tab.
3. Background controller attaches Chrome debugger.
4. `runDebuggerProposalDetailsFlow(...)` navigates one saved proposal URL at a time.
5. GraphQL detail responses are intercepted and stored.
6. Page-derived detail supplements are merged into `proposalDetailsPage.pageData` when available.
7. Progress is written to the shared Upwork run status model.

Primary storage output:

- `chrome.storage.local.proposals`

Important storage shape notes:

- `proposalDetailsPage.rawGraphql`
  - raw debugger-captured details response
- `proposalDetailsPage.pageData`
  - cleaned page-derived details payload
- `proposalDetailsPage.pageDataSources`
  - which page extraction sources contributed to `pageData`
- `proposalDetailsPage.pageData.proposal.attachedHighlights`
  - highlights attached to the proposal page, not general freelancer profile highlights

Important code:

- `startScrapingFlow(...)` in `controller.js`
- `runDebuggerProposalDetailsFlow(...)` in `controller.js`
- detail upsert helpers in `controller.js`

### Current Job Post Scrape

Triggered from the Job Posts tab via `Scrape Active Job Page`.

Purpose:

- parse the currently open Upwork job page
- store one current-job snapshot

How it runs:

1. Panel sends `startCurrentJobPostScraping`.
2. Background controller injects helpers into the active Upwork tab.
3. `runUpworkScrape({ scrapeCurrentJobPost: true })` runs in page context.
4. Job page data is extracted and saved.

Primary storage output:

- `chrome.storage.local.activeJobPost`

### Job Posts From Saved Proposals

Triggered from the Job Posts tab via `Capture Job Posts From Saved Proposals`.

Purpose:

- use saved proposal details as inputs
- derive job post URLs or fallback job data
- store a saved job-post dataset

How it runs:

1. Panel sends `startJobPostsFromSavedListScraping`.
2. Background controller opens/reuses the archived proposals tab.
3. Injected helpers are loaded.
4. `runUpworkScrape({ scrapeJobPostsFromSavedList: true })` runs in page context.
5. The runner reads `proposals`, derives job post inputs, fetches/parses jobs, and saves the results.

Primary storage output:

- `chrome.storage.local.jobPosts`

## Upwork Execution Styles

The two execution styles matter because bugs often come from assuming they behave the same way.

### Background-Debugger Flows

These are orchestrated from `controller.js` and use `chrome.debugger`.

Used by:

- archived proposal list capture
- proposal details capture

Strengths:

- can intercept GraphQL responses directly
- can survive some DOM instability
- good for data that is easier to capture from network traffic than from rendered HTML

Tradeoffs:

- debugger attachment fails if DevTools is already attached to the same tab
- navigation and timing become background concerns
- pause/stop must be managed via storage and polling

### Page-Context Flows

These are executed via `chrome.scripting.executeScript(...)` and run `runUpworkScrape(...)` inside the Upwork tab.

Used by:

- current job post scrape
- job posts from saved proposals
- archived list scrape orchestration around DOM/pagination

Strengths:

- easier access to live DOM and page globals
- simpler to reason about when DOM parsing is enough

Tradeoffs:

- can be disrupted by page re-renders
- must coordinate injected helper availability
- tab navigation can reset ephemeral in-page state, which is why run status is storage-backed
