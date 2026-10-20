// Setting Prometheus up on this Mac (path A, A-inst): the main-process half. One run at a time:
//
//   1. an app already in ~/Applications that passes every check is used as it is; otherwise
//   2. the manifest, then the zip from THE SAME RELEASE (the folder the manifest resolved to), into Beacon's own temporary
//      folder, its size and sha256 checked against the manifest (corruption, not trust);
//   3. its table of contents read first: an entry that could land outside the folder it is unpacked into (an absolute path, a
//      "..", anything outside Prometheus.app, a link out of it) refuses the zip before anything is extracted (src/main/zip-check.ts);
//      then unpacked with ditto, and the app verified BEFORE it is moved: codesign --verify --deep --strict against a requirement
//      pinning Apple's anchor, Developer ID, the team list and the bundle id; Gatekeeper's verdict, which must be "Notarized
//      Developer ID"; and, on macOS 14 and later, syspolicy_check distribution;
//   4. moved to ~/Applications/Prometheus.app and verified again where it landed;
//   5. its launcher run once with --register (nothing is run before every check has passed);
//   6. 127.0.0.1 watched until Prometheus answers: setup mode (a new install) or configured (one set up before);
//   7. asked who it is (GET /api/hello: a hello, with a version and a fingerprint, and in setup mode the agent "Prometheus"),
//      and only then connected with the one-time secret: the file the daemon wrote, to POST /api/setup/pair; or, for a configured daemon,
//      a fresh one from `--pair`, to POST /api/pair/local. The secret is read, sent to 127.0.0.1 and nothing else: never
//      logged, copied or deleted (the daemon deletes it).
//
// `stapler validate`, which the contract also lists, is NOT run: /usr/bin/stapler on macOS is the developer-tools shim
// (com.apple.dt.xcode_select.xtool-shim), which on a Mac without the command line tools opens Apple's "install the developer
// tools" dialog instead of answering. Gatekeeper's assessment (spctl) and syspolicy_check both judge the notarization ticket.
//
// Everything that touches the world arrives as `deps`, so smoke:prometheus-install runs all of it against fakes, and the
// real-app probe (scripts/onboarding-install-probe.mjs) runs it against the real Prometheus.app.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsc, createWriteStream, type WriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { helloFrom } from '@shared/discovery'
import type { CredentialKind } from '@shared/model-setup'
import { gatewayFromEndpoint, type GatewayConfig } from './connection/config'
import type { RequestFn } from './pairing/http'
import { checkZipEntries } from './zip-check'
import {
  APPROVAL_WATCH_MS,
  IDLE_VIEW,
  LAUNCHER_IN_APP,
  LOCAL_DEVICE_NAME,
  MANIFEST_ASSET,
  MAX_MANIFEST_BYTES,
  PAIR_SECRET_IN_HOME,
  PROMETHEUS_APP,
  PROMETHEUS_BUNDLE_ID,
  PROMETHEUS_TEAM_IDS,
  PAIR_FP_FILE,
  daemonStateFrom,
  fingerprintMismatch,
  macosOlder,
  releaseFolder,
  helloRefusal,
  isPairSecret,
  parseManifest,
  parsePairWritten,
  parseRegister,
  parseSecretPair,
  parseSignatureInfo,
  redirectAllowed,
  signingRequirement,
  spctlNotarized,
  syspolicyPassed,
  type InstallEnv,
  type InstallFailureKind,
  type InstallStep,
  type InstallView,
  type Manifest
} from '@shared/prometheus-app'

export interface ExecResult {
  /** null when the process was killed (a timeout) or could not be started. */
  exit: number | null
  stdout: string
  stderr: string
}
export type ExecFn = (file: string, args: readonly string[], opts: { timeoutMs: number; env?: NodeJS.ProcessEnv }) => Promise<ExecResult>

export interface SavedLocal {
  gateway: GatewayConfig
  token: string
  /** What the token is (@shared/model-setup CREDENTIAL_KIND_KEY): a setup-mode daemon's pairing gives the master token, which O9's
   *  owner trade replaces; a configured daemon's gives an owner credential. */
  credential: CredentialKind
}

