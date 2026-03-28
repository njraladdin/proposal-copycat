# GitHub Architecture

GitHub is intentionally much simpler than Upwork in this extension.

It is an API-backed integration, not a DOM-scraping integration.

That means:

- no injected scripts
- no `chrome.debugger`
- no page-context scraping loop
- no reliance on the currently rendered GitHub DOM for repo data

The browser tab is only used to discover which GitHub profile is currently open.

## Main GitHub Files

- [manifest.json](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/manifest.json)
  - grants host permissions for `github.com` and `api.github.com`
- [background.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/background.js)
  - imports the GitHub background controller
- [sidepanel.html](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sidepanel.html)
  - statically loads `sites/github/panel.js`
- [sidepanel-shell.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sidepanel-shell.js)
  - registers the top-level `GitHub` site tab
  - lazy-loads `sites/github/panel.html`
  - calls `window.mountGithubPanel()`
- [sites/github/panel.html](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/github/panel.html)
  - GitHub panel markup
- [sites/github/panel.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/github/panel.js)
  - GitHub panel behavior
  - status rendering
  - JSON export helpers
  - active-tab profile-page warning
- [sites/github/background/github-controller.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/github/background/github-controller.js)
  - public GitHub API fetch flow
  - snapshot reuse/cache rules
  - rate-limit tracking
  - storage writes

## GitHub Flow

The current GitHub integration is:

1. User opens a GitHub profile page such as `https://github.com/<login>`.
2. User opens the `GitHub` side-panel tab.
3. Panel sends `startGithubProfileScrape`.
4. Background controller validates that the active tab is a root GitHub profile URL.
5. Background controller calls the public GitHub REST API without authentication.
6. Profile data and public repos are fetched.
7. Existing saved README results are reused when the repo has not changed.
8. Only new, changed, or previously incomplete repos fetch README data again.
9. A normalized snapshot is stored in `chrome.storage.local`.
10. The panel reacts to storage changes and updates the status card / JSON export view.

## Storage Keys

### Shared

- `activeSiteTab`
  - active top-level site in the side panel

### GitHub

- `githubProfileSnapshot`
  - most recent saved GitHub snapshot for the currently scraped profile
- `githubProfileStatus`
  - short status line for the GitHub panel
- `githubProfileIsLoading`
  - whether a GitHub scrape is currently running

## Snapshot Shape

`githubProfileSnapshot` stores one object with these top-level fields:

- `scrapedAt`
- `source`
- `profile`
- `summary`
- `repos`

### `source`

Common fields:

- `mode`
  - currently `github-public-api-no-token`
- `activeTabUrl`
- `profilePath`

### `profile`

Common fields:

- `login`
- `id`
- `type`
- `name`
- `bio`
- `company`
- `location`
- `blog`
- `email`
- `htmlUrl`
- `avatarUrl`
- `followers`
- `following`
- `publicRepos`
- `publicGists`
- `createdAt`
- `updatedAt`

### `summary`

Common fields:

- `repoCount`
- `readmesFetched`
  - total count currently stored with `status: "fetched"`
- `readmesMissing`
- `readmesErrored`
- `readmesSkipped`
- `readmesFetchedThisRun`
  - only the new README fetches performed in the current run
- `readmesReused`
  - cached README results reused in the current run
- `rateLimitReached`
- `rateLimit`

### `summary.rateLimit`

Common fields:

- `limit`
- `remaining`
- `resetAt`
- `resource`

These values come from GitHub response headers:

- `x-ratelimit-limit`
- `x-ratelimit-remaining`
- `x-ratelimit-reset`
- `x-ratelimit-resource`

### `repos[]`

Common fields:

- `id`
- `name`
- `fullName`
- `owner`
- `description`
- `htmlUrl`
- `apiUrl`
- `homepage`
- `visibility`
- `defaultBranch`
- `language`
- `topics`
- `fork`
- `archived`
- `disabled`
- `size`
- `stargazersCount`
- `watchersCount`
- `forksCount`
- `openIssuesCount`
- `createdAt`
- `updatedAt`
- `pushedAt`
- `license`
- `readme`

## README State Model

Each repo stores a `readme` subtree.

Supported statuses:

- `fetched`
  - README content was fetched and decoded
- `missing`
  - GitHub returned `404` for the README endpoint
- `error`
  - README request failed for a non-404 reason
- `skipped`
  - README was not fetched because the unauthenticated limit was exhausted

### `readme.status === "fetched"`

Common fields:

- `name`
- `path`
- `sha`
- `size`
- `encoding`
- `htmlUrl`
- `downloadUrl`
- `text`

### Reuse / Cache Rule

The current reuse strategy is intentionally simple:

- reuse saved README data when:
  - the saved repo exists in the current snapshot
  - the saved README status is `fetched` or `missing`
  - the repo `pushedAt` value has not changed
- do not reuse when:
  - the repo is new
  - `pushedAt` changed
  - the old README status was `error`
  - the old README status was `skipped`

This keeps reruns cheap while still letting future runs retry incomplete work.

If you want a hard reset, use `Clear Data` from the GitHub panel.

## Rate Limit Behavior

Because the current implementation is unauthenticated, GitHub's public REST API limit applies.

Current behavior:

- read the rate-limit headers from every API response
- stop new README fetches if the remaining budget reaches `0`
- mark any still-pending repos as `readme.status = "skipped"`
- preserve already saved data

This is why a run can still succeed even when some repos are skipped near the end.

## Important Limitations

- The panel currently expects the active tab to be a root profile URL like `https://github.com/<login>`.
- Repository pages, sub-tabs like `/repositories`, and nested GitHub URLs are not treated as valid profile roots today.
- The integration only reads public repos because it does not use authentication.

## If You Need To Change X, Start Here

### Change GitHub fetch logic or caching

Start with:

- [sites/github/background/github-controller.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/github/background/github-controller.js)

### Change GitHub panel labels, status cards, or exports

Start with:

- [sites/github/panel.html](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/github/panel.html)
- [sites/github/panel.js](/c:/Users/Mega-PC/Desktop/projects/proposal-copycat/sites/github/panel.js)

### Change which GitHub URLs count as valid starting pages

Start with:

- `parseGithubProfileTarget(...)` in `sites/github/background/github-controller.js`
- `parseGithubProfileTab(...)` in `sites/github/panel.js`

Keep those two functions aligned.
