---
name: ats-boards-search
version: 1.0.0
description: >
  Use this skill to search software / engineering job openings in Canada (any
  arrangement: on-site, hybrid, remote) and US-remote roles, read directly from
  the public Greenhouse, Ashby and Lever job-board APIs of ~115 tech, fintech and
  bank employers (Stripe, Wealthsimple, Cohere, Databricks, GitLab, 1Password,
  Datadog ...). Trigger phrases: find software jobs in Canada, Toronto developer
  jobs, remote US engineering jobs, senior software engineer openings, platform /
  cloud / infrastructure / SRE roles, "is <company> hiring engineers in Canada",
  look up this Greenhouse/Ashby/Lever posting.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/ats-boards-search/cli/src/cli.ts *)
---

# ATS Boards Search (Canada + US-remote)

Reads the **public job-board APIs** that Greenhouse, Ashby and Lever serve so
companies can embed their openings on their own careers pages. No login, no API
key, zero runtime dependencies - it runs with just `bun`. Every posting comes
straight from the employer's own applicant-tracking system, so there are no
reposts, no stale aggregator copies, and the URL is the real apply page.

Scope is fixed to two regions, classified from each posting's location string:

| region | kept when |
|---|---|
| `canada` | any Canadian city/province appears (multi-location postings count if one seat is Canadian), or "Remote - Canada" |
| `us-remote` | remote and scoped to US / North America / Americas, or a bare "Remote" (US boards mean US-remote by it) |

US on-site and remote-elsewhere (EMEA, India, LATAM ...) postings are dropped.
The employer list is `cli/src/companies.json`; add a board by appending
`{company, ats, slug, sector}`.

## Commands

### Search

```bash
bun run .agents/skills/ats-boards-search/cli/src/cli.ts search [flags]
```

- `--query`/`-q <text>` - title keywords; every word must appear. Alternatives separated by `|`: `"senior software engineer|staff engineer|platform engineer"`.
- `--region`/`-r <canada|us-remote|both>` - default `both`.
- `--jobage <days>` - posted within N days (postings with no date are kept and show `date: null`).
- `--company`/`-c <slug,slug>` - restrict to some boards.
- `--ats <greenhouse|ashby|lever>` - restrict to one ATS.
- `--with-description` - include each posting's full text (bigger, slower; used by the feed workflow).
- `--page <n>` (pages of 50), `--limit`/`-n <n>`, `--format json|table|plain` (default `json`).

There is no `--location` flag: the region filter is the location filter. Each
search reads every selected board once (~115 requests, 8 in parallel).

### Detail

```bash
bun run .agents/skills/ats-boards-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

`id` is the `<ats>:<slug>:<job id>` from search (e.g. `greenhouse:stripe:7012345`),
or a `job-boards.greenhouse.io/...`, `jobs.ashbyhq.com/...` or `jobs.lever.co/...`
URL. A posting that has closed exits 1 with code `NOT_FOUND`.

## Usage examples

```bash
# Senior IC roles in Canada posted in the last two weeks
bun run .agents/skills/ats-boards-search/cli/src/cli.ts search -q "senior software engineer|senior backend|senior platform" -r canada --jobage 14 --format table

# Cloud / infrastructure roles open to US-remote
bun run .agents/skills/ats-boards-search/cli/src/cli.ts search -q "infrastructure engineer|platform engineer|site reliability|cloud engineer" -r us-remote --jobage 14 --format table

# Everything engineering at a few fintechs
bun run .agents/skills/ats-boards-search/cli/src/cli.ts search -q "engineer" -c wealthsimple,stripe,plaid,ramp --format table

# Full posting text
bun run .agents/skills/ats-boards-search/cli/src/cli.ts detail greenhouse:stripe:7012345 --format plain
```

## Output

| field | meaning |
|---|---|
| `id` | `<ats>:<slug>:<job id>`, input to `detail` |
| `title`, `company`, `location` | as the board lists them (multi-location joined with `; `) |
| `date` | ISO publish date (Greenhouse `first_published`, falling back to `updated_at`; Ashby `publishedAt`; Lever `createdAt`) |
| `url` | the employer's own posting / apply page |
| `region` | `canada` or `us-remote` |
| `remote` | the board marks it remote |
| `salary` | `{min, max, currency}` when Ashby or Lever publish a band, else `null` |
| `ats`, `sector` | source system; `tech` / `finance` / `consulting` |

`meta.boards_failed` lists boards that answered 404 or errored; one dead board
never fails the search, but every board failing exits 1 (`SEARCH_FAILED`), which
almost always means no network access.

## Notes

- Greenhouse's `content` is entity-escaped HTML; the CLI decodes before stripping tags.
- Greenhouse `updated_at` moves on any edit, so it is only the fallback date.
- Ashby has no single-posting endpoint: `detail` reads the board and picks the id.
- Environments whose egress proxy blocks these hosts (Claude Code cloud sessions)
  can use the `job-feed` GitHub Actions workflow instead, which runs this CLI on a
  GitHub runner and commits `job_scraper/feed/latest.json`.