export interface InstallDeps {
  env: InstallEnv
  /** The port Prometheus answers on here (8005; a probe's own). */
  port: number
  /** The person's home folder (os.homedir); env.home replaces it in a dev or probe build. */
  home: string
  /** Where the temporary folder is made (os.tmpdir). */
  tmp: string
  /** macOS's major version, or null when unknown (syspolicy_check exists from 14). */
  macosMajor: number | null
  /** macOS's version as the system says it ("15.3.1"), or null when unknown: held to the manifest's min_macos. */
  macosVersion?: string | null
  fetch: typeof fetch
  exec: ExecFn
  /** Small requests to the daemon on 127.0.0.1 (no redirect, a size cap, no Origin). */
  request: RequestFn
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Keep the connection. Throws when it cannot. */
  save: (c: SavedLocal) => void
  /** Bring the kept connection up. */
  activate: () => void
  publish: (view: InstallView) => void
}

const CODESIGN = '/usr/bin/codesign'
const SPCTL = '/usr/sbin/spctl'
const SYSPOLICY = '/usr/bin/syspolicy_check'
const DITTO = '/usr/bin/ditto'
const TOOL_MS = 180_000
const LAUNCHER_MS = 60_000
const IDLE_MS = 30_000
const MAX_HOPS = 5
const POLL_MS = 500
const SECRET_WAIT_MS = 5_000
const DETAILS_MAX = 3_000

class Stop extends Error {
  constructor(
    readonly kind: InstallFailureKind,
    readonly details: string
  ) {
    super(details)
  }
}
class Canceled extends Error {}

const tail = (s: string, n = 600): string => (s.length > n ? '…' + s.slice(-n) : s).trim()

export class PrometheusInstaller {
  private view: InstallView = IDLE_VIEW
  private running: Promise<void> | null = null
  /** A run is under way. Cleared in the same step that publishes the run's last state, so a "Try again" that answers a card can
   *  never find the run that showed it still "under way" (the promise above settles a tick later). */
  private active = false
  private abort: AbortController | null = null
  private lastPublish = 0

  constructor(private readonly deps: InstallDeps) {}

  current(): InstallView {
    return this.view
  }

  get appPath(): string {
    return join(this.deps.env.home ?? this.deps.home, 'Applications', PROMETHEUS_APP)
  }

  /** Where the one-time secret is written (O9's owner trade uses the same). */
  get secretPath(): string {
    return join(this.deps.env.home ?? this.deps.home, PAIR_SECRET_IN_HOME)
  }

  get launcher(): string {
    return this.deps.env.launcher ?? join(this.appPath, LAUNCHER_IN_APP)
  }

  /** Start a run, or return the one under way (a screen that mounts twice must not start two). A finished run is not repeated. "Under
   *  way" is the run itself, not the phase: while it watches for the Login Items switch the phase reads 'failed' and it is still going. */
  start(): InstallView {
    if (this.active || this.view.phase === 'done') return this.view
    this.abort = new AbortController()
    this.active = true
    this.set({ ...IDLE_VIEW, phase: 'running' })
    const signal = this.abort.signal
    this.running = this.run(signal).finally(() => {
      this.running = null
    })
    return this.view
  }

  /** Going Back. Before the app is in Applications this stops everything and deletes what was downloaded; after, Prometheus
   *  stays installed and Beacon only stops waiting for it. Resolves once the run has stopped. */
  async cancel(): Promise<InstallView> {
    this.abort?.abort()
    await this.running?.catch(() => undefined)
    if (this.view.phase !== 'done') this.set(IDLE_VIEW)
    return this.view
  }

  private set(v: InstallView): void {
    this.view = v
    this.lastPublish = this.deps.now()
    this.deps.publish(v)
  }

  private patch(p: Partial<InstallView>, throttle = false): void {
    const v = { ...this.view, ...p }
    if (throttle && this.deps.now() - this.lastPublish < 100) {
      this.view = v
      return
    }
    this.set(v)
  }

  private step(step: InstallStep): void {
    this.patch({ step })
  }

