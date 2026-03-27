# Upwork Data Model

This file describes the main Upwork storage datasets and how they relate to each other.

## Core Storage Keys

### Extension/UI

- `activeSiteTab`
  - active top-level site tab in the shared shell
- `upworkActiveSubTab`
  - active Upwork sub-tab
- `scrapeMode`
  - Upwork scrape mode: `successful` or `all`
- `upworkRunStatus`
  - current Upwork run status
- `upworkRunControl`
  - current Upwork pause/stop control state

## Upwork Data Sets

### `proposalList[]`

Lightweight archived proposal entries.

Common fields:

- `href`
- `text`
- `reason`
- `submissionTime`
- `rawGraphql`
- `scrapedAt`
- `source`

Usage:

- created by archived list capture
- used later as the input list for proposal details capture

### `proposals[]`

Detailed proposal records.

Common subtrees:

- `proposalListPage`
- `proposalDetailsPage`
- `proposalDetailsPage.rawGraphql`
- `proposalDetailsPage.jobPostHref`
- `jobPostPage`

Usage:

- created by proposal details capture
- used later to derive saved job post captures

### `activeJobPost[]`

Single-job scrape from the currently open Upwork job page.

Usage:

- created by current job page scrape
- mostly useful as a current-page snapshot rather than a historical batch dataset

### `jobPosts[]`

Saved job post dataset derived from proposal details or job-page scraping.

Usage:

- created by “Capture Job Posts From Saved Proposals”
- used as a saved job-post library

## Data Flow Between Sets

The normal Upwork data pipeline is:

1. `proposalList[]`
2. `proposals[]`
3. `jobPosts[]`

And separately:

1. current Upwork job page
2. `activeJobPost[]`

That means:

- if proposal details capture fails, later job-post capture from saved proposals will also be incomplete
- if archived list capture is incomplete, proposal details capture starts from a weaker input set

## Storage Pressure Notes

- The extension uses `unlimitedStorage`.
- Even so, `proposals[]` is the heaviest dataset because it can include large raw GraphQL payloads.
- If storage pressure bugs appear, inspect `proposals[]` first.
- Some quota-safety logic may trim heavy `rawGraphql` content while keeping the rest of the record.
