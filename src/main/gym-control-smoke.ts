/**
 * Activity › Gym › Promote and Roll back — headless, under ELECTRON_RUN_AS_NODE, against a FAKE control service on this
 * computer's loopback (the fake is in this file: it is not shipped, and not the real service, which does not exist yet).
 *
 * The rules pinned, in the order the thing runs:
 *   1. Only the owner; nothing is sent without an address and a write token of its own; the token goes in the Authorization
 *      header to the checked address and nowhere else, and is read from the keychain once.
 *   2. The page can only ask: it names an action and a model; a model the service does not offer is never planned.
 *   3. A plan is shown in full or not at all (a plan with one setting Beacon cannot read is no plan), and the confirmation says
 *      what the plan says: every setting from and to, which computers, what restarts, the gate, whether it can be rolled back.
 *      No reassurance of Beacon's own.
 *   4. THE APPLY goes out exactly once, only after the OS-drawn confirmation said yes, only for that plan, by the name and hash
 *      the service gave it, and never if the plan ran out or the settings changed while it waited. Cancel (the default) sends
 *      nothing. A 409 says the gym changed. A reply that is not clear is "not known" and is never sent again.
 *   5. After it: the operation is only read; what the gym says about untouched files is shown only from its own answer.
 *   6. The read side stays read-only and does not know this exists.
 *
 *   npm run build && npm run smoke:gym-control
 *
 * Run with `--serve [port]` it only serves the fake on loopback (for the app probe) and prints its port.
 */
import { readFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseGymStatus } from '@shared/gym'
import {
  GYM_BUTTON_COPY,
  GYM_CONTROL_COPY,
  GYM_PLAN_MAX_CHANGES,
  GYM_RUN_COPY,
  confirmationText,
  controlView,
  gymControlAddress,
  opAfterFacts,
  promotionFacts,
  opWords,
  parseApplied,
  parseGymCapabilities,
  parseGymOp,
  parseGymPlan,
  refusalWords,
  runWords,
  type GymPlan,
  type GymRunResult
} from '@shared/gym-control'
import { GymControl, sendPinned, type ControlRequest } from './gym-control'
import promoted from './fixtures/gym_status_promoted.json'

// ── the fake control service ───────────────────────────────────────────────────────────────────────────────────────────────
const TOKEN = ['smoke', 'only', 'not-a-real-write-token', '0123456789'].join('_')
const HEX = (c: string): string => c.repeat(64)