  private async run(signal: AbortSignal): Promise<void> {
    let work: string | null = null
    // The run's last state, published only once what it downloaded is deleted: a card on the screen means nothing is left behind.
    let last: Partial<InstallView>
    try {
      if (!(await this.existingAppPasses(signal))) {
        work = await mkdtemp(join(this.deps.tmp, 'beacon-prometheus-'))
        const zip = await this.download(work, signal)
        this.step('check')
        const unpacked = await this.unpack(zip, work, signal)
        await this.verifyOrStop(unpacked, signal)
        this.step('place')
        await this.place(unpacked, signal)
      }
      this.patch({ placed: true })
      // The download is no longer needed: delete it before the wait, which may be long.
      if (work) await rm(work, { recursive: true, force: true }).catch(() => undefined)
      work = null
      this.step('start')
      const daemon = await this.startAndWait(signal)
      this.step('connect')
      await this.connect(daemon, signal)
      last = { phase: 'done', daemon }
    } catch (err) {
      if (err instanceof Canceled || signal.aborted) last = { phase: 'idle' }
      else if (err instanceof Stop) last = { phase: 'failed', failure: { kind: err.kind, details: this.details(err) } }
      else last = { phase: 'failed', failure: { kind: this.view.placed ? 'not-started' : 'download', details: this.details(new Stop('download', String((err as Error)?.message ?? err))) } }
    }
    if (work) await rm(work, { recursive: true, force: true }).catch(() => undefined)
    this.active = false
    // A canceled run is quiet: cancel() publishes for it.
    if (last.phase === 'idle') this.view = { ...this.view, ...last }
    else this.patch(last)
  }

  private details(e: Stop): string {
    const text = [`Prometheus on this Mac: ${e.kind} (step: ${this.view.step})`, e.details, `macOS ${this.deps.macosMajor ?? 'unknown'}, app at ${this.appPath}`].join('\n')
    return text.length > DETAILS_MAX ? text.slice(0, DETAILS_MAX) + '…' : text
  }

  private check(signal: AbortSignal): void {
    if (signal.aborted) throw new Canceled()
  }

  // ── 1. an app already there ────────────────────────────────────────────────────────────────────────────────────────────────

  private async existingAppPasses(signal: AbortSignal): Promise<boolean> {
    const st = await lstat(this.appPath).catch(() => null)
    if (!st) return false
    this.step('check')
    const verdict = await this.verify(this.appPath, signal)
    if (verdict === null) return true
    // Not one Beacon can trust, and not Beacon's to remove: it stays where it is, and nothing is put over it.
    throw new Stop('place', `Applications already holds a Prometheus.app that did not pass the checks, so Beacon leaves it alone.\n${verdict}`)
  }

  // ── 2. the manifest and the zip ────────────────────────────────────────────────────────────────────────────────────────────

