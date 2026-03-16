# Workflow Notes

## Current Pipeline

1. **Scrape List Only** (archived proposals list)
- Uses `chrome.debugger` + GraphQL interception (`gql-query-proposalsbytype`).
- Stores to `chrome.storage.local.proposalList`.
- In this mode, DOM is used only for pagination, not list-item extraction.

2. **Scrape Details (Use Saved List)**
- Uses `chrome.debugger` + GraphQL interception (`gql-query-get-auth-job-details`).
- Navigates each saved proposal URL and captures raw details payload.
- Stores to `chrome.storage.local.proposals`.
- `proposalDetailsPage` is debugger-only (`captureMethod: "debugger-graphql"`), no DOM proposal-details parsing.
- Also stores `proposalDetailsCaptureSummary` for run status/progress.

3. **Job Post Scraping**
- **Start Scraping** in Job Posts tab: scrapes current active `upwork.com/jobs/...` page.
- **Scrape From Saved Details** in Job Posts tab: reads saved proposal details, gets job URLs, fetches/parses job pages, stores results.
- Job post parsing is DOM/`__NUXT_DATA__` based (no request interception path here).

## Important Stored Fields

- `proposalList[]`
  - `href`, `text`, `reason`, `submissionTime`, `rawGraphql`, `scrapedAt`, `source`

- `proposals[]`
  - `proposalListPage` metadata
  - `proposalDetailsPage.rawGraphql` (captured GraphQL data)
  - `proposalDetailsPage.jobPostHref` (derived job URL)
  - `jobPostPage.url` (normalized job URL)
  - storage safety: if a write hits quota, older `rawGraphql` blobs are dropped automatically (`rawGraphqlDropped: true`) and core metadata is kept

- `jobPosts[]`
  - `jobPostPage.url`, `jobPostPage.data`
  - `source` is either current-page scrape or `saved-proposal-details`

## Storage Notes

- Extension now uses `unlimitedStorage` permission to avoid the default 10MB `chrome.storage.local` cap.
- A quota guard still exists for safety and trims oldest heavy `rawGraphql` fields if needed.

## Popup Actions Added

- `Clear` in **Detailed Proposals** now clears only:
  - `proposals`
  - `proposalDetailsCaptureSummary`
- `Scrape From Saved Details` button added in **Current Job Post** tab.
