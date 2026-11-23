// The gym's CONTROL service, from main: ask for a plan, show it in a window the OS draws, and only after the person confirms it,
// apply that same plan. THE FIRST CODE IN BEACON THAT CHANGES SOMETHING ON THE GYM, so it is kept apart from the read side
// (./gym-transport.ts stays GET-only, and its smoke says so):
//
//   * its own address and its own WRITE token (a sealed file of its own, never the read token), bound to the address they were
//     made for, read from the keychain once and then kept in memory;
//   * the same network rule as the read side: every address the host resolves to must be a Tailscale one, the connection is
//     made to the address that was checked, no redirect, no proxy, a deadline, a size cap. (A non-release build may also be
//     pointed at this computer's own loopback, to be tried against a fake service; a release build never.)
//   * THE PAGE CAN ONLY ASK. It names an action and, for Promote, a candidate; everything that goes to the service afterwards is
//     built here from what the service answered. The confirmation is drawn by the OS from the plan main holds (not from any text
//     the page sent), its default button is Cancel, and the apply request is sent only when that dialog was answered "yes".
//   * An apply whose outcome is not clear is reported as not known and is NEVER sent again: the gym's own status is the judge.
import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { hostScope } from '@shared/plain-lan'
import { gymToken, slug, tailscaleOnly } from '@shared/gym'
import {
  GYM_CONTROL_COPY,
  GYM_CONTROL_MAX_BYTES,
  GYM_CONTROL_PATHS,
  GYM_PLAN_MAX_AGE_MS,
  confirmationText,
  gymControlAddress,
  parseApplied,
  parseGymCapabilities,
  parseGymOp,
  parseGymPlan,
  type GymControlAction,
  type GymControlAddress,
  type GymControlSettings,
  type GymOpRead,
  type GymRunResult
} from '@shared/gym-control'

export interface ControlReply {
  status: number
  text: string
}
export interface ControlRequest {
  method: 'GET' | 'POST'
  url: string
  /** The address that was checked: it is the only one ever connected to. */
  address: string
  headers: Record<string, string>
  body?: string
}
export type ControlSend = (r: ControlRequest) => Promise<ControlReply | 'unreachable' | 'too-big'>
export type ControlResolve = (host: string) => Promise<string[]>

export interface GymControlDeps {
  /** The saved address, or null. */
  address: () => string | null
  saveAddress: (url: string) => void
  /** The write token, from where it is kept sealed, or null. Called once. */
  readToken: () => string | null
  /** Keep a token ('' forgets it). False: it could not be kept. */
  saveToken: (token: string) => boolean
  /** Is this Beacon known to be the owner of the Prometheus it is connected to? Not knowing is no. */
  isOwner: () => boolean
  /** Show the confirmation (drawn by the OS) and say whether the person chose to go ahead. Cancel is its default. */
  confirm: (c: { title: string; button: string; detail: string }) => Promise<boolean>
  /** A non-release build only: a loopback address is allowed too, so the fake service can stand in for the gym. */
  allowLoopback?: boolean
  /** How long after a confirmation window closes the next ask is refused (a moment; tests say 0). */
  cooldownMs?: number
  resolve?: ControlResolve
  send?: ControlSend
  now?: () => number
  clock?: (at: number) => string
}

const resolveAll: ControlResolve = async (host) => (isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address))
const DEADLINE_MS = 20_000

export const sendPinned: ControlSend = ({ method, url, address, headers, body }) =>
  new Promise((done) => {
    const u = new URL(url)
    const family = isIP(address)
    let req: http.ClientRequest | undefined
    let over = false
    const finish = (r: Awaited<ReturnType<ControlSend>>): void => {
      if (over) return
      over = true
      clearTimeout(deadline)
      done(r)
    }
    const deadline = setTimeout(() => {
      req?.destroy()
      finish('unreachable')
    }, DEADLINE_MS)
    try {
      req = (u.protocol === 'https:' ? https : http).request(
        u,
        {
          method,
          agent: false, // a connection of its own: never one from a pool keyed by name, never a proxy agent
          headers: { accept: 'application/json', ...headers, ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}) },
          timeout: 8_000,
          lookup: (_h, opts, cb) => {
            if (typeof opts === 'object' && opts.all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address, family }])
            else cb(null, address, family)
          }
        },
        (res) => {
          const chunks: Buffer[] = []
          let size = 0
          res.on('data', (c: Buffer) => {
            size += c.length
            if (size > GYM_CONTROL_MAX_BYTES) {
              req?.destroy()
              finish('too-big')
            } else chunks.push(c)
          })
          res.on('end', () => finish({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
          res.on('error', () => finish('unreachable'))
        }
      )
    } catch {
      return finish('unreachable')
    }
    req.on('timeout', () => req?.destroy())
    req.on('error', () => finish('unreachable'))
    req.end(body)
  })

const originOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

export class GymControl {
  /** The write token, and the origin it was made for (sealed together: the token is never used anywhere else, whatever the
   *  address row says by the time it is used). `undefined`: not read yet. */
  private kept: { origin: string; token: string } | null | undefined = undefined
  /** Counts settings changes: a plan that was asked for before one is never applied after it. */
  private epoch = 0
  /** One Promote or Roll back at a time, from the plan to the answer: a second ask while the first waits for a person is refused. */
  private busy = false
  /** The operation most recently started from here (its name comes from the service's own answer, never the page), and where. */
  private current: { opId: string; action: GymControlAction; origin: string } | null = null
  /** When the last confirmation window closed: a page that asks again at once is made to wait a moment. */
  private closedAt = 0

  constructor(private readonly deps: GymControlDeps) {}

  /** The sealed pair, read once. What is sealed is `<origin>\n<token>`; anything else is no token. */
  private sealed(): { origin: string; token: string } | null {
    if (this.kept === undefined) {
      const raw = this.deps.readToken()
      const at = raw === null ? -1 : raw.indexOf('\n')
      const token = raw !== null && at > 0 ? gymToken(raw.slice(at + 1)) : null
      this.kept = token !== null && raw !== null ? { origin: raw.slice(0, at), token } : null
    }
    return this.kept
  }
  /** The token, only for the origin of the address saved NOW. A token made for another place is none. */
  private token(): string | null {
    const k = this.sealed()
    const saved = this.deps.address()
    return k !== null && saved !== null && originOf(saved) !== '' && originOf(saved) === k.origin ? k.token : null
  }
  /** Forget the sealed token. */
  private forgetToken(): boolean {
    if (!this.deps.saveToken('')) return false
    this.kept = null
    return true
  }

  settings(): GymControlSettings {
    return { address: this.deps.address() ?? '', hasToken: this.token() !== null }
  }

  private async where(host: string): Promise<{ ok: true; address: string } | { ok: false; reason: string }> {
    let addresses: string[] = []
    try {
      addresses = await (this.deps.resolve ?? resolveAll)(host)
    } catch {
      /* does not resolve: the check says so */
    }
    if (this.deps.allowLoopback && addresses.length > 0 && addresses.every((a) => hostScope(a) === 'loopback')) return { ok: true, address: addresses[0] }
    if (addresses.length === 0) return { ok: false, reason: GYM_CONTROL_COPY.noResolve }
    const r = tailscaleOnly(addresses)
    return r.ok ? r : { ok: false, reason: GYM_CONTROL_COPY.notTailscale }
  }

  /** Keep a new address ('' forgets it, and its token with it). The token belongs to the computer it was made for. */
  async setAddress(raw: unknown): Promise<GymControlAddress | { ok: true; url: ''; host: '' }> {
    if (typeof raw !== 'string' || raw.length > 300) return { ok: false, reason: GYM_CONTROL_COPY.notUrl }
    if (raw.trim() === '') {
      if (this.sealed() !== null && !this.forgetToken()) return { ok: false, reason: GYM_CONTROL_COPY.noKeychain }
      this.epoch++
      this.current = null
      this.deps.saveAddress('')
      return { ok: true, url: '', host: '' }
    }
    const parsed = gymControlAddress(raw)
    if (!parsed.ok) return parsed
    const where = await this.where(parsed.host)
    if (!where.ok) return where
    // A token belongs to the computer it was made for: another origin forgets it, whether or not it could be read just now.
    const k = this.sealed()
    // (A token that could not be read is bound to its origin all the same, and is no use at any other.)
    if (k !== null && k.origin !== originOf(parsed.url)) {
      if (!this.forgetToken()) return { ok: false, reason: GYM_CONTROL_COPY.noKeychain }
    }
    this.epoch++
    this.current = null
    this.deps.saveAddress(parsed.url)
    return parsed
  }