  /** GET with redirects followed by hand, each hop held to redirectAllowed. */
  private async get(url: string, signal: AbortSignal): Promise<{ res: Response; url: string; chain: string[] }> {
    let at = url
    const chain: string[] = []
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      let res: Response
      try {
        chain.push(at)
        res = await this.deps.fetch(at, { redirect: 'manual', signal, headers: { accept: '*/*' } })
      } catch (err) {
        this.check(signal)
        throw new Stop('download', `GET ${at}: ${(err as Error).message}`)
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        await res.body?.cancel().catch(() => undefined)
        const next = loc ? new URL(loc, at).toString() : ''
        if (!next || !redirectAllowed(next, this.deps.env.overridden ? this.deps.env.releaseBase : null)) throw new Stop('download', `GET ${at}: a redirect Beacon does not follow (${loc ?? 'no location'})`)
        at = next
        continue
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined)
        throw new Stop('download', `GET ${at}: HTTP ${res.status}`)
      }
      return { res, url: at, chain }
    }
    throw new Stop('download', `GET ${url}: more than ${MAX_HOPS} redirects`)
  }

  private async manifest(signal: AbortSignal): Promise<{ manifest: Manifest; folder: string }> {
    const { res, url, chain } = await this.get(`${this.deps.env.releaseBase}/${MANIFEST_ASSET}`, signal)
    const text = await readCapped(res, MAX_MANIFEST_BYTES)
    if (text === null) throw new Stop('download', `the release manifest is larger than ${MAX_MANIFEST_BYTES} bytes`)
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      /* not JSON */
    }
    const manifest = parseManifest(json)
    if (!manifest) throw new Stop('download', `the release manifest is not one Beacon can read (${url})`)
    // The zip is asked for in the release's own folder on github.com (the last hop there), and reached by its own redirect.
    const folder = releaseFolder(chain, this.deps.env.overridden ? this.deps.env.releaseBase : null)
    if (!folder) throw new Stop('download', `the release manifest did not come from the release's own folder (${chain.join(' -> ')})`)
    return { manifest, folder }
  }

  private async download(work: string, signal: AbortSignal): Promise<string> {
    this.step('get')
    const { manifest, folder } = await this.manifest(signal)
    const have = this.deps.macosVersion ?? null
    if (manifest.minMacos && have && macosOlder(have, manifest.minMacos)) {
      throw new Stop('old-macos', `Prometheus ${manifest.version} needs macOS ${manifest.minMacos} or later; this Mac has macOS ${have}`)
    }
    this.patch({ total: manifest.size, received: 0 })
    const { res, url } = await this.get(new URL(manifest.asset, folder).toString(), signal)
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > 0 && declared !== manifest.size) {
      await res.body?.cancel().catch(() => undefined)
      throw new Stop('unsafe', `the download is ${declared} bytes; the manifest says ${manifest.size}`)
    }
    const file = join(work, manifest.asset)
    const out = createWriteStream(file, { flags: 'wx', mode: 0o600 })
    const hash = createHash('sha256')
    let received = 0
    let idle: ReturnType<typeof setTimeout> | null = null
    const reader = res.body?.getReader()
    if (!reader) throw new Stop('download', `GET ${url}: no body`)
    try {
      for (;;) {
        const chunk = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
          idle = setTimeout(() => reject(new Stop('download', `GET ${url}: nothing arrived for ${IDLE_MS / 1000} s`)), IDLE_MS)
          reader.read().then(resolve, reject)
        }).finally(() => idle && clearTimeout(idle))
        if (chunk.done) break
        received += chunk.value.byteLength
        if (received > manifest.size) throw new Stop('unsafe', `the download is longer than the manifest's ${manifest.size} bytes`)
        hash.update(chunk.value)
        await write(out, chunk.value)
        this.patch({ received }, true)
      }
    } catch (err) {
      await reader.cancel().catch(() => undefined)
      out.destroy()
      this.check(signal)
      if (err instanceof Stop) throw err
      throw new Stop('download', `GET ${url}: ${(err as Error).message}`)
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())))
    this.patch({ received })
    if (received !== manifest.size) throw new Stop('download', `the download stopped at ${received} of ${manifest.size} bytes`)
    const digest = hash.digest('hex')
    if (digest !== manifest.sha256) throw new Stop('unsafe', `sha256 of the download is ${digest}; the manifest says ${manifest.sha256}`)
    return file
  }

  // ── 3. unpack and verify ───────────────────────────────────────────────────────────────────────────────────────────────────

  private async unpack(zip: string, work: string, signal: AbortSignal): Promise<string> {
    // Nothing is extracted from a zip whose entries could land outside the folder: ditto is not trusted to refuse them.
    const toc = await checkZipEntries(zip, PROMETHEUS_APP)
    this.check(signal)
    if (!toc.ok) throw new Stop('unsafe', `the download is not one Beacon unpacks: ${toc.why}`)
    const dir = join(work, 'unpacked')
    await mkdir(dir, { mode: 0o700 })
    const r = await this.deps.exec(DITTO, ['-x', '-k', zip, dir], { timeoutMs: TOOL_MS })
    this.check(signal)
    if (r.exit !== 0) throw new Stop('unsafe', `ditto could not unpack the download (exit ${r.exit}): ${tail(r.stderr)}`)
    const entries = (await readdir(dir)).filter((n) => n !== '.DS_Store')
    if (entries.length !== 1 || entries[0] !== PROMETHEUS_APP) throw new Stop('unsafe', `the download holds ${JSON.stringify(entries.slice(0, 5))}, not one ${PROMETHEUS_APP}`)
    return join(dir, PROMETHEUS_APP)
  }

  /** null when `app` passes every check; otherwise what failed, for the details. */
  async verify(app: string, signal: AbortSignal): Promise<string | null> {
    const st = await lstat(app).catch(() => null)
    if (!st || !st.isDirectory() || st.isSymbolicLink()) return `${app} is not a folder`
    const strict = await this.deps.exec(CODESIGN, ['--verify', '--deep', '--strict', `-R=${signingRequirement(PROMETHEUS_TEAM_IDS, PROMETHEUS_BUNDLE_ID)}`, app], { timeoutMs: TOOL_MS })
    this.check(signal)
    if (strict.exit !== 0) {
      const why = strict.exit === 3 ? `not signed by OAra Labs (team ${PROMETHEUS_TEAM_IDS.join(' or ')}) as ${PROMETHEUS_BUNDLE_ID}: the signature does not satisfy the requirement` : 'the signature is broken'
      return `codesign --verify --deep --strict: ${why} (exit ${strict.exit}): ${tail(strict.stderr)}`
    }
    const shown = await this.deps.exec(CODESIGN, ['-d', '--verbose=2', app], { timeoutMs: TOOL_MS })
    this.check(signal)
    const info = parseSignatureInfo(shown.stderr + shown.stdout)
    if (info.identifier !== PROMETHEUS_BUNDLE_ID || !info.teamId || !PROMETHEUS_TEAM_IDS.includes(info.teamId)) return `codesign -d: identifier ${info.identifier}, team ${info.teamId}`
    const gk = await this.deps.exec(SPCTL, ['-a', '-t', 'exec', '-vv', app], { timeoutMs: TOOL_MS })
    this.check(signal)
    const gkText = gk.stderr + gk.stdout
    if (!spctlNotarized(gk.exit, gkText)) return `spctl -a -t exec: not accepted as notarized (exit ${gk.exit}): ${tail(gkText)}`
    if (this.deps.macosMajor === null || this.deps.macosMajor >= 14) {
      const sp = await this.deps.exec(SYSPOLICY, ['distribution', app], { timeoutMs: TOOL_MS })
      this.check(signal)
      if (!syspolicyPassed(sp.exit, sp.stdout + sp.stderr)) return `syspolicy_check distribution (exit ${sp.exit}): ${tail(sp.stdout + sp.stderr)}`
    }
    return null
  }

  private async verifyOrStop(app: string, signal: AbortSignal): Promise<void> {
    const v = await this.verify(app, signal)
    if (v !== null) throw new Stop('unsafe', v)
  }

  // ── 4. into Applications ───────────────────────────────────────────────────────────────────────────────────────────────────

  private async place(unpacked: string, signal: AbortSignal): Promise<void> {
    const apps = join(this.deps.env.home ?? this.deps.home, 'Applications')
    try {
      await mkdir(apps, { recursive: true, mode: 0o755 })
      if (await lstat(this.appPath).catch(() => null)) throw new Stop('place', `${this.appPath} appeared while Beacon was checking the download; it is left alone`)
      try {
        await rename(unpacked, this.appPath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
        // Another volume: copy it across with ditto (which keeps the signature's extended attributes), then check the copy.
        const r = await this.deps.exec(DITTO, [unpacked, this.appPath], { timeoutMs: TOOL_MS })
        if (r.exit !== 0) throw new Error(`ditto: ${tail(r.stderr)}`)
      }
    } catch (err) {
      if (err instanceof Stop) throw err
      throw new Stop('place', `could not put ${PROMETHEUS_APP} in ${apps}: ${(err as Error).message}`)
    }
    this.check(signal)
    const again = await this.verify(this.appPath, signal)
    if (again !== null) {
      // What Beacon just put there and cannot vouch for is removed; nothing has been run.
      await rm(this.appPath, { recursive: true, force: true }).catch(() => undefined)
      throw new Stop('unsafe', `after the move: ${again}`)
    }
  }

  // ── 5 and 6. start it, and wait ────────────────────────────────────────────────────────────────────────────────────────────

  launcherEnv(): NodeJS.ProcessEnv {
    return { ...process.env, HOME: this.deps.env.home ?? this.deps.home }
  }

  private async startAndWait(signal: AbortSignal): Promise<'setup' | 'configured'> {
    const r = await this.deps.exec(this.launcher, ['--register'], { timeoutMs: LAUNCHER_MS, env: this.launcherEnv() })
    this.check(signal)
    const outcome = parseRegister(r.exit, r.stdout)
    const said = `${this.launcher} --register: exit ${r.exit}, state ${outcome.state}${outcome.detail ? `: ${outcome.detail}` : ''}${r.stderr ? `\n${tail(r.stderr)}` : ''}`
    if (outcome.kind === 'port-busy' || outcome.kind === 'already-running') throw new Stop('in-the-way', said)
    if (outcome.kind === 'failed' || outcome.kind === 'unsupported-os') throw new Stop('not-started', said)
    if (outcome.kind === 'requires-approval') {
      // The card says what to do; Beacon keeps watching, so it carries on by itself once the switch is turned on.
      this.patch({ phase: 'failed', failure: { kind: 'approval', details: this.details(new Stop('approval', said)) } })
      const daemon = await this.waitForDaemon(APPROVAL_WATCH_MS, signal)
      if (!daemon) throw new Stop('approval', said)
      this.patch({ phase: 'running', failure: undefined })
      return daemon
    }
    const daemon = await this.waitForDaemon(this.deps.env.startTimeoutMs, signal)
    if (!daemon) throw new Stop('not-started', `${said}\nnothing answered on 127.0.0.1:${this.deps.port} within ${Math.round(this.deps.env.startTimeoutMs / 1000)} s`)
    return daemon
  }

  private async waitForDaemon(ms: number, signal: AbortSignal): Promise<'setup' | 'configured' | null> {
    const end = this.deps.now() + ms
    const base = `http://127.0.0.1:${this.deps.port}`
    for (;;) {
      this.check(signal)
      const a = await this.deps.request({ method: 'GET', url: `${base}/api/setup/status`, timeoutMs: 1_500 })
      const setup = typeof a === 'object' ? { status: a.status, json: a.json } : null
      let state = daemonStateFrom(setup, null)
      if (!state && setup && setup.status !== 200) {
        const b = await this.deps.request({ method: 'GET', url: `${base}/api/status`, timeoutMs: 1_500 })
        state = daemonStateFrom(null, typeof b === 'object' ? { status: b.status, json: b.json } : null)
      }
      if (state) return state
      if (this.deps.now() >= end) return null
      await this.deps.sleep(POLL_MS)
    }
  }

  // ── 7. connect ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

  private async connect(daemon: 'setup' | 'configured', signal: AbortSignal): Promise<void> {
    const paired = await pairThisMac(
      { port: this.deps.port, request: this.deps.request, exec: this.deps.exec, launcher: this.launcher, launcherEnv: this.launcherEnv(), secretPath: this.secretPath, now: this.deps.now, sleep: this.deps.sleep, checkpoint: () => this.check(signal) },
      daemon
    )
    if (!paired.ok) throw new Stop('refused', paired.details)
    try {
      this.deps.save({ gateway: paired.gateway, token: paired.token, credential: daemon === 'setup' ? 'master' : 'owner' })
    } catch (err) {
      throw new Stop('refused', `the connection could not be kept: ${(err as Error).message}`)
    }
    this.deps.activate()
  }
}

