#!/usr/bin/env bun
// Self-contained CLI over the public job-board APIs of Greenhouse, Ashby and
// Lever, scoped to two regions: Canada (any arrangement) and US-remote. No
// authentication and zero runtime dependencies; these are the documented
// public endpoints the boards serve to embed job lists on company sites.

import { render, search, type SearchOpts } from "./commands/search.js"
import { detail, renderDetail } from "./commands/detail.js"
import { writeError, type Ats } from "./helpers.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  const alias: Record<string, string> = { q: "query", r: "region", n: "limit", c: "company" }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("-")) {
      const key = alias[a.replace(/^-+/, "")] ?? a.replace(/^-+/, "")
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("-")) flags[key] = true
      else {
        flags[key] = next
        i++
      }
    } else (flags._ as string[]).push(a)
  }
  return flags
}

const HELP = `ats-boards-cli - software jobs in Canada and US-remote from Greenhouse, Ashby and Lever boards

USAGE
  bun run src/cli.ts search [flags]
  bun run src/cli.ts detail <id|url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>      Title keywords. Every word must appear; separate alternatives
                          with "|", e.g. "senior software engineer|staff engineer|sre".
  --region, -r <r>        canada | us-remote | both (default both).
  --jobage <days>         Posted within N days. Postings with no date are kept.
  --company, -c <slugs>   Comma-separated board slugs to restrict to (see src/companies.json).
  --ats <name>            greenhouse | ashby | lever.
  --with-description      Include each posting's full description text (slower).
  --page <n>              1-indexed page of 50. Default 1.
  --limit, -n <n>         Cap results emitted (may exceed the page size).
  --format <fmt>          json (default) | table | plain.

EXAMPLES
  bun run src/cli.ts search -q "senior software engineer" --region canada --jobage 14 --format table
  bun run src/cli.ts search -q "platform engineer|infrastructure engineer" -r us-remote --format table
  bun run src/cli.ts search -q "engineer" -c stripe,shopify,wealthsimple --format table
  bun run src/cli.ts detail greenhouse:stripe:7012345 --format plain
`

const KNOWN: Record<string, Set<string>> = {
  search: new Set(["query", "region", "jobage", "company", "ats", "with-description", "page", "limit", "format", "help", "h"]),
  detail: new Set(["format", "help", "h"]),
}

function posInt(v: string | boolean | string[] | undefined, name: string): number | undefined | Error {
  if (v === undefined) return undefined
  const n = Number(v)
  if (typeof v !== "string" || !Number.isInteger(n) || n < 1) return new Error(`--${name} must be a positive integer`)
  return n
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2))
  const cmd = (flags._ as string[])[0]
  if (!cmd || flags.help || flags.h) {
    process.stdout.write(HELP)
    return cmd ? 0 : 1
  }
  const known = KNOWN[cmd]
  if (!known) {
    writeError(`unknown command '${cmd}' - use search or detail`, "UNKNOWN_COMMAND")
    return 1
  }
  for (const k of Object.keys(flags)) {
    if (k !== "_" && !known.has(k)) {
      writeError(`unknown flag --${k} for '${cmd}' - flags are never silently ignored; see --help`, "UNKNOWN_FLAG")
      return 1
    }
  }
  const fmt = flags.format === undefined ? "json" : String(flags.format)

  if (cmd === "search") {
    if (!["json", "table", "plain"].includes(fmt)) {
      writeError(`--format must be one of json|table|plain, got "${fmt}"`, "BAD_ARG")
      return 1
    }
    if (flags.query !== undefined && (typeof flags.query !== "string" || !flags.query.trim())) {
      writeError("--query requires a non-empty value", "BAD_ARG")
      return 1
    }
    const region = flags.region === undefined ? "both" : String(flags.region)
    if (!["canada", "us-remote", "both"].includes(region)) {
      writeError(`--region must be one of canada|us-remote|both, got "${region}"`, "BAD_ARG")
      return 1
    }
    if (flags.ats !== undefined && !["greenhouse", "ashby", "lever"].includes(String(flags.ats))) {
      writeError(`--ats must be one of greenhouse|ashby|lever, got "${flags.ats}"`, "BAD_ARG")
      return 1
    }
    if (flags.company !== undefined && typeof flags.company !== "string") {
      writeError("--company requires a comma-separated list of slugs", "BAD_ARG")
      return 1
    }
    const nums: Record<string, number | undefined> = {}
    for (const name of ["jobage", "page", "limit"]) {
      const v = posInt(flags[name], name)
      if (v instanceof Error) {
        writeError(v.message, "BAD_ARG")
        return 1
      }
      nums[name] = v
    }
    const opts: SearchOpts = {
      query: typeof flags.query === "string" ? flags.query : undefined,
      region: region as SearchOpts["region"],
      jobage: nums.jobage,
      page: nums.page ?? 1,
      limit: nums.limit,
      companies: typeof flags.company === "string" ? flags.company.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      ats: flags.ats as Ats | undefined,
      withDescription: flags["with-description"] === true,
      format: fmt as SearchOpts["format"],
    }
    try {
      const out = await search(opts)
      if (out.meta.boards > 0 && out.meta.boards_failed.length === out.meta.boards) {
        writeError(`every board failed (${out.meta.boards_failed[0]?.error}) - check network access`, "SEARCH_FAILED")
        return 1
      }
      process.stdout.write(render(out, opts.format) + "\n")
      return 0
    } catch (err) {
      writeError(String((err as Error).message ?? err), "SEARCH_FAILED")
      return 1
    }
  }

  // detail
  if (!["json", "plain"].includes(fmt)) {
    writeError(`--format must be one of json|plain, got "${fmt}"`, "BAD_ARG")
    return 1
  }
  const ref = (flags._ as string[])[1]
  if (!ref) {
    writeError("detail needs an id from search (e.g. greenhouse:stripe:123) or a board URL", "NO_ID")
    return 1
  }
  try {
    const j = await detail(ref)
    if (!j) {
      writeError(`posting ${ref} was not found - it has likely closed`, "NOT_FOUND")
      return 1
    }
    process.stdout.write(renderDetail(j, fmt as "json" | "plain") + "\n")
    return 0
  } catch (err) {
    writeError(String((err as Error).message ?? err), "DETAIL_FAILED")
    return 1
  }
}

process.exit(await main())
