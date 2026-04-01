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
- `proposalDetailsPage.pageData`
- `proposalDetailsPage.pageDataSources`
- `proposalDetailsPage.jobPostHref`
- `jobPostPage`

Usage:

- created by proposal details capture
- used later to derive saved job post captures

Notes:

- `proposalDetailsPage.rawGraphql` is the raw debugger-captured GraphQL payload when available.
- `proposalDetailsPage.pageData` is the cleaned, page-extracted proposal details payload.
- `proposalDetailsPage.pageDataSources` describes how `pageData` was built, for example `["nuxt"]`, `["dom"]`, or `["nuxt", "dom"]`.
- Older saved records may still contain legacy `proposalDetailsPage.data`; current code reads both, but new writes use `pageData`.

Common `proposalDetailsPage.pageData` subtrees:

- `freelancer`
- `client`
- `jobPost`
- `proposal`

Common `proposalDetailsPage.pageData.proposal` fields:

- `coverLetter`
- `proposalUrl`
- `terms`
- `answersToQuestions`
- `competitionStats`
- `attachedHighlights`

Common `proposalDetailsPage.pageData.proposal.terms` fields:

- `proposedRate`
- `connectsSpent`
- DOM-supplemented fields may also include `pricingType`, `profileName`, `profileUrl`, `clientBudget`, `clientBudgetDisplay`, `paymentMethod`, `proposedRateDisplay`, `proposedTotalPrice`, `proposedTotalPriceDisplay`, `estimatedReceiveAmount`, `estimatedReceiveDisplay`, and `rateIncrease`

### `activeJobPost[]`

Single-job scrape from the currently open Upwork job page.

Usage:

- created by current job page scrape
- mostly useful as a current-page snapshot rather than a historical batch dataset

### `findWorkJobList[]`

Lightweight Find Work job-list dataset captured from the best-matches feed.

Common fields:

- `uid`
- `ciphertext`
- `jobPostUrl`
- `title`
- `description`
- `rawGraphql`
- `captureContexts`
- `sourceTab`
- `scrapedAt`

Usage:

- created by Find Work request interception
- intended later as the input list for a separate Find Work job-details capture flow

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

Separately:

1. current Upwork job page
2. `activeJobPost[]`

And separately:

1. `findWorkJobList[]`
2. future Find Work details dataset

That means:

- if proposal details capture fails, later job-post capture from saved proposals will also be incomplete
- if archived list capture is incomplete, proposal details capture starts from a weaker input set

## Storage Pressure Notes

- The extension uses `unlimitedStorage`.
- Even so, `proposals[]` is the heaviest dataset because it can include large raw GraphQL payloads.
- If storage pressure bugs appear, inspect `proposals[]` first.
- Some quota-safety logic may trim heavy `rawGraphql` content while keeping the rest of the record.
