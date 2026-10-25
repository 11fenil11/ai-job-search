# ATS board endpoints

All three are public, unauthenticated JSON APIs documented by the vendors for
embedding job lists on employer sites.

| ATS | list | single posting |
|---|---|---|
| Greenhouse | `GET https://boards-api.greenhouse.io/v1/boards/<slug>/jobs[?content=true]` | `GET .../boards/<slug>/jobs/<id>` |
| Ashby | `GET https://api.ashbyhq.com/posting-api/job-board/<slug>?includeCompensation=true` | none - filter the list by `id` |
| Lever | `GET https://api.lever.co/v0/postings/<slug>?mode=json` | `GET .../postings/<slug>/<id>?mode=json` |

## Field paths

| field | Greenhouse | Ashby | Lever |
|---|---|---|---|
| id | `id` (int) | `id` (uuid) | `id` (uuid) |
| title | `title` | `title` | `text` |
| location | `location.name` | `location` + `secondaryLocations[].location` | `categories.allLocations[]` / `categories.location` |
| remote | (location text only) | `isRemote`, `workplaceType == "Remote"` | `workplaceType == "remote"` |
| date | `first_published` / `updated_at` | `publishedAt` | `createdAt` (epoch ms) |
| url | `absolute_url` | `jobUrl` | `hostedUrl` |
| description | `content` (entity-escaped HTML) | `descriptionPlain` / `descriptionHtml` | `descriptionPlain` + `lists[]` + `additionalPlain` |
| salary | - | `compensation.summaryComponents[compensationType=Salary]` | `salaryRange` |

Unlisted Ashby postings carry `isListed: false` and are skipped. A wrong slug is
a 404 on all three.
