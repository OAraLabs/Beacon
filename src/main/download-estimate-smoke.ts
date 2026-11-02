/**
 * The size setup's confirmation says (A-confirm) — headless, under ELECTRON_RUN_AS_NODE.
 *
 *   1. The reading (src/main/prometheus-install.ts releaseDownloadSize): the release's prometheus-mac.json, read with the
 *      installer's own rules (redirects held to the release's hosts, 16 KB at most, the release's own folder), gives the
 *      size; anything else (no answer, a refusal, a stall, a manifest Beacon cannot read) gives null, within the timeout.
 *      Only the manifest is asked for, never the zip.
 *   2. The screen: the real ConfirmSetupView through react-dom/server says the manifest's size, and the constant without one.
 *   3. The wiring: the screen shows the constant at once and asks main in its own step; main answers from the installer's deps.
 *
 * What it cannot prove: that GitHub answers in time on a real network. probe:onboarding-install drives the real screen.
 *
 * Run: npm run build && npm run smoke:download-estimate
 */
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DOWNLOAD_ESTIMATE_MB, DOWNLOAD_SIZE_TIMEOUT_MS, downloadEstimateMB } from '@shared/mac-check'
import { MAX_MANIFEST_BYTES, installEnv, type InstallEnv } from '@shared/prometheus-app'
import { releaseDownloadSize } from './prometheus-install'
import { ConfirmSetupView } from '../renderer/src/components/onboarding/ConfirmSetupView'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[download-estimate-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}

const BASE = 'http://127.0.0.1:9/release'
const TAG = 'http://127.0.0.1:9/release/download/v0.9.17'
const STUB: InstallEnv = { ...installEnv({}, false), releaseBase: BASE, overridden: true }
const GITHUB: InstallEnv = installEnv({}, false)
const SIZE = 64_400_000 // not the constant's release, so a screen that says 64 MB read it from the manifest
const manifestOf = (size: unknown = SIZE): string => JSON.stringify({ version: '0.9.17', asset: 'Prometheus-0.9.17-arm64.zip', sha256: 'a'.repeat(64), size, team_id: '53JM8W47RL' })

interface Seen {
  url: string
  method: string
  headers: Record<string, string>
}
type Answer = (url: string, init: RequestInit | undefined) => Response | Promise<Response>
function fakeFetch(answer: Answer): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = []
  const f = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url)
    seen.push({ url: u, method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()) })
    return answer(u, init)
  }
  return { fetch: f as typeof fetch, seen }
}
/** The stub release: the manifest is redirected into its tagged folder, as GitHub does. */
const stubRelease = (body: () => Response): Answer => (u) => {
  if (u === `${BASE}/prometheus-mac.json`) return new Response(null, { status: 302, headers: { location: `${TAG}/prometheus-mac.json` } })
  if (u === `${TAG}/prometheus-mac.json`) return body()
  return new Response('Not Found', { status: 404 })
}
// A server that never answers, and does not even hear the abort: only the timeout's own race ends it.
const never: Answer = () => new Promise<Response>(() => undefined)

async function timed<T>(p: Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now()
  const value = await p
  return { value, ms: Date.now() - t0 }
}