interface Seen {
  method: string
  path: string
  auth: string | null
  body: string
}
class Fake {
  server: http.Server
  port = 0
  seen: Seen[] = []
  promoted = false
  version = 1
  candidates = ['rehearsal_r5_final_q4']
  /** Knobs. */
  dropApply = false
  driftAfterPlan = false
  planTime: () => number = Date.now
  planTtlMs = 5 * 60_000
  mangle: ((plan: Record<string, unknown>) => Record<string, unknown>) | null = null
  private plans = new Map<string, { hash: string; version: number; action: string; used: boolean; expires: number }>()
  private ops = new Map<string, number>()
  private n = 0
  constructor() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => this.handle(req, res, Buffer.concat(chunks).toString('utf8')))
    })
  }
  async start(port = 0): Promise<void> {
    await new Promise<void>((ok) => this.server.listen(port, '127.0.0.1', ok))
    this.port = (this.server.address() as AddressInfo).port
  }
  stop(): void {
    this.server.close()
  }
  count(path: string): number {
    return this.seen.filter((s) => s.path === path).length
  }
  private send(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  private plan(action: 'promote' | 'rollback', candidate: string | null): Record<string, unknown> {
    const id = `plan${++this.n}`
    const hash = HEX('a'.replace('a', String(this.n % 10)))
    const refusal = action === 'promote' ? (this.promoted ? 'already_promoted' : null) : this.promoted ? null : 'nothing_to_roll_back'
    this.plans.set(id, { hash, version: this.version, action, used: false, expires: this.planTime() + this.planTtlMs })
    const base: Record<string, unknown> = {
      plan_id: id,
      plan_hash: hash,
      expires_at: new Date(this.planTime() + this.planTtlMs).toISOString().replace('Z', '+00:00'),
      action,
      from: action === 'promote' ? { model: 'rehearsal_base', recipe: 'r3', round: 'r3' } : { model: 'rehearsal_r5_final_q4', recipe: 'r5', round: 'r5' },
      to: action === 'promote' ? { model: candidate ?? 'unknown', recipe: 'r5', round: 'r5' } : { model: 'rehearsal_base', recipe: 'r3', round: 'r3' },
      changes: [
        { path: ['models', 'primary'], from: action === 'promote' ? 'rehearsal_base' : 'rehearsal_r5_final_q4', to: action === 'promote' ? candidate : 'rehearsal_base' },
        { path: ['pins', 'sampling', 'temperature'], from: 0.7, to: 0.2 },
        { path: ['features', 'shadow'], from: false, to: true }
      ],
      touches: [{ host: 'serve_host', what: 'rehearsal_instance' }],
      restarts: ['rehearsal_daemon', 'rehearsal_student'],
      gate: { verdict: 'pass', held: false },
      rollback_available: action === 'promote' ? true : false,
      candidate: action === 'promote' ? candidate : null,
      candidate_sha256: action === 'promote' ? HEX('b') : null,
      refusal
    }
    return this.mangle ? this.mangle(base) : base
  }
  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
    const path = (req.url ?? '').split('?')[0]
    const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : null
    this.seen.push({ method: req.method ?? '', path, auth, body })
    if (path.startsWith('/__fake')) {
      // Serve mode only: the probe changes the fake's state from outside.
      const k = JSON.parse(body || '{}') as Record<string, unknown>
      if (typeof k.promoted === 'boolean') this.promoted = k.promoted
      if (typeof k.drift === 'boolean') this.driftAfterPlan = k.drift
      if (typeof k.drop === 'boolean') this.dropApply = k.drop
      return this.send(res, 200, { promoted: this.promoted, applies: this.count('/v1/apply') })
    }
    if (auth !== `Bearer ${TOKEN}`) return this.send(res, 401, {})
    if (req.method === 'GET' && path === '/v1/capabilities') return this.send(res, 200, { promote: true, rollback: true, candidates: this.candidates })
    if (req.method === 'POST' && (path === '/v1/promote/plan' || path === '/v1/rollback/plan')) {
      const want = JSON.parse(body || '{}') as { candidate?: unknown }
      const action = path === '/v1/promote/plan' ? 'promote' : 'rollback'
      if (action === 'promote' && (typeof want.candidate !== 'string' || !this.candidates.includes(want.candidate))) return this.send(res, 400, {})
      const plan = this.plan(action, action === 'promote' ? (want.candidate as string) : null)
      if (this.driftAfterPlan) this.version++
      return this.send(res, 200, plan)
    }
    if (req.method === 'POST' && path === '/v1/apply') {
      const a = JSON.parse(body || '{}') as { plan_id?: string; plan_hash?: string }
      const p = this.plans.get(String(a.plan_id))
      if (!p || p.hash !== a.plan_hash || p.used || p.expires < this.planTime()) return this.send(res, 410, {})
      if (p.version !== this.version) return this.send(res, 409, {})
      p.used = true
      if (this.dropApply) return void req.socket.destroy() // the connection dies after the service took the plan
      this.promoted = p.action === 'promote'
      this.version++
      const id = `op${++this.n}`
      this.ops.set(id, 0)
      return this.send(res, 202, { op_id: id })
    }
    const op = /^\/v1\/ops\/([a-z0-9_]+)$/.exec(path)
    if (req.method === 'GET' && op && this.ops.has(op[1])) {
      const polls = (this.ops.get(op[1]) ?? 0) + 1
      this.ops.set(op[1], polls)
      const at = new Date().toISOString().replace('Z', '+00:00')
      if (polls < 3) return this.send(res, 200, { status: 'running', step: polls === 1 ? 'student_started' : 'instance_restarted', at, outcome: null })
      return this.send(res, 200, { status: 'done', step: null, at, outcome: 'ok', before_match: true, real_untouched: true })
    }
    this.send(res, 404, {})
  }
}

