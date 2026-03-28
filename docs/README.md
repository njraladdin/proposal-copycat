# Documentation

This directory contains the maintainer-focused docs for the extension.

Use this as the starting point when you need to understand how the codebase is organized before making changes.

## Recommended Reading Order

1. [System Overview](./overview.md)
2. [GitHub Architecture](./github-architecture.md)
3. [Upwork Architecture](./upwork-architecture.md)
4. [Upwork Run Status](./upwork-run-status.md)
5. [Upwork Data Model](./upwork-data-model.md)
6. [Maintenance Guide](./maintenance-guide.md)

## What Each File Covers

- [overview.md](./overview.md)
  - extension shell architecture
  - site panel pattern
  - adding another site
- [github-architecture.md](./github-architecture.md)
  - GitHub panel/background flow
  - storage keys and snapshot shape
  - README reuse / caching behavior
  - rate-limit handling
- [upwork-architecture.md](./upwork-architecture.md)
  - core Upwork files
  - run types
  - execution styles
- [upwork-run-status.md](./upwork-run-status.md)
  - shared `upworkRunStatus` / `upworkRunControl` contract
  - writers/readers
  - run kinds and fields
- [upwork-data-model.md](./upwork-data-model.md)
  - important Upwork storage datasets
  - how the datasets relate to each other
- [maintenance-guide.md](./maintenance-guide.md)
  - file ownership
  - "change X, start here"
  - debugging notes
  - maintenance rules
