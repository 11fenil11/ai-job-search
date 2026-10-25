import { describe, expect, test } from "bun:test"
import { classifyRegion, matchesQuery, stripHtml, withinDays } from "../src/helpers"

describe("classifyRegion", () => {
  test.each([
    ["Toronto, ON", "canada"],
    ["Vancouver, British Columbia, Canada", "canada"],
    ["Remote - Canada", "canada"],
    ["San Francisco, CA; Toronto", "canada"],
    ["Montréal", "canada"],
    ["Remote - US", "us-remote"],
    ["Remote, United States", "us-remote"],
    ["Remote (North America)", "us-remote"],
    ["Remote", "us-remote"],
    ["San Francisco, CA", null],
    ["New York, NY", null],
    ["Remote - EMEA", null],
    ["Remote, India", null],
    ["London, UK", null],
  ])("%s -> %s", (loc, want) => {
    expect(classifyRegion(loc)).toBe(want as never)
  })

  test("an ATS remote flag with a bare city outside NA stays out of scope", () => {
    expect(classifyRegion("Berlin, Germany", true)).toBeNull()
  })

  test("an ATS remote flag with no location reads as US-remote", () => {
    expect(classifyRegion(null, true)).toBe("us-remote")
  })
})

describe("matchesQuery", () => {
  test("every word of an alternative must appear", () => {
    expect(matchesQuery("Senior Software Engineer, Payments", "senior software engineer")).toBe(true)
    expect(matchesQuery("Software Engineer II", "senior software engineer")).toBe(false)
  })
  test("alternatives are separated by |", () => {
    expect(matchesQuery("Staff Site Reliability Engineer", "senior software|site reliability")).toBe(true)
  })
  test("words match at a word start, not inside another word", () => {
    expect(matchesQuery("Salesforce Developer", "sre")).toBe(false)
  })
})

test("stripHtml decodes Greenhouse's double-encoded content", () => {
  expect(stripHtml("&lt;p&gt;Build &amp;amp; scale&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;/ul&gt;")).toBe("Build & scale\n• Python")
})

test("withinDays keeps undated postings and drops stale ones", () => {
  const now = new Date("2026-10-25T00:00:00Z")
  expect(withinDays(null, 14, now)).toBe(true)
  expect(withinDays("2026-10-20", 14, now)).toBe(true)
  expect(withinDays("2026-09-01", 14, now)).toBe(false)
})
