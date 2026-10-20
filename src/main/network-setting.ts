// "Let other computers on my home network connect" (docs/MULTI-COMPUTER-v0.4.md §2), the main-process half: GET/PUT
// /api/network on the connected Prometheus with the credential Beacon holds for it, and the restart. What each answer means is
// @shared/network-setting's; this file only asks, and waits.
import {
  NETWORK_ROUTE,
  PUT_FAILED,
  RESTART_ROUTE,
  RESTART_WAIT_MS,
  putBody,
  readNetwork,
  readPut,
  readRestart,
  type NetworkRead,
  type RestartOutcome,
  type SetOutcome
} from '@shared/network-setting'
import type { HttpReply, HttpResult, RequestFn } from './pairing/http'

export interface NetworkSettingDeps {
  /** The connected Prometheus's REST base, and the credential Beacon holds for it. */
  base: () => string | null
  token: () => string | null
  request: RequestFn
  now: () => number
  sleep: (ms: number) => Promise<void>
}

/** How often hello is asked while Prometheus restarts, and how long one ask may take. */
const POLL_MS = 250
const HELLO_TIMEOUT_MS = 2_000

/** Why the setting could not be read, by what the request gave instead of an answer. */
const READ_FAILED: Record<Exclude<HttpResult, HttpReply>, string> = {
  unreachable: 'Prometheus did not answer',
  'too-big': 'the answer was too big',
  'wrong-key': 'the computer presented another key than the one Beacon connected to, so Beacon sent it nothing'
}

export class NetworkSetting {
  /** A restart being waited out: a second [Restart now] waits on the same one, and never asks Prometheus twice. */
  private restarting: Promise<RestartOutcome> | null = null
  constructor(private readonly deps: NetworkSettingDeps) {}

  private link(): { base: string; token: string } | null {
    const base = this.deps.base()
    const token = this.deps.token()
    return base && token ? { base, token } : null
  }
  private ask(method: 'GET' | 'PUT' | 'POST', base: string, path: string, token: string | null, body?: unknown): Promise<HttpResult> {
    return this.deps.request({
      method,
      url: `${base}${path}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      timeoutMs: path === '/api/hello' ? HELLO_TIMEOUT_MS : 8_000
    })
  }
  /** hello's fp, or null when nothing answers it as a Prometheus. hello is public: no credential goes with it. */
  private async helloFp(base: string): Promise<string | null> {
    const r = await this.ask('GET', base, '/api/hello', null)
    if (typeof r === 'string' || r.status !== 200) return null
    const fp = typeof r.json === 'object' && r.json !== null ? (r.json as { fp?: unknown }).fp : undefined
    return typeof fp === 'string' ? fp : null
  }

  /** The setting as the connected Prometheus reports it. Not connected, or no credential: no section. */
  async read(): Promise<NetworkRead> {
    const l = this.link()
    if (!l) return { kind: 'hidden' }
    const r = await this.ask('GET', l.base, NETWORK_ROUTE, l.token)
    if (typeof r === 'string') return { kind: 'unreadable', detail: READ_FAILED[r] }
    return readNetwork(r.status, r.json)
  }

  /** The switch: PUT the choice, then read the setting back with GET (PUT's own answer describes the saved state in GET's keys
   *  with another meaning for `mode`, so it is never shown). */
  async set(on: boolean): Promise<SetOutcome> {
    const l = this.link()
    if (!l) return { kind: 'refused', message: PUT_FAILED, detail: 'not connected' }
    const r = await this.ask('PUT', l.base, NETWORK_ROUTE, l.token, putBody(on))
    if (typeof r === 'string') return { kind: 'refused', message: PUT_FAILED, detail: r }
    const put = readPut(r.status, r.json)
    if (put.kind === 'refused') return put
    return this.read()
  }

  /** Ask Prometheus to restart, then wait for it to go away and answer again as the same computer (hello's fp), and read the
   *  setting again. Hello is asked first, for the fp to wait for: an answer before Prometheus went away is the old process. */
  restart(): Promise<RestartOutcome> {
    this.restarting ??= this.restartOnce().finally(() => (this.restarting = null))
    return this.restarting
  }
  private async restartOnce(): Promise<RestartOutcome> {
    const l = this.link()
    if (!l) return { kind: 'failed' }
    const fp = await this.helloFp(l.base)
    if (fp === null) return { kind: 'failed' }
    const r = await this.ask('POST', l.base, RESTART_ROUTE, l.token)
    if (typeof r === 'string') return { kind: 'failed' }
    const asked = readRestart(r.status, r.json)
    if (asked !== 'restarting') return { kind: asked }
    const deadline = this.deps.now() + RESTART_WAIT_MS
    let gone = false
    while (this.deps.now() < deadline) {
      await this.deps.sleep(POLL_MS)
      const h = await this.ask('GET', l.base, '/api/hello', null)
      if (typeof h === 'string' || h.status !== 200) {
        gone = true
        continue
      }
      if (!gone) continue // still the old process, on its way out
      const back = typeof h.json === 'object' && h.json !== null ? (h.json as { fp?: unknown }).fp : undefined
      if (back !== fp) return { kind: 'someone-else' }
      return { kind: 'back', read: await this.read() }
    }
    return { kind: 'not-back' }
  }
}