  setToken(raw: unknown): { ok: true } | { ok: false; reason: string } {
    const forget = typeof raw === 'string' && raw.trim() === ''
    const token = forget ? null : gymToken(raw)
    if (!forget && token === null) return { ok: false, reason: GYM_CONTROL_COPY.badToken }
    // The token is sealed with the origin it is for, which is the address saved now: with none saved, there is nowhere for it to belong.
    const saved = this.deps.address()
    const origin = saved ? originOf(saved) : ''
    if (token !== null && origin === '') return { ok: false, reason: GYM_CONTROL_COPY.noAddressYet }
    if (!this.deps.saveToken(token === null ? '' : `${origin}\n${token}`)) return { ok: false, reason: GYM_CONTROL_COPY.noKeychain }
    this.kept = token === null ? null : { origin, token }
    this.epoch++
    this.current = null
    return { ok: true }
  }

  /** Where to send, and with what: or why not. */
  private async ready(): Promise<{ ok: true; base: string; address: string; headers: Record<string, string>; began: number } | { ok: false; result: GymRunResult }> {
    const began = this.epoch // before any wait: a setting changed while the host is being resolved is a change after this
    const saved = this.deps.address()
    if (!saved) return { ok: false, result: { kind: 'unset' } }
    const parsed = gymControlAddress(saved)
    if (!parsed.ok) return { ok: false, result: { kind: 'refused', reason: parsed.reason } }
    const token = this.token()
    if (token === null) return { ok: false, result: { kind: 'no-token' } }
    const where = await this.where(parsed.host)
    if (!where.ok) return { ok: false, result: { kind: 'refused', reason: where.reason } }
    return { ok: true, base: parsed.url, address: where.address, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, began }
  }

