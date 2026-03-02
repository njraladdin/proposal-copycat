# Proposal List Capture Notes

## Goal
Collect archived proposal list data reliably from Upwork, with cleaner structured fields than DOM scraping.

## What We Changed

1. Added a debugger-based capture path in `background/controller.js` for **archived list scraping**.
2. Attached Chrome DevTools Protocol (`chrome.debugger`) to the active archived proposals tab.
3. Listened to `Network.*` events and captured GraphQL responses from Upwork endpoints.
4. Parsed `gql-query-proposalsbytype` response payloads and extracted proposal entries.
5. Saved results directly to `chrome.storage.local.proposalList`.
6. Added `rawGraphql` per proposal item so each entry keeps the original GraphQL application object.
7. Disabled in-page network monitor + DOM list upserts during debugger-enabled list runs to avoid noisy duplicates.

## Why This Works Better

- DOM scraping depends on rendered UI and can miss fields.
- In-page interception saw analytics calls (`/shitake/suit`) rather than target payload.
- Debugger capture reads actual network response bodies for GraphQL requests.

## Data Shape Saved (`proposalList`)

Each item now includes:

- `href`
- `text`
- `reason`
- `submissionTime`
- `rawGraphql` (raw application node from GraphQL)
- `scrapedAt`
- `source`

## Important Implementation Notes

- `manifest.json` now includes `"debugger"` permission.
- GraphQL parser supports:
  - direct `proposalUrl`
  - ciphertext-based URL
  - `applicationId -> /nx/proposals/{applicationId}`
- Non-proposal GraphQL responses (for example `gql-query-auctionbyjobuid`) are ignored for list upserts.

## Current Runtime Behavior

- Archived list scrape runs pagination in page script for control flow/UI status.
- Data persistence for list entries comes from debugger GraphQL capture.
- `/shitake/suit` monitor logs are analytics noise and are not used for list data.

## Future Cleanup (Optional)

- Remove or reduce legacy in-page monitor logs when debugger mode is active.
- Add a toggle to choose debugger mode vs DOM mode.
- Move debugger telemetry behind a debug flag once stable.
