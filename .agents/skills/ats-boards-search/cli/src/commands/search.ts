import {
  COMPANIES, fetchBoard, matchesQuery, pool, withinDays,
  type Ats, type Company, type Job, type Region,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  region: Region | "both"
  jobage?: number
  page: number
  limit?: number
  companies?: string[]
  ats?: Ats
  withDescription: boolean
  format: "json" | "table" | "plain"
}

export interface SearchOutput {
  meta: {
    count: number
    total: number
    page: number
    region: string
    boards: number
    boards_failed: { company: string; ats: Ats; slug: string; error: string }[]
  }
  results: Job[]
}

const PAGE_SIZE = 50

export async function search(opts: SearchOpts, companies: Company[] = COMPANIES): Promise<SearchOutput> {
  let boards = companies
  if (opts.companies?.length) {
    const want = new Set(opts.companies.map((s) => s.toLowerCase()))
    boards = boards.filter((c) => want.has(c.slug.toLowerCase()))
  }
  if (opts.ats) boards = boards.filter((c) => c.ats === opts.ats)

  const failed: SearchOutput["meta"]["boards_failed"] = []
  const perBoard = await pool(boards, 8, async (c) => {
    try {
      return await fetchBoard(c, opts.withDescription)
    } catch (err) {
      failed.push({ company: c.company, ats: c.ats, slug: c.slug, error: String((err as Error).message ?? err) })
      return [] as Job[]
    }
  })

  const all = perBoard
    .flat()
    .filter((j) => j.region !== null && (opts.region === "both" || j.region === opts.region))
    .filter((j) => matchesQuery(j.title, opts.query))
    .filter((j) => withinDays(j.date, opts.jobage))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))

  const start = (opts.page - 1) * PAGE_SIZE
  const results = all.slice(start, start + (opts.limit ?? PAGE_SIZE))

  return {
    meta: {
      count: results.length,
      total: all.length,
      page: opts.page,
      region: opts.region,
      boards: boards.length,
      boards_failed: failed,
    },
    results,
  }
}

export function render(out: SearchOutput, format: SearchOpts["format"]): string {
  if (format === "json") return JSON.stringify(out, null, 2)
  if (format === "plain") {
    return out.results
      .map((j) => `${j.title}\n  ${j.company} | ${j.location ?? "-"} | ${j.region} | ${j.date ?? "date unknown"}\n  ${j.url ?? ""}\n  id: ${j.id}`)
      .join("\n\n")
  }
  const rows = out.results.map((j) => [j.date ?? "-", j.region ?? "-", j.company, j.title, j.location ?? "-"])
  const head = ["date", "region", "company", "title", "location"]
  const w = head.map((h, i) => Math.min(48, Math.max(h.length, ...rows.map((r) => r[i].length))))
  const fmt = (r: string[]) => r.map((c, i) => (c.length > w[i] ? c.slice(0, w[i] - 1) + "…" : c.padEnd(w[i]))).join("  ")
  const failed = out.meta.boards_failed.length ? `\n${out.meta.boards_failed.length} board(s) failed: ${out.meta.boards_failed.map((b) => b.slug).join(", ")}` : ""
  return [fmt(head), fmt(w.map((n) => "-".repeat(n))), ...rows.map(fmt), "", `${out.meta.count} shown of ${out.meta.total} matching across ${out.meta.boards} boards${failed}`].join("\n")
}
