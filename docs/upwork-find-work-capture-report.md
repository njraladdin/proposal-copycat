# Upwork Find Work Capture Report

This report documents what happened while implementing the Find Work job-list capture, why the first approach failed, and what finally worked.

The goal is to save future time when another Upwork flow looks "interceptable" at first glance but behaves differently in practice.

## Goal

Add a new Upwork capture flow for:

- `https://www.upwork.com/nx/find-work/...`
- specifically the Best Matches area for now
- save a lightweight list dataset, not full job details
- keep tracking until the user stops it
- store the full raw result object per job plus request/page context

Primary output:

- `chrome.storage.local.findWorkJobList`

## What We Expected At First

The initial idea was:

1. inject a main-world network monitor into the Find Work page
2. intercept the GraphQL request
3. match the request by alias:
   - `bestMatchRecommendationsFeed.retrieve`
4. forward the payload to the background
5. upsert deduped jobs by `uid`

This matched the user's request and looked similar to the existing proposal list monitor pattern.

## What Actually Happened

The first version did install the monitor, but it did not capture the job-feed request we wanted.

Observed symptoms:

- the Find Work page console showed the monitor installing
- the bridge forwarded some GraphQL responses
- those responses were things like:
  - `smf.retrieve.very_top`
  - `smf.retrieve.banner`
  - `smf.retrieve.account-enforcement`
  - `smf.retrieve.top`
- the expected job-feed alias did not appear in the page monitor
- no useful job list was being saved

That told us something important:

- page-level interception was seeing "normal" GraphQL traffic
- but not the actual feed response we cared about, or not in a way that matched the original assumption

## Why The First Approach Failed

The exact internal Upwork mechanism was not fully proven, but the behavior matched a pattern we had already seen elsewhere in this project:

- some Upwork network activity is not reliably captured by page-level `fetch`/XHR monkey-patching
- or it is surfaced in a transformed/partial way that makes alias-based matching unreliable
- the real response is still visible to Chrome's debugger network APIs

This is very similar to why the archived proposal list and proposal details flows already rely on `chrome.debugger` in [controller.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/background/controller.js).

Important lesson:

- if Upwork page interception only shows nearby GraphQL noise but misses the payload you actually need, move to debugger-based capture early

## Intermediate Fixes We Tried

Before switching fully to the debugger path, we improved a few things:

### 1. Earlier Script Injection

We moved the Find Work monitor to `document_start` in [manifest.json](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/manifest.json).

Why:

- if Upwork initializes its network client before our patch runs, later monkey-patching may miss the real traffic

This helped reliability for the page monitor itself, but it still did not expose the target feed response.

### 2. Payload-Shape Fallback

We relaxed the response matching logic so it did not depend only on one alias.

Why:

- Upwork aliases on this page were clearly not stable enough for a single hardcoded alias match

This was the right idea in general, but the page-level interception still was not enough on its own.

### 3. Better Run-State UI

We found a second problem unrelated to the network capture itself:

- the button could look "stuck" in tracking mode after refresh
- the UI was reflecting persisted run status, not just a live capture session

That created confusion even when no useful capture was happening.

## Final Solution

The final implementation uses the same strategy that already works for other fragile Upwork flows:

- attach `chrome.debugger` to the active Find Work tab
- listen to `Network.requestWillBeSent`
- listen to `Network.responseReceived`
- read response bodies with `Network.getResponseBody`
- parse GraphQL responses in the background
- accept the real job-feed response by payload shape, not only by alias

### What The Final Flow Does

1. User opens the Find Work page.
2. User clicks `Start Find Work Tracking`.
3. Background validates the active tab is already on `nx/find-work`.
4. Background attaches the Chrome debugger with `captureMode: 'find-work'`.
5. Every GraphQL response on that tab is available to the background.
6. The code parses responses and looks for a `results[]` payload with job-like entries.
7. Matching jobs are deduped by `uid` and saved into `findWorkJobList`.
8. Tracking stays active until the user stops it.

### Why This Worked

Because the debugger sees the browser's real network traffic, not only what the page-level JavaScript APIs expose to our patched `fetch`/XHR hooks.

For Upwork, that distinction matters.

## Data Handling Decisions

The Find Work dataset intentionally stays lightweight.

Each saved item includes:

- `uid`
- `ciphertext`
- `jobPostUrl`
- `title`
- `description`
- `rawGraphql`
  - the full raw result node for that job
- `captureContexts`
  - request/page metadata snapshots for when the job was seen
- `sourceTab`
  - currently hardcoded to `best-matches`

Deduping rule:

- one saved record per job `uid`

Upsert behavior:

- if the same job appears again, update the record and append/merge capture context

## UI / Session Fixes

We also changed the Find Work button behavior so the tracking state is easier to reason about.

Final behavior:

- button is tied to the dedicated stored tracking session
- button becomes a true toggle:
  - `Start Find Work Tracking`
  - `Stop Find Work Tracking`
- stopping clears the session and detaches the debugger

This prevents the earlier confusing state where the button appeared active but did not give the user a clean way to reset the run.

## Files That Matter

Main implementation:

- [controller.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/background/controller.js)
  - Find Work session lifecycle
  - debugger attach/detach
  - GraphQL response parsing
  - upserts into `findWorkJobList`
- [panel.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/panel.js)
  - start/stop button behavior
  - panel dataset wiring
  - session-aware button state
- [panel.html](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/panel.html)
  - Find Work section in Job Posts
- [upwork-run-status.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/shared/upwork-run-status.js)
  - run kind for Find Work tracking

Earlier page-monitor attempt / supporting context:

- [find-work-network-monitor.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/injected/find-work-network-monitor.js)
- [find-work-capture-bridge.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/upwork/injected/find-work-capture-bridge.js)

These are still useful for understanding the failed first approach and for future experiments, but the real working capture path is now debugger-based.

## Practical Rule For Future Upwork Work

Use this decision rule:

1. If a target Upwork request is clearly visible through normal page interception and stable enough, page-level capture is fine.
2. If page interception only shows surrounding GraphQL traffic or alias noise, do not spend too long forcing it.
3. Move to `chrome.debugger` early for Upwork flows that depend on exact GraphQL payload capture.
4. Match responses by payload shape when aliases are unstable.
5. For long-running tracking flows, store a dedicated session object in storage and let the UI key off that session directly.

## Troubleshooting Checklist

If a future Upwork capture is flaky:

- confirm whether the target response is visible in the page console at all
- if not, test with the debugger path instead of deepening page-hook complexity
- do not trust a single alias name too early
- inspect payload structure, not only request URL
- make the UI state depend on a real stored session, not only the generic run card
- make stop/reset easy so stale session state does not confuse debugging

## Bottom Line

The important takeaway is not just "Find Work needed the debugger."

The real reusable lesson is:

- Upwork has flows where page-level network interception can see adjacent GraphQL requests but still miss the payload that matters
- the project already had a proven answer for that in the proposal flows
- the fastest path was to reuse that architecture instead of continuing to force the page monitor
