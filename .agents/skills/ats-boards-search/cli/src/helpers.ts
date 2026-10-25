// Shared helpers for ats-boards-search: fetching with backoff, the three ATS
// normalisers (Greenhouse, Ashby, Lever) and the Canada / US-remote region
// classifier that decides whether a posting is in scope at all.

import companiesJson from "./companies.json" with { type: "json" }

export type Ats = "greenhouse" | "ashby" | "lever"
export type Region = "canada" | "us-remote"

export interface Company {
  company: string
  ats: Ats
  slug: string
  sector: string
}

export interface Job {
  id: string
  title: string
  company: string
  location: string | null
  date: string | null
  url: string | null
  region: Region | null
  remote: boolean
  ats: Ats
  sector: string
  salary: { min: number | null; max: number | null; currency: string } | null
  description?: string | null
}

export const COMPANIES: Company[] = companiesJson as Company[]

export const BASE = {
  greenhouse: "https://boards-api.greenhouse.io/v1/boards",
  ashby: "https://api.ashbyhq.com/posting-api/job-board",
  lever: "https://api.lever.co/v0/postings",
} as const

const UA = "Mozilla/5.0 (compatible; ats-boards-cli/1.0)"

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** GET a JSON document. 404 resolves to null (a board that moved is not a
 *  crash); 429/5xx back off exponentially with jitter, up to 6 attempts. */
export async function getJson(url: string, tries = 6): Promise<unknown | null> {
  for (let i = 0; i < tries; i++) {
    let res: Response
    try {
      res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      if (i + 1 === tries) throw err
      await sleep(500 * 2 ** i + Math.random() * 250)
      continue
    }
    if (res.status === 404) return null
    if (res.status === 429 || res.status >= 500) {
      if (i + 1 === tries) throw new Error(`HTTP ${res.status} from ${url}`)
      await sleep(500 * 2 ** i + Math.random() * 250)
      continue
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
    return res.json()
  }
  return null
}

// ---------------------------------------------------------------- text ----

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"', mdash: "-", ndash: "-", hellip: "...", bull: "•",
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
}

/** HTML to readable text. Greenhouse double-encodes its content (the HTML
 *  arrives entity-escaped), so entities are decoded before tags are stripped. */
