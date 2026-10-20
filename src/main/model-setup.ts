// How the assistant thinks (O9, docs/ONBOARDING-v0.4.0-O9.md §5): check the key, configure, complete, and trade the setup-mode
// master token for an owner credential. The key and the master token stay in this process: neither is in any view the page is
// sent, nor in any saved setting. There is no way to F1 that keeps the master token.
import { pairThisMac, type ExecFn, type SavedLocal } from './prometheus-install'
import type { RequestFn } from './pairing/http'
import { CHECK_KEY_ROUTE, COMPLETE_ROUTE, CONFIGURE_ROUTE, configureBody, readKeyCheck, type CloudChoice, type KeyCheck, type ModelSetupView } from '@shared/model-setup'
import { daemonStateFrom } from '@shared/prometheus-app'

export type { ModelSetupView }

export interface ModelSetupDeps {
  port: number
  /** The setup-mode master token Beacon holds after A-inst. */
  masterToken: () => string | null
  request: RequestFn
  exec: ExecFn
  /** The app's launcher (or a probe's stand-in). */
  launcher: string
  launcherEnv?: NodeJS.ProcessEnv
  /** Where `--pair` writes the secret (and Prometheus writes pair.fp beside it). */
  secretPath: string
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Keeps the credential and what it is (@shared/model-setup CREDENTIAL_KIND_KEY). */
  save: (c: SavedLocal) => void
  activate: () => void
  publish: (view: ModelSetupView) => void
}

/** The OpenRouter check is two calls of up to 10 s each on Prometheus's side. */
const CHECK_TIMEOUT_MS = 35_000
/** How long the configured daemon has to come up after complete (as A-inst waits). */
const START_WAIT_MS = 60_000
const POLL_MS = 500

export class ModelSetup {
  private running: Promise<ModelSetupView> | null = null
  private view: ModelSetupView = { phase: 'idle', step: 'check' }
  /** The choice and key the last check accepted: finish does not ask again (OpenRouter's check spends one token). */
  private accepted: { choice: CloudChoice; key: string } | null = null

  constructor(private readonly deps: ModelSetupDeps) {}

  current(): ModelSetupView {
    return this.view
  }

  /** Ask Prometheus whether this key works (A3c-or after the sign-in, A3c-2's Check key). An accepted one is remembered for finish. */
  async check(choice: CloudChoice, key: string): Promise<{ result: KeyCheck; detail: string }> {
    const master = this.deps.masterToken()
    if (!master) return { result: 'unreachable', detail: 'Beacon holds no setup credential for this Prometheus' }
    const checked = await this.deps.request({ method: 'POST', url: `http://127.0.0.1:${this.deps.port}${CHECK_KEY_ROUTE}`, headers: { authorization: `Bearer ${master}` }, body: JSON.stringify({ provider: choice, api_key: key }), timeoutMs: CHECK_TIMEOUT_MS })
    const verdict = typeof checked === 'object' ? readKeyCheck(checked.status, checked.json) : { result: 'unreachable' as const, detail: `key check: Prometheus did not answer (${checked})` }
    this.accepted = verdict.result === 'ok' ? { choice, key } : null
    return verdict
  }

  /** Check the key (unless check just accepted it), configure, complete, and end with the owner credential. A daemon that is
   *  configured already (Try again after the trade failed) has only the trade left: configure and complete are not sent again. One
   *  at a time: a second call waits on the first. */
  finish(choice: CloudChoice, key: string): Promise<ModelSetupView> {
    this.running ??= this.run(choice, key).finally(() => (this.running = null))
    return this.running
  }

  /** A relaunch part-way through (@shared/model-setup resumeAtTrade): no key in hand, so only the trade, and only with a daemon that
   *  is configured. One that is still in setup mode has nothing to trade. */
  resumeTrade(): Promise<ModelSetupView> {
    this.running ??= this.runTrade().finally(() => (this.running = null))
    return this.running
  }

  private show(v: ModelSetupView): ModelSetupView {
    this.view = v
    this.deps.publish(v)
    return v
  }
  private fail(step: ModelSetupView['step'], kind: NonNullable<ModelSetupView['failure']>['kind'], details: string): ModelSetupView {
    return this.show({ phase: 'failed', step, failure: { kind, details: details.slice(0, 2_000) } })
  }

  /** What the daemon on this Mac is now: in setup mode, configured, or not answering as either. */
  private async daemonState(master: string): Promise<'setup' | 'configured' | null> {
    const base = `http://127.0.0.1:${this.deps.port}`
    const a = await this.deps.request({ method: 'GET', url: `${base}/api/setup/status`, timeoutMs: 3_000 })
    const setup = typeof a === 'object' ? { status: a.status, json: a.json } : null
    const state = daemonStateFrom(setup, null)
    if (state || (setup && setup.status === 200)) return state
    const b = await this.deps.request({ method: 'GET', url: `${base}/api/status`, headers: { authorization: `Bearer ${master}` }, timeoutMs: 3_000 })
    return typeof b === 'object' && b.status === 200 ? 'configured' : null
  }