  private async call(to: { base: string; address: string; headers: Record<string, string> }, method: 'GET' | 'POST', path: string, body?: unknown): Promise<ControlReply | 'unreachable' | 'too-big'> {
    return (this.deps.send ?? sendPinned)({ method, url: new URL(path, to.base).toString(), address: to.address, headers: to.headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  }

  /** The answers that are the same for every request: unreachable, too big, and the service's own refusals of who is asking. */
  private static refused(r: ControlReply | 'unreachable' | 'too-big'): GymRunResult | null {
    if (r === 'unreachable') return { kind: 'unreachable' }
    if (r === 'too-big') return { kind: 'unreadable' }
    if (r.status === 401) return { kind: 'denied', why: 'token' }
    if (r.status === 403) return { kind: 'denied', why: 'device' }
    if (r.status === 429) return { kind: 'denied', why: 'rate' }
    return null
  }

  private static json(r: ControlReply): unknown {
    try {
      return JSON.parse(r.text)
    } catch {
      return undefined
    }
  }

  /** Promote or Roll back, from the first question to the service's answer to the apply. `candidate` is for Promote only. */
  async run(action: unknown, candidate: unknown): Promise<GymRunResult> {
    if (action !== 'promote' && action !== 'rollback') return { kind: 'unreadable' }
    const wanted = action === 'promote' ? slug(candidate) : null
    if (action === 'promote' && wanted === null) return { kind: 'not-offered' }
    if (!this.deps.isOwner()) return { kind: 'not-owner' }
    if (this.busy || Date.now() - this.closedAt < (this.deps.cooldownMs ?? 1_500)) return { kind: 'busy' }
    this.busy = true
    try {
      return await this.runOnce(action, wanted)
    } finally {
      this.busy = false
      this.closedAt = Date.now()
    }
  }

  private async runOnce(action: GymControlAction, wanted: string | null): Promise<GymRunResult> {
    const to = await this.ready()
    if (!to.ok) return to.result
    const now = this.deps.now ?? Date.now
    // What the service offers, now: a candidate is never taken from the page's word.
    const capsReply = await this.call(to, 'GET', GYM_CONTROL_PATHS.capabilities)
    const bad = GymControl.refused(capsReply)
    if (bad) return bad
    const capsRep = capsReply as ControlReply
    if (capsRep.status !== 200) return { kind: 'unreadable' }
    const caps = parseGymCapabilities(GymControl.json(capsRep))
    if (!caps) return { kind: 'unreadable' }
    if (!caps[action]) return { kind: 'not-offered' }
    if (action === 'promote' && (wanted === null || !caps.candidates.includes(wanted))) return { kind: 'not-offered' }
    // The plan: a dry run.
    const planReply = await this.call(to, 'POST', action === 'promote' ? GYM_CONTROL_PATHS.promote : GYM_CONTROL_PATHS.rollback, action === 'promote' ? { candidate: wanted } : {})
    const bad2 = GymControl.refused(planReply)
    if (bad2) return bad2
    const planRep = planReply as ControlReply
    if (planRep.status !== 200) return { kind: 'unreadable' }
    const plan = parseGymPlan(GymControl.json(planRep))
    // The plan must be the one asked for: the action, and for Promote the model chosen.
    if (!plan || plan.action !== action || (action === 'promote' && plan.refusal === null && plan.candidate !== wanted)) return { kind: 'unreadable' }
    if (plan.refusal !== null) return { kind: 'plan-refused', refusal: plan.refusal }
    if (plan.expiresAt <= now()) return { kind: 'expired' }
    if (plan.expiresAt - now() > GYM_PLAN_MAX_AGE_MS) return { kind: 'unreadable' }
    // The person decides, from this plan's own content.
    const clock = this.deps.clock ?? ((at: number) => new Date(at).toLocaleTimeString())
    const shown = confirmationText(plan, clock)
    if (!shown.fits) return { kind: 'unreadable' } // too long to be shown whole: not shown, so not applied
    // A window the person walked away from (or one the OS never answers) must not hold Promote and Roll back for good: it is
    // a no when the plan runs out.
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timeout'>((ok) => {
      timer = setTimeout(() => ok('timeout'), Math.max(0, plan.expiresAt - now()))
    })
    const answered = await Promise.race([this.deps.confirm({ title: shown.title, button: shown.button, detail: shown.detail }), timedOut]).finally(() => clearTimeout(timer))
    if (answered === 'timeout') return { kind: 'expired' }
    const go = answered
    if (!go) return { kind: 'cancelled' }
    // Nothing is sent if what it was made for has changed meanwhile: the settings (another computer, another token), the
    // owner (the connection moved), or the clock.
    if (to.began !== this.epoch || !this.deps.isOwner()) return { kind: 'settings-changed' }
    if (plan.expiresAt <= now()) return { kind: 'expired' }
    // APPLY: this plan, by the name and hash the service gave it. Once, whatever comes back. The operation shown from here on is
    // this one's: an older one is not left standing in case this one's outcome is not known.
    this.current = null
    const applied = await this.call(to, 'POST', GYM_CONTROL_PATHS.apply, { plan_id: plan.planId, plan_hash: plan.planHash })
    if (applied === 'unreachable' || applied === 'too-big') return { kind: 'unknown', action }
    if (applied.status === 409) return { kind: 'changed' }
    if (applied.status === 410) return { kind: 'expired' }
    if (applied.status === 401) return { kind: 'denied', why: 'token' }
    if (applied.status === 403) return { kind: 'denied', why: 'device' }
    if (applied.status === 429) return { kind: 'denied', why: 'rate' }
    if (applied.status !== 200 && applied.status !== 202) return { kind: 'unknown', action }
    const opId = parseApplied(GymControl.json(applied))
    if (opId === null) return { kind: 'unknown', action }
    this.current = { opId, action, origin: originOf(to.base) }
    return { kind: 'started', action }
  }

  /** The operation last started from here, read from the service. Read only. */
  async op(): Promise<GymOpRead> {
    const cur = this.current
    if (!cur) return { kind: 'none' }
    const to = await this.ready()
    if (!to.ok) return to.result.kind === 'denied' ? to.result : { kind: 'unreachable' }
    if (originOf(to.base) !== cur.origin) return { kind: 'none' } // another computer now: its operations are not this one's
    const r = await this.call(to, 'GET', GYM_CONTROL_PATHS.op(cur.opId))
    if (r === 'unreachable') return { kind: 'unreachable' }
    if (r === 'too-big') return { kind: 'unreadable' }
    if (r.status === 401) return { kind: 'denied', why: 'token' }
    if (r.status === 403) return { kind: 'denied', why: 'device' }
    if (r.status === 429) return { kind: 'denied', why: 'rate' }
    if (r.status !== 200) return { kind: 'unreadable' }
    const op = parseGymOp(GymControl.json(r))
    return op ? { kind: 'shown', action: cur.action, op } : { kind: 'unreadable' }
  }
}
