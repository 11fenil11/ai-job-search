import { describe, expect, test } from "bun:test"
import { parseJSON, runCLI, runOffline } from "./helpers"

interface Out {
  meta: { count: number; total: number; boards: number; boards_failed: { slug: string }[] }
  results: { id: string; title: string; company: string; location: string | null; date: string | null; url: string | null; region: string; salary: unknown; description?: string }[]
}

const BOARDS = ["-c", "stripe,wealthsimple,spotify"]

describe("search (offline fixtures)", () => {
  test("keeps Canada and US-remote, drops US on-site, other-region remote and non-matching titles", async () => {
    const { result } = await runOffline(["search", "-q", "senior software engineer|staff infrastructure|senior backend", ...BOARDS])
    const out = parseJSON<Out>(result)
    const titles = out.results.map((r) => `${r.company}|${r.title}|${r.region}`)
    expect(titles).toContain("Stripe|Senior Software Engineer, Payments|canada")
    expect(titles).toContain("Stripe|Staff Infrastructure Engineer|us-remote")
    expect(titles).toContain("Wealthsimple|Senior Software Engineer, Platform|us-remote")
    expect(titles).toContain("Wealthsimple|Senior Software Engineer|canada")
    expect(titles).toContain("Spotify|Senior Backend Engineer - Ads|canada")
    expect(out.results.some((r) => r.url?.endsWith("/103"))).toBe(false) // San Francisco on-site
    expect(out.results.some((r) => r.url?.endsWith("/104"))).toBe(false) // Remote - EMEA
    expect(out.results.some((r) => r.url?.endsWith("/x3"))).toBe(false) // remote London
    expect(out.results.some((r) => r.title === "Account Executive")).toBe(false)
    for (const r of out.results) {
      for (const k of ["id", "title", "company", "location", "date", "url"]) expect(k in r).toBe(true)
    }
  })

  test("--region canada and --jobage narrow the pool; results sort newest first", async () => {
    const { result } = await runOffline(["search", "-r", "canada", "--jobage", "3650", ...BOARDS])
    const out = parseJSON<Out>(result)
    expect(out.results.every((r) => r.region === "canada")).toBe(true)
    const dates = out.results.map((r) => r.date ?? "")
    expect([...dates].sort().reverse()).toEqual(dates)
  })

  test("Ashby salary bands and Lever salary ranges carry through", async () => {
    const { result } = await runOffline(["search", "-q", "platform|ads", ...BOARDS])
    const out = parseJSON<Out>(result)
    const platform = out.results.find((r) => r.title.includes("Platform"))
    expect(platform?.salary).toEqual({ min: 170000, max: 210000, currency: "CAD" })
    const ads = out.results.find((r) => r.title.includes("Ads"))
    expect(ads?.salary).toEqual({ min: 150000, max: 190000, currency: "CAD" })
  })

  test("--with-description asks Greenhouse for content and returns readable text", async () => {
    const { result, requests } = await runOffline(["search", "-q", "payments", "-c", "stripe", "--with-description"])
    const out = parseJSON<Out>(result)
    expect(requests[0].searchParams.get("content")).toBe("true")
    expect(out.results[0].description).toBe("Build & scale AWS systems.\n• Python\n• Terraform")
  })

  test("a missing board is reported in meta, not fatal", async () => {
    const { result } = await runOffline(["search", "-c", "stripe,notion"])
    const out = parseJSON<Out>(result)
    expect(out.meta.boards).toBe(2)
    expect(out.meta.boards_failed.map((b) => b.slug)).toEqual(["notion"])
  })

  test("every board failing exits 1 with a JSON error", async () => {
    const { result } = await runOffline(["search", "-c", "notion"])
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("SEARCH_FAILED")
  })
})

describe("detail (offline fixtures)", () => {
  test("greenhouse id returns the posting with its description", async () => {
    const { result } = await runOffline(["detail", "greenhouse:stripe:101"])
    const job = parseJSON<Out["results"][number]>(result)
    expect(job.title).toBe("Senior Software Engineer, Payments")
    expect(job.description).toContain("Terraform")
  })

  test("an Ashby board URL resolves through the board listing", async () => {
    const { result } = await runOffline(["detail", "https://jobs.ashbyhq.com/wealthsimple/6f0c1c2e-1111-4a5b-9c9d-000000000001"])
    expect(parseJSON<Out["results"][number]>(result).description).toBe("Own our Kubernetes platform.")
  })

  test("a closed posting exits 1 with NOT_FOUND", async () => {
    const { result } = await runOffline(["detail", "greenhouse:stripe:999"])
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("NOT_FOUND")
  })
})

describe("argument validation", () => {
  test.each([
    [["search", "--bogus", "x"], "UNKNOWN_FLAG"],
    [["search", "--region", "europe"], "BAD_ARG"],
    [["search", "-q"], "BAD_ARG"],
    [["search", "--jobage", "two"], "BAD_ARG"],
    [["search", "--format", "xml"], "BAD_ARG"],
    [["detail"], "NO_ID"],
    [["detail", "not-an-id"], "DETAIL_FAILED"],
  ])("%p exits 1 with %s on stderr", async (args, code) => {
    const r = await runCLI(args as string[])
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toBe("")
    expect(JSON.parse(r.stderr).code).toBe(code)
  })
})