  private async runTrade(): Promise<ModelSetupView> {
    const master = this.deps.masterToken()
    if (!master) return this.fail('owner', 'trade', 'Beacon holds no setup credential for this Prometheus')
    if ((await this.daemonState(master)) === 'setup') return this.fail('start', 'not-started', 'Prometheus on this Mac is still being set up: there is no owner credential to trade for yet')
    return this.trade(master)
  }

  private async run(choice: CloudChoice, key: string): Promise<ModelSetupView> {
    const master = this.deps.masterToken()
    if (!master) return this.fail('check', 'not-started', 'Beacon holds no setup credential for this Prometheus')
    // Configured already (complete ran, the trade did not finish): only the trade is left.
    if ((await this.daemonState(master)) === 'configured') return this.trade(master)
    const base = `http://127.0.0.1:${this.deps.port}`
    const auth = { authorization: `Bearer ${master}` }

    if (!(this.accepted && this.accepted.choice === choice && this.accepted.key === key)) {
      this.show({ phase: 'running', step: 'check' })
      const verdict = await this.check(choice, key)
      if (verdict.result !== 'ok') return this.fail('check', verdict.result, verdict.detail)
    }

    this.show({ phase: 'running', step: 'save' })
    const conf = await this.deps.request({ method: 'POST', url: `${base}${CONFIGURE_ROUTE}`, headers: auth, body: JSON.stringify(configureBody(choice, key)), timeoutMs: 30_000 })
    if (typeof conf !== 'object' || conf.status !== 200 || (conf.json as { configured?: unknown } | null)?.configured !== true) return this.fail('save', 'not-started', `configure: ${typeof conf === 'object' ? `HTTP ${conf.status} ${errorOf(conf.json)}` : conf}`)

    this.show({ phase: 'running', step: 'start' })
    const done = await this.deps.request({ method: 'POST', url: `${base}${COMPLETE_ROUTE}`, headers: auth, body: '{}', timeoutMs: 30_000 })
    if (typeof done !== 'object' || done.status !== 200) return this.fail('start', 'not-started', `complete: ${typeof done === 'object' ? `HTTP ${done.status} ${errorOf(done.json)}` : done}`)
    return this.trade(master)
  }

  /** The configured daemon up, then the owner trade. */
  private async trade(master: string): Promise<ModelSetupView> {
    const base = `http://127.0.0.1:${this.deps.port}`
    const auth = { authorization: `Bearer ${master}` }
    this.show({ phase: 'running', step: 'start' })
    // The same process becomes the configured daemon: it answers /api/status to the master token once it is up.
    const end = this.deps.now() + START_WAIT_MS
    let up = false
    while (!up && this.deps.now() < end) {
      const s = await this.deps.request({ method: 'GET', url: `${base}/api/status`, headers: auth, timeoutMs: 3_000 })
      up = typeof s === 'object' && s.status === 200
      if (!up) await this.deps.sleep(POLL_MS)
    }
    if (!up) return this.fail('start', 'not-started', `Prometheus did not answer as configured within ${START_WAIT_MS / 1000} s`)

    // The owner trade: the same pairing A-inst ends with, now against the configured daemon (`--pair`, then /api/pair/local).
    this.show({ phase: 'running', step: 'owner' })
    const paired = await pairThisMac(
      { port: this.deps.port, request: this.deps.request, exec: this.deps.exec, launcher: this.deps.launcher, launcherEnv: this.deps.launcherEnv ?? process.env, secretPath: this.deps.secretPath, now: this.deps.now, sleep: this.deps.sleep },
      'configured'
    )
    if (!paired.ok) return this.fail('owner', 'trade', paired.details)
    try {
      // The same keychain entry every way of connecting uses: the owner credential REPLACES the master token.
      this.deps.save({ gateway: paired.gateway, token: paired.token, credential: 'owner' })
    } catch (err) {
      return this.fail('owner', 'trade', `the owner credential could not be kept: ${(err as Error).message}`)
    }
    this.deps.activate()
    const owner = await this.deps.request({ method: 'GET', url: `${base}/api/status`, headers: { authorization: `Bearer ${paired.token}` }, timeoutMs: 5_000 })
    if (typeof owner !== 'object' || owner.status !== 200) return this.fail('owner', 'trade', `the owner credential was not accepted: ${typeof owner === 'object' ? `HTTP ${owner.status}` : owner}`)
    return this.show({ phase: 'done', step: 'owner' })
  }
}

function errorOf(json: unknown): string {
  const e = typeof json === 'object' && json !== null ? (json as { error?: unknown }).error : undefined
  return typeof e === 'string' ? e.slice(0, 80) : ''
}