async function main(): Promise<void> {
  // ── 1. the reading ──────────────────────────────────────────────────────────────────────────────────────────────────
  const ok = fakeFetch(stubRelease(() => new Response(manifestOf(), { status: 200 })))
  const got = await releaseDownloadSize({ fetch: ok.fetch, env: STUB })
  assert(got === SIZE, 'manifest: the size the release manifest says is the size', String(got))
  assert(
    ok.seen.every((q) => q.method === 'GET' && !('authorization' in q.headers) && !('cookie' in q.headers)) && ok.seen.every((q) => q.url.endsWith('/prometheus-mac.json')),
    'manifest: only the manifest is asked for (never the zip), as GETs with no credential',
    JSON.stringify(ok.seen.map((q) => q.url))
  )

  // GitHub's chain: latest → the tagged folder on github.com → a signed URL on the asset host.
  const GH_REL = 'https://github.com/OAraLabs/Prometheus/releases'
  const ASSET = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/m?sp=r&sig=TOKEN-M'
  const gh = fakeFetch((u) => {
    if (u === `${GH_REL}/latest/download/prometheus-mac.json`) return new Response(null, { status: 302, headers: { location: `${GH_REL}/download/v0.9.17/prometheus-mac.json` } })
    if (u === `${GH_REL}/download/v0.9.17/prometheus-mac.json`) return new Response(null, { status: 302, headers: { location: ASSET } })
    if (u === ASSET) return new Response(manifestOf(), { status: 200 })
    return new Response('Not Found', { status: 404 })
  })
  assert((await releaseDownloadSize({ fetch: gh.fetch, env: GITHUB })) === SIZE, "manifest: read through GitHub's own chain (latest, the tagged folder, the asset host)", JSON.stringify(gh.seen.map((q) => q.url)))

  // Every way it cannot be read is null, so the screen keeps the constant.
  const refused: Array<[string, InstallEnv, Answer]> = [
    ['a 404', STUB, stubRelease(() => new Response('Not Found', { status: 404 }))],
    ['a manifest over the installer\'s 16 KB cap', STUB, stubRelease(() => new Response(' '.repeat(MAX_MANIFEST_BYTES) + manifestOf(), { status: 200 }))],
    ['a manifest that is not JSON', STUB, stubRelease(() => new Response('<html>', { status: 200 }))],
    ['a manifest with no usable size', STUB, stubRelease(() => new Response(manifestOf(-1), { status: 200 }))],
    ['a manifest over the zip ceiling', STUB, stubRelease(() => new Response(manifestOf(10 * 1024 ** 3), { status: 200 }))],
    ['a redirect off the release\'s origin', STUB, (u) => new Response(null, { status: 302, headers: { location: u.replace('127.0.0.1:9', '127.0.0.1:10') } })],
    ['a GitHub redirect to a host the installer does not follow', GITHUB, () => new Response(null, { status: 302, headers: { location: 'https://example.com/prometheus-mac.json' } })],
    ['a network error', STUB, () => Promise.reject(new Error('ECONNREFUSED'))]
  ]
  for (const [what, env, answer] of refused) {
    const r = await timed(releaseDownloadSize({ fetch: fakeFetch(answer).fetch, env }))
    assert(r.value === null, `refused: ${what} gives no size`, String(r.value))
  }

  // Slow: a server that never answers, and one that answers the headers and then stalls the body.
  const TIMEOUT = 150
  const silent = await timed(releaseDownloadSize({ fetch: fakeFetch(never).fetch, env: STUB }, TIMEOUT))
  assert(silent.value === null && silent.ms < TIMEOUT + 500, `slow: a release that never answers gives no size within the timeout (${silent.ms} ms)`)
  const stall = fakeFetch(stubRelease(() => new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) }), { status: 200 })))
  const stalled = await timed(releaseDownloadSize({ fetch: stall.fetch, env: STUB }, TIMEOUT))
  assert(stalled.value === null && stalled.ms < TIMEOUT + 500, `slow: a manifest whose body stalls gives no size within the timeout (${stalled.ms} ms)`)
  assert(DOWNLOAD_SIZE_TIMEOUT_MS > 0 && DOWNLOAD_SIZE_TIMEOUT_MS <= 5_000, 'slow: main gives up on the manifest within a few seconds', String(DOWNLOAD_SIZE_TIMEOUT_MS))

  // ── 2. the screen ───────────────────────────────────────────────────────────────────────────────────────────────────
  assert(downloadEstimateMB(SIZE) === 64 && downloadEstimateMB(null) === DOWNLOAD_ESTIMATE_MB, 'estimate: decimal MB of the manifest\'s size, the constant without one')
  const noop = (): void => undefined
  const said = renderToStaticMarkup(createElement(ConfirmSetupView, { downloadBytes: SIZE, onConfirm: noop, onBack: noop }))
  assert(said.includes('about 64 MB'), 'screen: the manifest says 64,400,000 bytes, the confirmation says about 64 MB', said)
  const fallback = renderToStaticMarkup(createElement(ConfirmSetupView, { downloadBytes: null, onConfirm: noop, onBack: noop }))
  assert(fallback.includes(`about ${DOWNLOAD_ESTIMATE_MB} MB`), `screen: with no manifest, the confirmation says the constant (about ${DOWNLOAD_ESTIMATE_MB} MB)`, fallback)

  // ── 3. the wiring ───────────────────────────────────────────────────────────────────────────────────────────────────
  const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  const screen = strip(readFileSync('src/renderer/src/components/onboarding/ConfirmSetup.tsx', 'utf8'))
  assert(
    /useState<number \| null>\(null\)/.test(screen) && /window\.beacon\.pathA\.downloadSize\(\)/.test(screen) && /useEffect\(/.test(screen) && /<ConfirmSetupView[^>]*downloadBytes=\{/.test(screen),
    'screen: it shows the constant at once and asks for the size in its own step, after it is on screen'
  )
  const ipc = strip(readFileSync('src/main/path-a-ipc.ts', 'utf8'))
  const preload = strip(readFileSync('src/preload/index.ts', 'utf8'))
  assert(/handleFromShell\(IPC\.PATHA_DOWNLOAD_SIZE, async \(\) => installer\.downloadSize\(\)\)/.test(ipc) && /downloadSize: \(\) => ipcRenderer\.invoke\(IPC\.PATHA_DOWNLOAD_SIZE\)/.test(preload), 'wiring: the bridge asks main, and main answers through the shell-page sender check')
  const inst = strip(readFileSync('src/main/prometheus-install.ts', 'utf8'))
  assert(/downloadSize\(\): Promise<number \| null> \{\s*return releaseDownloadSize\(this\.deps\)/.test(inst) && (inst.match(/readReleaseManifest\(/g) ?? []).length >= 3, 'wiring: main reads it with the installer\'s own fetch and release, through the same manifest reading the install uses')
  const check = strip(readFileSync('src/main/mac-check.ts', 'utf8')) + strip(readFileSync('src/shared/mac-check.ts', 'utf8'))
  assert(!/fetch\(|releaseDownloadSize|downloadSize/.test(check.replace(/fetchSmall\(/g, '')), 'wiring: the check of this Mac does not read the release (its own step does)')

  console.log(failures === 0 ? `[download-estimate-smoke] OK — ${checks} checks passed` : `[download-estimate-smoke] FAIL — ${failures}/${checks} checks failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[download-estimate-smoke] crashed:', err)
  process.exit(1)
})