export interface PairThisMacDeps {
  /** Where Prometheus answers on this Mac (127.0.0.1). */
  port: number
  request: RequestFn
  exec: ExecFn
  /** The app's launcher, for `--pair` (a configured daemon has no secret waiting). */
  launcher: string
  launcherEnv: NodeJS.ProcessEnv
  /** Where the secret is written (and Prometheus writes pair.fp beside it). */
  secretPath: string
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Called between steps; throws to stop (the installer's Cancel). */
  checkpoint?: () => void
}
export type PairThisMacResult = { ok: true; gateway: GatewayConfig; token: string } | { ok: false; details: string }

/** The pairing that ends both ways Beacon sets Prometheus up on this Mac (A-inst, and O9's owner trade): who answered, then a
 *  one-time secret for a credential. Nothing is written or sent before hello says this is the Prometheus that wrote the files:
 *  hello first (a setup-mode daemon must say "Prometheus"), then pair.fp beside the secret compared with hello's fp as plain
 *  strings (a missing one is ""), then, for a configured daemon, `--pair` writes a fresh secret, which is read under the
 *  daemon's own rules and sent to 127.0.0.1 only. Answers the credential and where to connect; keeping it is the caller's. */
export async function pairThisMac(d: PairThisMacDeps, daemon: 'setup' | 'configured'): Promise<PairThisMacResult> {
  const step = (): void => d.checkpoint?.()
  const hi = await d.request({ method: 'GET', url: `http://127.0.0.1:${d.port}/api/hello`, timeoutMs: 5_000 })
  step()
  if (typeof hi !== 'object' || hi.status !== 200) return { ok: false, details: `GET /api/hello: ${typeof hi === 'object' ? `HTTP ${hi.status}` : hi}: what answered cannot say it is Prometheus, so the secret was not sent` }
  const refusal = helloRefusal(helloFrom(hi.json), daemon)
  if (refusal) return { ok: false, details: `GET /api/hello: ${refusal}, so the secret was not sent` }
  const fpFile = await readPrivateFile(join(dirname(d.secretPath), PAIR_FP_FILE))
  step()
  if (typeof fpFile !== 'string' && !fpFile.missing) return { ok: false, details: `${PAIR_FP_FILE} cannot be trusted (${fpFile.why}), so the secret was not sent` }
  const mismatch = fingerprintMismatch((hi.json as { fp?: unknown } | null)?.fp, typeof fpFile === 'string' ? fpFile : '')
  if (mismatch) return { ok: false, details: `${mismatch}: what answered is not the daemon that wrote ${PAIR_FP_FILE}, so the secret was not sent` }
  let route = '/api/setup/pair'
  const body: Record<string, string> = {}
  if (daemon === 'configured') {
    const r = await d.exec(d.launcher, ['--pair'], { timeoutMs: LAUNCHER_MS, env: d.launcherEnv })
    step()
    if (parsePairWritten(r.exit, r.stdout, d.secretPath) === null) return { ok: false, details: `${d.launcher} --pair: exit ${r.exit}: ${tail(r.stdout + r.stderr)}` }
    route = '/api/pair/local'
    body.name = LOCAL_DEVICE_NAME
  }
  // The secret may appear a moment after setup mode answers, so it is waited for.
  const end = d.now() + SECRET_WAIT_MS
  let secret: string | null = null
  let why = 'it is not there'
  for (;;) {
    step()
    const got = await readPrivateFile(d.secretPath)
    if (typeof got === 'string' && isPairSecret(got)) {
      secret = got
      break
    }
    why = typeof got === 'string' ? 'it is not a secret' : got.why
    if (d.now() >= end) return { ok: false, details: `the one-time secret at ${d.secretPath} cannot be used: ${why}` }
    await d.sleep(200)
  }
  const res = await d.request({ method: 'POST', url: `http://127.0.0.1:${d.port}${route}`, body: JSON.stringify({ code: secret, ...body }), timeoutMs: 15_000 })
  step()
  if (typeof res !== 'object') return { ok: false, details: `POST ${route}: ${res}` }
  const pair = parseSecretPair(res.status, res.json)
  if (pair.kind !== 'paired') return { ok: false, details: `POST ${route}: ${pair.detail}` }
  const gateway = gatewayFromEndpoint('127.0.0.1', { apiPort: d.port, wsPort: pair.wsPort ?? 8010 }, 'this-mac')
  if (!gateway) return { ok: false, details: `POST ${route}: the ports it named are not usable` }
  return { ok: true, gateway, token: pair.token }
}

/** The real ExecFn: the program itself (an absolute path, no shell), a timeout, at most 1 MiB of output. */
export const execFileTool: ExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: opts.timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8', ...(opts.env ? { env: opts.env } : {}) }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: string | null }) | null
      const exit = !e ? 0 : typeof e.code === 'number' && !e.killed && !e.signal ? e.code : null
      resolve({ exit, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') + (e && exit === null ? `\n${e.message}` : '') })
    })
  })

