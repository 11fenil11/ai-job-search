import {
  BASE, COMPANIES, fromAshby, fromGreenhouse, fromLever, getJson, parseJobId,
  type Company, type Job,
} from "../helpers.js"

/** Look one posting up by the id `search` emitted (`<ats>:<slug>:<id>`) or by
 *  its public board URL. Resolves to null when the posting no longer exists. */
export async function detail(input: string, companies: Company[] = COMPANIES): Promise<Job | null> {
  const ref = parseJobId(input) ?? fromUrl(input)
  if (!ref) throw new Error(`cannot parse "${input}" - pass an id from search (e.g. greenhouse:stripe:123) or a board URL`)
  const c = companies.find((x) => x.ats === ref.ats && x.slug === ref.slug) ?? {
    company: ref.slug, ats: ref.ats, slug: ref.slug, sector: "tech",
  }
  if (ref.ats === "greenhouse") {
    const j = await getJson(`${BASE.greenhouse}/${ref.slug}/jobs/${ref.jobId}`)
    return j ? fromGreenhouse(c, j as Record<string, unknown>, true) : null
  }
  if (ref.ats === "lever") {
    const j = await getJson(`${BASE.lever}/${ref.slug}/${ref.jobId}?mode=json`)
    return j ? fromLever(c, j as Record<string, unknown>, true) : null
  }
  // Ashby's public posting API has no single-job endpoint: read the board.
  const d = (await getJson(`${BASE.ashby}/${ref.slug}?includeCompensation=true`)) as { jobs?: Record<string, unknown>[] } | null
  const j = d?.jobs?.find((x) => x.id === ref.jobId)
  return j ? fromAshby(c, j, true) : null
}

function fromUrl(u: string): ReturnType<typeof parseJobId> {
  let m = u.match(/greenhouse\.io\/(?:embed\/job_app\?for=)?([\w-]+)\/jobs\/(\d+)/)
  if (m) return { ats: "greenhouse", slug: m[1], jobId: m[2] }
  m = u.match(/jobs\.ashbyhq\.com\/([^/]+)\/([0-9a-f-]{36})/i)
  if (m) return { ats: "ashby", slug: m[1], jobId: m[2] }
  m = u.match(/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]{36})/i)
  if (m) return { ats: "lever", slug: m[1], jobId: m[2] }
  return null
}

export function renderDetail(j: Job, format: "json" | "plain"): string {
  if (format === "json") return JSON.stringify(j, null, 2)
  const pay = j.salary ? `\nSalary: ${j.salary.min ?? "?"}-${j.salary.max ?? "?"} ${j.salary.currency}` : ""
  return `${j.title}\n${j.company} | ${j.location ?? "-"} | ${j.region ?? "out of scope"} | ${j.date ?? "date unknown"}${pay}\n${j.url ?? ""}\n\n${j.description ?? "(no description)"}`
}