export function stripHtml(s: string | null | undefined): string {
  if (!s) return ""
  let t = decodeEntities(s)
  t = t.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
  t = t.replace(/<li[^>]*>/gi, "\n• ")
  t = t.replace(/<\/(p|div|h[1-6]|ul|ol|li)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
  t = decodeEntities(t.replace(/<[^>]+>/g, " "))
  t = t.replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n")
  return t.replace(/\n+• /g, "\n• ").replace(/\n{3,}/g, "\n\n").trim()
}

export function isoDate(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null
  const d = typeof v === "number" ? new Date(v) : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

// -------------------------------------------------------------- region ----

const CA_PLACES = [
  "canada", "toronto", "vancouver", "montreal", "montréal", "ottawa", "calgary", "waterloo",
  "kitchener", "edmonton", "halifax", "winnipeg", "victoria, bc", "mississauga", "quebec",
  "québec", "burnaby", "markham", "saskatoon", "regina", "kelowna", "guelph", "fredericton",
  "moncton", "st. john's", "ontario", "british columbia", "alberta", "nova scotia", "manitoba",
]
const CA_PROVINCE = /,\s*(on|bc|qc|ab|ns|mb|sk|nb|nl|pe)\b/i
const REMOTE = /\b(remote|anywhere|distributed|work from home|wfh)\b/i
const US_SCOPE = /\b(us|u\.s\.|usa|united states|north america|americas|amer|namer|nam)\b/i
// A remote posting scoped to a country or city that is neither the US nor Canada.
const NON_NA = new RegExp(
  "\\b(" +
    [
      "emea", "europe", "uk", "united kingdom", "england", "london", "ireland", "dublin", "germany", "berlin",
      "munich", "france", "paris", "spain", "madrid", "barcelona", "portugal", "lisbon", "italy", "milan",
      "netherlands", "amsterdam", "belgium", "switzerland", "zurich", "austria", "vienna", "poland", "warsaw",
      "czech", "prague", "romania", "hungary", "bulgaria", "serbia", "greece", "ukraine", "turkey", "istanbul",
      "sweden", "stockholm", "norway", "denmark", "copenhagen", "finland", "estonia", "latvia", "lithuania",
      "israel", "tel aviv", "dubai", "uae", "saudi", "africa", "nigeria", "kenya", "egypt",
      "india", "bangalore", "bengaluru", "hyderabad", "pune", "mumbai", "delhi", "chennai",
      "apac", "asia", "japan", "tokyo", "korea", "seoul", "china", "shanghai", "beijing", "hong kong", "taiwan",
      "singapore", "malaysia", "indonesia", "philippines", "vietnam", "thailand", "australia", "sydney",
      "melbourne", "new zealand", "latam", "mexico", "brazil", "são paulo", "sao paulo", "argentina",
      "colombia", "chile", "peru", "uruguay", "costa rica",
    ].join("|") +
    ")\\b",
  "i",
)
// A location that names a country-level scope and no city.
const COUNTRY_ONLY = /^\s*(united states|usa|us|u\.s\.|north america|americas)?\s*$/i

/** Classify a posting's location string into the search's target regions.
 *
 *  - canada:    names a Canadian place, or "Remote - Canada".
 *  - us-remote: "remote" (or distributed / anywhere) appears in the location
 *               text and it is not scoped to another country - "Remote - US",
 *               "US-TX-Remote", "Remote, Global", a bare "Remote".
 *  - null:      on-site anywhere outside Canada, or remote somewhere else.
 *
 *  The ATS's own remote flag (`remoteHint`) only counts when the location names
 *  no city: Ashby sets `isRemote` on on-site San Francisco and São Paulo
 *  postings alike, so trusting it put both in the US-remote list.
 *
 *  Multi-location strings ("Toronto; San Francisco") count as Canada when any
 *  part is Canadian, since an applicant there can take the Canadian seat. */
export function classifyRegion(location: string | null | undefined, remoteHint = false): Region | null {
  const raw = location ?? ""
  const loc = ` ${raw.toLowerCase()} `
  if (CA_PLACES.some((p) => loc.includes(p)) || CA_PROVINCE.test(loc)) return "canada"
  if (!REMOTE.test(loc)) return remoteHint && COUNTRY_ONLY.test(raw) ? "us-remote" : null
  if (NON_NA.test(loc) && !US_SCOPE.test(loc)) return null
  return "us-remote"
}

// ---------------------------------------------------------- normalisers ----

type Raw = Record<string, any>

export function jobId(ats: Ats, slug: string, id: unknown): string {
  return `${ats}:${slug}:${id}`
}

export function parseJobId(id: string): { ats: Ats; slug: string; jobId: string } | null {
  const m = id.match(/^(greenhouse|ashby|lever):([^:]+):(.+)$/)
  return m ? { ats: m[1] as Ats, slug: m[2], jobId: m[3] } : null
}

export function fromGreenhouse(c: Company, j: Raw, withDescription: boolean): Job {
  const location = j.location?.name ?? null
  return {
    id: jobId("greenhouse", c.slug, j.id),
    title: String(j.title ?? "").trim(),
    company: c.company,
    location,
    date: isoDate(j.first_published ?? j.updated_at),
    url: j.absolute_url ?? null,
    region: classifyRegion(location),
    remote: REMOTE.test(location ?? ""),
    ats: "greenhouse",
    sector: c.sector,
    salary: null,
    ...(withDescription ? { description: stripHtml(j.content) || null } : {}),
  }
}

export function fromAshby(c: Company, j: Raw, withDescription: boolean): Job {
  const secondary = (j.secondaryLocations ?? []).map((s: Raw) => s.location).filter(Boolean)
  const location = [j.location, ...secondary].filter(Boolean).join("; ") || null
  const remote = Boolean(j.isRemote) || j.workplaceType === "Remote"
  let salary: Job["salary"] = null
  for (const s of j.compensation?.summaryComponents ?? []) {
    if (s.compensationType === "Salary") {
      salary = { min: s.minValue ?? null, max: s.maxValue ?? null, currency: String(s.currencyCode ?? "USD") }
      break
    }
  }
  return {
    id: jobId("ashby", c.slug, j.id),
    title: String(j.title ?? "").trim(),
    company: c.company,
    location,
    date: isoDate(j.publishedAt),
    url: j.jobUrl ?? j.applyUrl ?? null,
    region: classifyRegion(location, remote),
    remote,
    ats: "ashby",
    sector: c.sector,
    salary,
    ...(withDescription ? { description: (j.descriptionPlain || stripHtml(j.descriptionHtml)) || null } : {}),
  }
}

export function fromLever(c: Company, j: Raw, withDescription: boolean): Job {
  const cats = j.categories ?? {}
  const all: string[] = cats.allLocations ?? []
  const location = (all.length ? all.join("; ") : cats.location) || null
  const remote = j.workplaceType === "remote" || REMOTE.test(location ?? "")
  const lists = (j.lists ?? []).map((l: Raw) => `${l.text}\n${stripHtml(l.content)}`).join("\n\n")
  const sr = j.salaryRange
  return {
    id: jobId("lever", c.slug, j.id),
    title: String(j.text ?? "").trim(),
    company: c.company,
    location,
    date: isoDate(j.createdAt),
    url: j.hostedUrl ?? null,
    region: classifyRegion(location, remote),
    remote,
    ats: "lever",
    sector: c.sector,
    salary: sr ? { min: sr.min ?? null, max: sr.max ?? null, currency: String(sr.currency ?? "USD") } : null,
    ...(withDescription
      ? { description: [j.descriptionPlain ?? stripHtml(j.description), lists, j.additionalPlain].filter(Boolean).join("\n\n") || null }
      : {}),
  }
}

/** Fetch one company's whole board, normalised. Descriptions ride along only
 *  when asked for: Greenhouse's content=true multiplies the payload. */
export async function fetchBoard(c: Company, withDescription: boolean): Promise<Job[]> {
  if (c.ats === "greenhouse") {
    const d = (await getJson(`${BASE.greenhouse}/${c.slug}/jobs${withDescription ? "?content=true" : ""}`)) as Raw | null
    if (!d) throw new Error("board not found")
    return (d.jobs ?? []).map((j: Raw) => fromGreenhouse(c, j, withDescription))
  }
  if (c.ats === "ashby") {
    const d = (await getJson(`${BASE.ashby}/${c.slug}?includeCompensation=true`)) as Raw | null
    if (!d) throw new Error("board not found")
    return (d.jobs ?? []).filter((j: Raw) => j.isListed !== false).map((j: Raw) => fromAshby(c, j, withDescription))
  }
  const d = (await getJson(`${BASE.lever}/${c.slug}?mode=json`)) as Raw[] | null
  if (!d) throw new Error("board not found")
  return d.map((j) => fromLever(c, j, withDescription))
}

// ------------------------------------------------------------- filters ----

/** `--query` matching: alternatives separated by `|`, and every word of one
 *  alternative must appear in the title. "senior software engineer|sre" keeps
 *  "Senior Software Engineer, Payments" and "SRE II". */
export function matchesQuery(title: string, query: string | undefined): boolean {
  if (!query) return true
  const t = title.toLowerCase()
  return query
    .toLowerCase()
    .split("|")
    .map((alt) => alt.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length)
    .some((words) => words.every((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(t)))
}

export function withinDays(date: string | null, days: number | undefined, now = new Date()): boolean {
  if (!days || !date) return true
  return now.getTime() - new Date(date).getTime() <= days * 86_400_000
}

/** Run `fn` over `items` with at most `n` in flight. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}
