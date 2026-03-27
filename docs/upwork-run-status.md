# Upwork Run Status

This is the shared status model for all active Upwork runs.

There is one canonical status channel:

- `chrome.storage.local.upworkRunStatus`

And one canonical control channel:

- `chrome.storage.local.upworkRunControl`

The shared contract lives in:

- [sites/upwork/shared/upwork-run-status.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/shared/upwork-run-status.js)

## Why This Exists

Without a shared module, the panel, background controller, and page-context runner drift in naming, field shape, and labels.

This shared module keeps these areas aligned:

- panel rendering
- background debugger flows
- page-context run-state persistence

## Current Writer/Reader Split

Writers:

- [sites/upwork/injected/proposal-scrape-run-state.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/injected/proposal-scrape-run-state.js)
  - for page-context runs
- [sites/upwork/background/controller.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/background/controller.js)
  - for debugger-driven proposal details runs

Reader:

- [sites/upwork/panel.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/panel.js)
  - renders the current run card from `upworkRunStatus`

## What The Shared Module Provides

`sites/upwork/shared/upwork-run-status.js` currently provides:

- storage key constants
- scrape mode normalization
- run control normalization
- run descriptor generation
- run status payload normalization

If you add a new Upwork flow, update `getRunDescriptor(...)` here first.

## Current Run Status Fields

The status payload is normalized through `createRunStatusPayload(...)`.

Common fields:

- `statusTitle`
- `modeBadgeText`
- `action`
- `listProgressLabel`
- `listProgressText`
- `listCurrent`
- `listTotal`
- `itemCurrent`
- `itemTotal`
- `totalSaved`
- `etaMs`
- `etaText`
- `errorTotal`
- `errorSummary`
- `recentErrors`
- `isPaused`
- `stopRequested`
- `inProgress`
- `status`
- `pauseSupported`
- `stopSupported`
- `runKind`
- `startedAt`
- `updatedAt`

## Run Kind Values

Current `runKind` values:

- `archived-proposal-list`
- `proposal-details-from-saved-list`
- `current-job-post`
- `job-posts-from-saved-list`
- `proposal-list`

## Pause/Stop Controls

`upworkRunControl` currently has this shape:

```json
{
  "paused": false,
  "stopRequested": false,
  "updatedAt": "2026-03-27T12:34:56.000Z"
}
```

The panel writes this state.

Consumers:

- page-context runs via `proposal-scrape-run-state.js`
- debugger proposal-details flow via `controller.js`

If a new long-running Upwork process is added, it should either:

- honor `upworkRunControl`, or
- clearly document why it intentionally does not

## Current UI Contract

The Upwork panel expects one current-run card, not separate per-step status systems.

Current UI files:

- [sites/upwork/panel.html](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/panel.html)
- [sites/upwork/panel.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/panel.js)

That means any new writer should publish into the shared status shape instead of inventing a new storage key for progress unless there is a strong reason not to.