/** A small file that only this user can read, through no link; its trimmed text, or why not. */
export async function readPrivateFile(path: string): Promise<string | { why: string; missing: boolean }> {
  const uid = process.getuid?.() ?? -1
  const dir = await lstat(join(path, '..')).catch(() => null)
  if (!dir) return { why: 'it is not there', missing: true }
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== uid || (dir.mode & 0o077) !== 0) return { why: 'its folder is open to others, or not this user\'s', missing: false }
  let fh
  try {
    // O_NOFOLLOW: a link in place of the file is refused, not followed.
    fh = await open(path, fsc.O_RDONLY | fsc.O_NOFOLLOW)
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
    return { why: missing ? 'it is not there' : `it cannot be opened (${(err as NodeJS.ErrnoException).code})`, missing }
  }
  try {
    const st = await fh.stat()
    if (!st.isFile() || st.uid !== uid || (st.mode & 0o077) !== 0) return { why: 'it is open to others, or not this user\'s', missing: false }
    if (st.size > 512) return { why: 'it is too large', missing: false }
    return (await readFile(fh, 'utf8')).trim()
  } finally {
    await fh.close()
  }
}

async function readCapped(res: Response, max: number): Promise<string | null> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    parts.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(parts))
}

function write(out: WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    out.write(chunk, (e) => (e ? reject(e) : resolve()))
  })
}
