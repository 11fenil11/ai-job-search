import { join } from "path"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

const CLI_PATH = join(import.meta.dir, "../src/cli.ts")
const FIXTURES = join(import.meta.dir, "fixtures")

export interface CLIResult {
  stdout: string
  stderr: string
  exitCode: number
}

export async function runCLI(args: string[], preload?: string): Promise<CLIResult> {
  const proc = Bun.spawn(["bun", "run", ...(preload ? ["--preload", preload] : []), CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

/** Board URL path -> fixture file. Anything else answers 404, like a board
 *  that does not exist. */
const ROUTES: Record<string, string> = {
  "/v1/boards/stripe/jobs": "greenhouse-stripe.json",
  "/posting-api/job-board/wealthsimple": "ashby-wealthsimple.json",
  "/v0/postings/spotify": "lever-spotify.json",
}

/** Run the real CLI offline: a preload rewrites every board request to a
 *  local server that answers from tests/fixtures. */
export async function runOffline(args: string[]): Promise<{ result: CLIResult; requests: URL[] }> {
  const requests: URL[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      requests.push(url)
      const greenhouseOne = url.pathname.match(/^\/v1\/boards\/stripe\/jobs\/(\d+)$/)
      if (greenhouseOne) {
        const all = await Bun.file(join(FIXTURES, "greenhouse-stripe.json")).json()
        const job = all.jobs.find((j: { id: number }) => String(j.id) === greenhouseOne[1])
        return job ? Response.json(job) : new Response("not found", { status: 404 })
      }
      const file = ROUTES[url.pathname]
      if (!file) return new Response("not found", { status: 404 })
      return new Response(Bun.file(join(FIXTURES, file)))
    },
  })
  const dir = mkdtempSync(join(tmpdir(), "ats-boards-"))
  const preload = join(dir, "fetch.ts")
  writeFileSync(
    preload,
    `
    const originalFetch = globalThis.fetch;
    const hosts = ["boards-api.greenhouse.io", "api.ashbyhq.com", "api.lever.co"];
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!hosts.includes(url.hostname)) throw new Error("Unexpected request to " + url.hostname);
      return originalFetch(${JSON.stringify(server.url.origin)} + url.pathname + url.search, init);
    };
  `,
  )
  try {
    return { result: await runCLI(args, preload), requests }
  } finally {
    server.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
}

export function parseJSON<T = unknown>(result: CLIResult): T {
  if (result.exitCode !== 0) throw new Error(`CLI exited with code ${result.exitCode}. stderr: ${result.stderr}`)
  return JSON.parse(result.stdout) as T
}