// ── the harness ────────────────────────────────────────────────────────────────────────────────────────────────────────────
let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[gym-control-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 59
process.on('exit', () => {
  if (process.argv.includes('--serve')) return
  if (checks !== EXPECTED) {
    console.error(`[gym-control-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`[gym-control-smoke] FAIL — ${failures}/${checks} checks failed`)
    process.exitCode = 1
  } else console.log(`[gym-control-smoke] OK — ${checks} checks passed`)
})

interface Rig {
  fake: Fake
  control: GymControl
  confirms: { title: string; button: string; detail: string }[]
  tokenReads: number
  saved: { address: string; token: string }
  owner: { v: boolean }
  clock: { now: number }
  answer: { v: boolean | (() => Promise<boolean>) }
}
async function rig(opts: { loopback?: boolean; token?: string | null; address?: boolean; cooldown?: number; resolve?: () => void } = {}): Promise<Rig> {
  const fake = new Fake()
  await fake.start()
  const r: Rig = { fake, control: null as unknown as GymControl, confirms: [], tokenReads: 0, saved: { address: opts.address === false ? '' : `http://127.0.0.1:${fake.port}`, token: opts.token === null ? '' : `http://127.0.0.1:${fake.port}\n${opts.token ?? TOKEN}` }, owner: { v: true }, clock: { now: Date.now() }, answer: { v: true } }
  fake.planTime = () => r.clock.now
  r.control = new GymControl({
    address: () => r.saved.address || null,
    saveAddress: (u) => void (r.saved.address = u),
    readToken: () => (r.tokenReads++, r.saved.token || null),
    saveToken: (t) => ((r.saved.token = t), true),
    isOwner: () => r.owner.v,
    confirm: async (c) => {
      r.confirms.push(c)
      return typeof r.answer.v === 'function' ? r.answer.v() : r.answer.v
    },
    allowLoopback: opts.loopback !== false,
    cooldownMs: opts.cooldown ?? 0,
    resolve: async () => (opts.resolve?.(), ['127.0.0.1']),
    send: (q: ControlRequest) => sendPinned(q),
    now: () => r.clock.now,
    clock: () => '10:05'
  })
  return r
}

async function main(): Promise<void> {
  if (process.argv.includes('--serve')) {
    // The probe's fake: loopback, a port given or chosen, the token it prints.
    const f = new Fake()
    const asked = Number(process.argv[process.argv.indexOf('--serve') + 1])
    await f.start(Number.isInteger(asked) && asked > 0 ? asked : 0)
    console.log(JSON.stringify({ port: f.port, token: TOKEN }))
    return
  }

  // ── 1. who, and with what ───────────────────────────────────────────────────────────────────────────────────────────────
  {
    const r = await rig()
    r.owner.v = false
    const res = await r.control.run('promote', 'rehearsal_r5_final_q4')
    assert(res.kind === 'not-owner' && r.fake.seen.length === 0 && r.confirms.length === 0, 'owner only: a device that is not known to be the owner asks nothing, shows nothing, sends nothing')
    r.fake.stop()
  }
  {
    const none = await rig({ address: false })
    const noTok = await rig({ token: null })
    const a = await none.control.run('promote', 'rehearsal_r5_final_q4')
    const b = await noTok.control.run('rollback', undefined)
    assert(a.kind === 'unset' && b.kind === 'no-token' && none.fake.seen.length === 0 && noTok.fake.seen.length === 0, 'with no address, or no write token, nothing is sent at all')
    none.fake.stop()
    noTok.fake.stop()
  }
  {
    const r = await rig({ loopback: false })
    const res = await r.control.run('rollback', undefined)
    assert(res.kind === 'refused' && r.fake.seen.length === 0, 'a release build refuses even this computer\'s loopback: only Tailscale is ever connected to, and nothing is sent to anything else')
    r.fake.stop()
  }

  // ── 2. the happy path, and everything it sent ───────────────────────────────────────────────────────────────────────────
  {
    const r = await rig()
    const res = await r.control.run('promote', 'rehearsal_r5_final_q4')
    const paths = r.fake.seen.map((s) => `${s.method} ${s.path}`).join()
    assert(res.kind === 'started' && paths === 'GET /v1/capabilities,POST /v1/promote/plan,POST /v1/apply', 'promote: capabilities, then the plan, then one apply, in that order', `${res.kind} ${paths}`)
    const apply = r.fake.seen.find((s) => s.path === '/v1/apply')
    const sent = JSON.parse(apply?.body ?? '{}') as Record<string, unknown>
    assert(Object.keys(sent).sort().join() === 'plan_hash,plan_id' && /^plan\d+$/.test(String(sent.plan_id)) && /^[0-9a-f]{64}$/.test(String(sent.plan_hash)), 'the apply carries only the plan\'s name and hash, as the service gave them')
    assert(r.fake.seen.every((s) => s.auth === `Bearer ${TOKEN}`) && r.fake.seen.every((s) => !s.body.includes(TOKEN) && !s.path.includes(TOKEN)) && r.tokenReads === 1, 'the write token goes only in the Authorization header, never in a path or a body, and was read from the keychain once')
    assert(r.confirms.length === 1 && r.confirms[0].button === 'Promote' && r.confirms[0].title === 'Promote the rehearsal model', 'one confirmation was shown, for this plan')
    let last = await r.control.op()
    let polls = 0
    while (last.kind === 'shown' && last.op.status === 'running' && polls++ < 5) last = await r.control.op()
    assert(last.kind === 'shown' && last.op.status === 'done' && last.action === 'promote' && r.fake.promoted && r.fake.seen.filter((s) => s.path.startsWith('/v1/ops/')).every((s) => s.method === 'GET'), 'the operation is read (GET only) until it is done, and the gym is promoted')
    assert(last.kind === 'shown' && opAfterFacts(last.op).length === 2 && /match/.test(opAfterFacts(last.op)[0]) && /untouched/.test(opAfterFacts(last.op)[1]), 'what was left alone is said only afterwards, from the operation\'s own answer')
    r.fake.stop()
  }

  // ── 3. Cancel, and the other ways it must not go ahead ──────────────────────────────────────────────────────────────────
  {
    const r = await rig()
    r.answer.v = false
    const res = await r.control.run('promote', 'rehearsal_r5_final_q4')
    assert(res.kind === 'cancelled' && r.fake.count('/v1/apply') === 0 && !r.fake.promoted, 'Cancel: no apply is sent, and the gym is as it was')
    r.fake.stop()
  }
  {
    const r = await rig()
    r.answer.v = async () => {
      r.clock.now += 6 * 60_000 // the window sat open past the plan's expiry
      return true
    }
    const res = await r.control.run('promote', 'rehearsal_r5_final_q4')
    assert(res.kind === 'expired' && r.fake.count('/v1/apply') === 0, 'a plan that ran out while it was on screen is not applied, even when confirmed')
    r.fake.stop()
  }
  {
    const r = await rig()
    r.answer.v = async () => {
      r.owner.v = false // the connection moved to a device that is not the owner while the window was up
      return true
    }
    const a = await r.control.run('promote', 'rehearsal_r5_final_q4')
    const r2 = await rig()
    r2.answer.v = async () => {
      r2.control.setToken(['smoke', 'only', 'a-different-token', '0123456789'].join('_')) // a setting changed while the window was up
      return true
    }
    const b = await r2.control.run('promote', 'rehearsal_r5_final_q4')
    assert(a.kind === 'settings-changed' && b.kind === 'settings-changed' && r.fake.count('/v1/apply') === 0 && r2.fake.count('/v1/apply') === 0, 'if the owner or the settings changed while the confirmation was up, nothing is applied')
    r.fake.stop()
    r2.fake.stop()
  }
  {
    const r = await rig()
    r.fake.driftAfterPlan = true
    const res = await r.control.run('promote', 'rehearsal_r5_final_q4')
    assert(res.kind === 'changed' && r.fake.count('/v1/apply') === 1 && !r.fake.promoted && (await r.control.op()).kind === 'none', 'a 409 (the gym changed since the plan) is said, nothing is retried, and no operation is tracked')
    r.fake.stop()
  }
  {
    const r = await rig()
    r.fake.dropApply = true
    const res = await r.control.run('promote', 'rehearsal_r5_final_q4')
    const again = r.fake.count('/v1/apply')
    await r.control.op()
    assert(res.kind === 'unknown' && again === 1 && r.fake.count('/v1/apply') === 1, 'a connection that dies after the apply was sent is "not known", and the apply is never sent again')
    assert(/will not send it again/i.test(runWords(res)) && /status/i.test(runWords(res)), 'and the words say it was not retried and send the person to the gym\'s own status')
    r.fake.stop()
  }
  {
    const r = await rig()
    r.fake.promoted = true
    const res = await r.control.run('promote', 'rehearsal_r5_final_q4')
    const back = await r.control.run('rollback', undefined)
    assert(res.kind === 'plan-refused' && res.refusal === 'already_promoted' && back.kind === 'started' && r.confirms.length === 1 && r.confirms[0].button === 'Roll back', 'a refusal is shown with no confirmation and no apply; Roll back works in the same state')
    const r2 = await rig()
    const nothing = await r2.control.run('rollback', undefined)
    assert(nothing.kind === 'plan-refused' && nothing.refusal === 'nothing_to_roll_back' && r2.confirms.length === 0 && r2.fake.count('/v1/apply') === 0 && refusalWords('nothing_to_roll_back') === 'There is nothing to roll back.', 'Roll back with nothing to roll back is refused by its own plan, in Beacon\'s words')
    r.fake.stop()
    r2.fake.stop()
  }

  // ── 4. the page can only ask ────────────────────────────────────────────────────────────────────────────────────────────
  {
    const r = await rig()
    const odd = await r.control.run('promote', '../../etc/passwd')
    const other = await r.control.run('promote', 'some_other_model')
    const act = await r.control.run('delete', 'rehearsal_r5_final_q4')
    assert(odd.kind === 'not-offered' && other.kind === 'not-offered' && act.kind === 'unreadable' && r.fake.count('/v1/promote/plan') === 0 && r.fake.count('/v1/apply') === 0, 'a model the service does not offer, or an action that is not one, is never planned and never applied')
    r.fake.stop()
  }
  {
    const r = await rig()
    let release: (v: boolean) => void = () => undefined
    r.answer.v = () => new Promise<boolean>((ok) => (release = ok))
    const first = r.control.run('promote', 'rehearsal_r5_final_q4')
    for (let i = 0; i < 50 && r.confirms.length === 0; i++) await new Promise((ok) => setTimeout(ok, 20))
    const second = await r.control.run('rollback', undefined)
    release(false)
    assert(second.kind === 'busy' && (await first).kind === 'cancelled' && r.confirms.length === 1, 'while one confirmation is waiting for a person, a second ask is refused')
    r.fake.stop()
  }
  {
    const r = await rig()
    r.fake.mangle = (p) => ({ ...p, action: 'rollback' })
    const wrongAction = await r.control.run('promote', 'rehearsal_r5_final_q4')
    r.fake.mangle = (p) => ({ ...p, candidate: 'some_other_model' })
    const wrongModel = await r.control.run('promote', 'rehearsal_r5_final_q4')
    r.fake.mangle = (p) => ({ ...p, changes: [{ path: ['a'], from: 1, to: 'this sentence is not an identifier' }] })
    const sentence = await r.control.run('promote', 'rehearsal_r5_final_q4')
    r.fake.mangle = (p) => ({ ...p, expires_at: new Date(r.clock.now + 24 * 3_600_000).toISOString() })
    const longLived = await r.control.run('promote', 'rehearsal_r5_final_q4')
    assert([wrongAction, wrongModel, sentence, longLived].every((x) => x.kind === 'unreadable') && r.confirms.length === 0 && r.fake.count('/v1/apply') === 0, 'a plan for another action or another model, one with a sentence in it, or one good for a day, is not shown and not applied')
    r.fake.stop()
  }
  {
    const r = await rig()
    const first = r.control.settings()
    const moved = await r.control.setAddress(`http://127.0.0.1:${r.fake.port + 1}`)
    assert(first.hasToken && moved.ok && !r.control.settings().hasToken && r.saved.token === '', 'the write token belongs to the computer it was made for: a different address forgets it')
    const r2 = await rig()
    await r2.control.setAddress('')
    assert(!r2.control.settings().hasToken && r2.saved.address === '', 'forgetting the address forgets the token with it')
    const bad = r2.control.setToken('has a space')
    assert(!bad.ok && !(await r2.control.setAddress('http://gym-box:18098/v1/apply')).ok && (() => { const g = gymControlAddress('http://gym-box:18098/'); return g.ok && g.url === 'http://gym-box:18098' })(), 'a token with a space is refused; an address names a service (no path), and is kept as its origin')
    r.fake.stop()
    r2.fake.stop()
  }
  {
    const r = await rig({ token: TOKEN })
    r.fake.seen.length = 0
    const wrong = await rig({ token: ['smoke', 'only', 'wrong-token-0123456789'].join('_') })
    const denied = await wrong.control.run('rollback', undefined)
    assert(denied.kind === 'denied' && denied.why === 'token' && wrong.fake.seen.length === 1, 'a token the service does not accept is said, after the first request, and nothing else is sent')
    r.fake.stop()
    wrong.fake.stop()
  }

  // ── 4b. what the review found ──────────────────────────────────────────────────────────────────────────────────────────────
  {
    // the address row rewritten behind main's back (a page that could write settings): the token is for the origin it was sealed with
    const r = await rig()
    r.saved.address = `http://127.0.0.1:${r.fake.port + 1}`
    const res = await r.control.run('rollback', undefined)
    assert(res.kind === 'no-token' && r.fake.seen.length === 0 && !r.control.settings().hasToken, 'the write token is sealed with the origin it was made for: an address row changed from outside gets no token, and nothing is sent')
    r.fake.stop()
  }
  {
    // the token forgotten while the host is being resolved
    let setToken: (() => void) | null = null
    const r = await rig({ resolve: () => setToken?.() })
    setToken = () => void r.control.setToken('')
    const res = await r.control.run('promote', 'rehearsal_r5_final_q4')
    assert(res.kind !== 'started' && r.fake.count('/v1/apply') === 0, 'a token forgotten while the address is being resolved is not used to apply')
    r.fake.stop()
  }
  {
    const r = await rig({ cooldown: 1500 })
    r.answer.v = false
    const first = await r.control.run('rollback', undefined)
    r.fake.promoted = true
    const second = await r.control.run('rollback', undefined)
    assert(first.kind !== 'busy' && second.kind === 'busy' && r.confirms.length <= 1, 'asking again at once after a window closes is made to wait a moment')
    r.fake.stop()
  }
  {
    const r = await rig()
    r.fake.planTtlMs = 600
    r.answer.v = () => new Promise<boolean>(() => undefined) // a window nobody ever answers
    const stuck = await r.control.run('promote', 'rehearsal_r5_final_q4')
    r.answer.v = false
    const after = await r.control.run('promote', 'rehearsal_r5_final_q4')
    assert(stuck.kind === 'expired' && after.kind === 'cancelled' && r.fake.count('/v1/apply') === 0, 'a window that is never answered ends as a no when the plan runs out, and does not hold the buttons for good')
    r.fake.stop()
  }
  {
    const r = await rig()
    await r.control.run('promote', 'rehearsal_r5_final_q4')
    const before = await r.control.op()
    r.control.setToken(['smoke', 'only', 'a-different-token', '0123456789'].join('_'))
    assert(before.kind === 'shown' && (await r.control.op()).kind === 'none', 'a change of token or address forgets the operation being followed, so it is never read from another computer')
    const noAddr = await rig({ address: false, token: null })
    const refused = noAddr.control.setToken(TOKEN)
    assert(!refused.ok && !refused.ok && refused.reason === GYM_CONTROL_COPY.noAddressYet && noAddr.saved.token === '', 'a token is not kept before there is an address for it to belong to')
    r.fake.stop()
    noAddr.fake.stop()
  }
  {
    const r = await rig()
    const longPath = (i: number): string[] => Array.from({ length: 8 }, (_, k) => `${'segment'.repeat(5)}${i}_${k}`.slice(0, 40))
    r.fake.mangle = (p) => ({ ...p, changes: Array.from({ length: 24 }, (_, i) => ({ path: longPath(i), from: i, to: i + 1 })) })
    const big = await r.control.run('promote', 'rehearsal_r5_final_q4')
    assert(big.kind === 'unreadable' && r.confirms.length === 0 && r.fake.count('/v1/apply') === 0, 'a plan whose confirmation would be too long to show whole (the OS clips the end) is not shown and not applied')
    r.fake.stop()
  }
  {
    const base = { role: 'owner' as const, configured: true, promotion: parseGymStatus(promoted)?.promotion ?? null, stale: false, opRunning: false, waiting: false }
    const p = base.promotion
    const stalePromoting = controlView({ ...base, stale: true, promotion: p && { ...p, state: 'promoting' } })
    const unknownOp = controlView({ ...base, opUnknown: true })
    assert(stalePromoting.rollback.enabled && !stalePromoting.promote.enabled && unknownOp.rollback.enabled && !unknownOp.promote.enabled && unknownOp.promote.why === GYM_BUTTON_COPY.unknown, 'a "promoting" state in an old status does not keep Roll back off, and an operation whose end is not known keeps Promote off and says why')
  }
  {
    const ipcSrc = readFileSync('src/main/ipc.ts', 'utf8').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    assert(/IPC\.SETTINGS_SET[\s\S]{0,200}startsWith\('gym:'\)/.test(ipcSrc), 'the page\'s generic settings write refuses every gym: key: the gym\'s addresses are written only by the gym\'s own checked handlers')
  }

  // ── 5. the plan, parsed ────────────────────────────────────────────────────────────────────────────────────────────────
  const good = (() => {
    const f = new Fake()
    f.planTime = () => Date.parse('2026-11-23T10:00:00-05:00')
    return (f as unknown as { plan(a: 'promote' | 'rollback', c: string | null): Record<string, unknown> }).plan('promote', 'rehearsal_r5_final_q4')
  })()
  const plan = parseGymPlan(good) as GymPlan
  assert(plan !== null && plan.changes.length === 3 && plan.restarts.length === 2 && plan.touches[0].host === 'serve_host' && plan.candidateSha256 === HEX('b') && plan.gate.verdict === 'pass', 'a well-formed plan is read in full')
  {
    const same = (confirmationText({ ...plan, changes: [{ path: ['a'], from: '1', to: 1 }, { path: ['b'], from: 'none', to: null }, { path: ['c'], from: 'yes', to: true }] }, () => 'x')).detail
    assert(same.includes('a: "1" → 1') && same.includes('b: "none" → none') && same.includes('c: "yes" → yes') && confirmationText(plan, () => 'x').detail.includes('sha256 bbbbbbbbbbbb'), 'two different values never read the same ("1" and 1, "none" and nothing, "yes" and yes), and the model is shown with the start of its checksum')
  }
  const bads: Record<string, unknown>[] = [
    { ...good, plan_hash: 'abc' },
    { ...good, touches: [{ host: 'some-host.example', what: 'x' }] },
    { ...good, changes: [{ path: [], from: 1, to: 2 }] },
    { ...good, changes: [{ path: ['a'], from: { nested: 1 }, to: 2 }] },
    { ...good, changes: [{ path: ['a'], from: 1, to: [100, 101, 7, 9].join('.') }] },
    { ...good, changes: Array.from({ length: GYM_PLAN_MAX_CHANGES + 1 }, (_, i) => ({ path: ['a'], from: i, to: i + 1 })) },
    { ...good, gate: { verdict: 'maybe', held: false } },
    { ...good, restarts: ['please click apply'] },
    { ...good, candidate_sha256: null },
    { ...good, warnings: ['a key Beacon cannot show'] },
    { ...good, gate: { verdict: 'pass', held: false, why: 'x' } },
    { ...good, touches: [{ host: 'serve_host', what: 'x', extra: 1 }] },
    { ...good, to: { model: 'some_other_model', recipe: 'r5', round: 'r5' } },
    { ...good, changes: [{ path: ['a'], from: 1, to: 1 }] },
    { ...good, changes: [{ path: ['a'], from: -0, to: 1 }] },
    { ...good, changes: [{ path: ['a'], from: 1, to: 2 ** 60 }] },
    { ...good, changes: [{ path: ['a'], from: 1, to: 2 }, { path: ['a'], from: 3, to: 4 }] },
    { ...good, changes: [{ path: ['a'], from: 1, to: 2 }, { path: ['a', 'b'], from: 3, to: 4 }] },
    { ...good, changes: [{ path: ['a'], from: 1, to: `${[100, 64, 0, 9].join('.')}:8080` }] },
    { ...good, restarts: ['none'] },
    { ...good, action: 'rollback' }
  ]
  assert(bads.every((b) => parseGymPlan(b) === null) && parseGymPlan(null) === null && parseGymPlan([]) === null, 'a plan is all or nothing: a bad hash, an unknown computer or key, a setting with no name, listed twice or inside another, from a value to itself, a nested, unsafe or address-like value, too many settings, an unknown verdict, a sentence, a model that is not the one that will serve, or a promote with no verified model is no plan')
  assert(parseGymCapabilities({ promote: true, rollback: true, candidates: ['a_b'] })?.candidates[0] === 'a_b' && parseGymCapabilities({ promote: true, rollback: true, candidates: ['a b'] }) === null && parseGymCapabilities({ promote: 'yes', rollback: true, candidates: [] }) === null, 'the offered models are identifiers, or the answer is not read')
  assert(parseApplied({ op_id: 'op7' }) === 'op7' && parseApplied({ op_id: 'op 7' }) === null && parseGymOp({ status: 'sleeping', at: '2026-11-23T10:00:00-05:00' }) === null && parseGymOp({ status: 'done', at: '2026-11-23T10:00:00-05:00', step: null, outcome: 'ok' })?.status === 'done', 'an operation name is an identifier; an operation status is one of the five')

  // ── 6. the words ───────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const c = confirmationText(plan, () => '10:05')
    const everySetting = plan.changes.every((x) => c.detail.includes(`${x.path.join(' › ')}: ${x.from === null ? 'none' : typeof x.from === 'boolean' ? (x.from ? 'yes' : 'no') : typeof x.from === 'string' ? `"${x.from}"` : x.from} → `))
    assert(everySetting && c.detail.includes('rehearsal_base (recipe r3, round r3)') && c.detail.includes('rehearsal_r5_final_q4 (recipe r5, round r5)') && c.detail.includes('Serving computer (rehearsal_instance)') && c.detail.includes('rehearsal_daemon, rehearsal_student') && /The gate’s result: passed/.test(c.detail) && /Rolling back afterwards: possible/.test(c.detail) && c.detail.includes('10:05'), 'the confirmation lists what is serving now and what will, every setting from and to, the computers, the restarts, the gate and whether it can be rolled back')
    assert(!/untouched|not touched|left alone|safe|unaffected|nothing else|won.?t|no risk|harmless/i.test(c.detail + c.title), 'the confirmation makes no reassurance of its own: only what the plan lists')
    const held = confirmationText({ ...plan, gate: { verdict: 'fail', held: true }, rollbackAvailable: false, changes: [], restarts: [] }, () => 'x')
    assert(/failed; held: yes/.test(held.detail) && /not possible/.test(held.detail) && /No settings change/.test(held.detail) && /Nothing restarts/.test(held.detail), 'a failed, held gate, no rollback, no settings and no restarts are each said plainly')
  }
  assert(opWords({ status: 'running', step: 'student_started', at: 0, outcome: null, beforeMatch: null, realUntouched: null }, 'promote').text === 'Promote: running · student_started' && opAfterFacts({ status: 'failed', step: null, at: 0, outcome: 'x', beforeMatch: null, realUntouched: null }).length === 0 && /NOT/.test(opAfterFacts({ status: 'done', step: null, at: 0, outcome: null, beforeMatch: false, realUntouched: false })[0]), 'an operation\'s words; nothing is said about untouched files unless the gym said so, and a mismatch is said loudly')
  assert((Object.keys(GYM_RUN_COPY) as (keyof typeof GYM_RUN_COPY)[]).every((k) => GYM_RUN_COPY[k].length > 0) && refusalWords('constructor').startsWith('The gym refused (constructor)') && runWords({ kind: 'plan-refused', refusal: 'memory_floor' } as GymRunResult).includes('Nothing was changed') && GYM_CONTROL_COPY.badToken.length > 0, 'every result has words; a refusal Beacon has no words for is shown as the identifier it is, and one that spells a table key is not looked up')

  // ── 7. which buttons ───────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const p = parseGymStatus(promoted)?.promotion ?? null
    const base = { role: 'owner' as const, configured: true, promotion: p, stale: false, opRunning: false, waiting: false }
    const v = controlView(base)
    assert(p !== null && p.candidates.join() === 'rehearsal_r5_final_q4' && p.state === 'promoted' && p.beforeMatch === true && p.rollbackAvailable === true && v.shown && v.promote.enabled && v.rollback.enabled, 'the promotion section is read from the fixture, and an owner with a configured service and an offered model gets both buttons')
    assert(!controlView({ ...base, role: 'limited' }).shown && !controlView({ ...base, role: null }).shown && controlView({ ...base, role: 'limited' }).setup === GYM_BUTTON_COPY.notOwner && !controlView({ ...base, configured: false }).shown, 'no buttons for a device that is not the owner (or whose role is not known), or with no control service set up')
    const stale = controlView({ ...base, stale: true })
    assert(!stale.promote.enabled && stale.promote.why === GYM_BUTTON_COPY.stale && stale.rollback.enabled, 'an old status disables Promote (it decides on what is serving now) but never Roll back (the gym may be why it is old)')
    const running = controlView({ ...base, opRunning: true })
    const rolling = controlView({ ...base, promotion: p && { ...p, state: 'rolling_back' } })
    const waiting = controlView({ ...base, waiting: true })
    assert(!running.promote.enabled && !running.rollback.enabled && !rolling.promote.enabled && !rolling.rollback.enabled && !waiting.promote.enabled && !waiting.rollback.enabled, 'while an operation is running or an answer is awaited, neither button can be pressed')
    const none = controlView({ ...base, promotion: p && { ...p, candidates: [] } })
    const nostatus = controlView({ ...base, promotion: null })
    assert(!none.promote.enabled && none.promote.why === GYM_BUTTON_COPY.noCandidates && !nostatus.promote.enabled && nostatus.rollback.enabled, 'with no model on offer, or no promotion section, Promote is off and says why; Roll back is not')
    const sentences = parseGymStatus({ ...promoted, promotion: { ...promoted.promotion, state: 'please promote now', candidates: ['ok_one', 'two words', 'a'.repeat(60)], steps: [{ id: 'free text here', status: 'done' }] } })?.promotion
    assert(sentences?.state === 'unknown' && sentences.candidates.join() === 'ok_one' && sentences.steps.length === 0, 'the promotion section holds no sentence: a state, model or step that is not an identifier is dropped')
  }

  {
    const pr = parseGymStatus(promoted)?.promotion ?? null
    const facts = pr ? promotionFacts(pr, () => 'then') : []
    const f = (l: string): string => facts.find((x) => x.label === l)?.text ?? ''
    assert(pr !== null && pr.rehearsal === true && pr.action === 'promote' && pr.target === 'rehearsal_instance' && pr.student?.unit === 'active' && pr.student.live && pr.shadow?.agreementK === 96 && pr.shadow.agreementN === 110 && pr.shadow.answerEquivalentK === null && pr.steps[0].at !== null && pr.history[0].action === 'promote' && pr.toolcheck?.advertised === 14 && pr.probe?.ok === true && pr.guard?.belowMb === 2048, 'the promotion section is read under the schema\'s own names: instance, student model, shadow counts, steps with times, newest history first, tool check, probe and memory guard')
    assert(/rehearsal instance/.test(f('Instance')) && /running, answering/.test(f('Student model')) && /agrees with the real one in 96 of 110/.test(f('Shadow')) && !/same answer/.test(f('Shadow')) && f('Tools advertised') === '14' && /passed/.test(f('Probe')) && /9120 MB/.test(f('Memory free')) && f('Promoted').startsWith('ok') && pr !== null && /NOT marked as the rehearsal/.test(promotionFacts({ ...pr, rehearsal: false }, () => 't').find((x) => x.label === 'Instance')?.text ?? ''), 'its facts are said in Beacon\'s words, only what the gym reported (a null pair is left out), and an instance not marked as the rehearsal one is said loudly')
    const loud = parseGymStatus({ ...promoted, promotion: { ...promoted.promotion, target: [100, 64, 0, 7].join('.'), student: { unit: 'please trust me', live: true }, probe: { ...promoted.promotion.probe, why: 'a sentence with spaces' }, history: [{ action: 'sing', outcome: 'free text outcome', at: null }, { action: 'rollback', outcome: 'ok', at: null }] } })?.promotion
    assert(loud?.target === null && loud.student?.unit === 'unknown' && loud.probe?.why === null && loud.history.length === 1 && loud.history[0].outcome === 'ok', 'the section holds no free text and no address: a target that is an address, an unlisted unit, a probe reason or outcome that is not an identifier, is dropped or read as unknown')
  }

  // ── 8. the shape of the code ───────────────────────────────────────────────────────────────────────────────────────────
  {
    const src = (p: string): string => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    const control = src('src/main/gym-control.ts')
    const ipcSrc = src('src/main/gym-control-ipc.ts')
    const dialogSrc = src('src/main/gym-control-dialog.ts')
    const indexSrc = src('src/main/index.ts')
    const preload = src('src/preload/index.ts')
    const readSide = ['src/main/gym-transport.ts', 'src/main/gym-status.ts', 'src/main/gym-ipc.ts', 'src/shared/gym.ts'].map(src).join('\n')
    const applies = control.match(/GYM_CONTROL_PATHS\.apply/g) ?? []
    assert(applies.length === 1 && !/\bapply\b/i.test(ipcSrc.replace(/registerGymControl/g, '')) && !/plan_id|plan_hash|planId|planHash/.test(ipcSrc + preload.slice(preload.indexOf('gymControl:'), preload.indexOf('gymControl:') + 600)), 'the apply path is used in one place in main; the IPC and the preload have no way to name a plan, a hash or an apply')
    assert(/answered = await Promise\.race\(\[this\.deps\.confirm\(/.test(control) && /const go = answered/.test(control) && control.indexOf('this.deps.confirm(') < control.indexOf('GYM_CONTROL_PATHS.apply') && /if \(!go\) return \{ kind: 'cancelled' \}/.test(control), 'the apply comes after the confirmation in the code, and only past `if (!go)`')
    assert(/buttons: \['Cancel', c\.button\]/.test(dialogSrc) && /defaultId: 0/.test(dialogSrc) && /cancelId: 0/.test(dialogSrc) && /return r\.response === 1/.test(dialogSrc) && /catch \{\s*return false/.test(dialogSrc), 'the confirmation is the OS\'s: Cancel is first, the default and what Escape does; only the second button says yes; a dialog that fails says no')
    assert(/gym-control\.key/.test(indexSrc) && !/setSetting\([^)]*[Tt]oken/.test(indexSrc.slice(indexSrc.indexOf('gymControlTokenStore'), indexSrc.indexOf('registerNetworkSettingHandlers('))) && /isOwner: \(\) => connection\?\.getStatus\(\)\.role === 'owner'/.test(indexSrc) && /allowLoopback: debuggingAllowedHere\(\)/.test(indexSrc), 'main keeps the write token in a key file of its own, sealed by the OS keychain, never a setting; owner means a role Beacon read, not one it guessed; loopback only in a build that may be debugged')
    assert(!/gym-control|GymControl|gymControl/.test(readSide) && (src('src/main/gym-transport.ts').match(/method: '[A-Z]+'/g) ?? []).join() === "method: 'GET'", 'the read side does not know the control side exists, and still only GETs')
    const card = src('src/renderer/src/components/GymControlCard.tsx')
    const used = [...new Set(card.match(/\bgymControl\.[a-zA-Z]+/g) ?? [])].sort().join()
    assert(used === 'gymControl.op,gymControl.run,gymControl.setAddress,gymControl.setToken,gymControl.settings' && !/fetch\(|plan_id|plan_hash|planId|planHash|\/v1\//.test(card) && /type="password"/.test(card) && /import \{ GymControlCard \}/.test(src('src/renderer/src/components/GymPanel.tsx')), 'the card only asks (run, op and the settings): it holds no plan, hash or address of the service, and the token field hides what is typed', used)
    assert(!/console\.(log|warn|error|info|debug)/.test(control + ipcSrc + dialogSrc + src('src/shared/gym-control.ts')), 'no control file writes to a log, so none can write the token or a plan to one')
  }
}

void main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
