/**
 * Approve-join smoke (headless / ELECTRON_RUN_AS_NODE) — v0.4.0 onboarding, O5: the "Approve new device?" side, in a Beacon that is
 * already connected as its owner (docs/PAIRING-APPROVAL-API.md on Prometheus #697/#698, 4.2b and 5.1).
 *
 * What it holds to account:
 *   * the list a real daemon gave (11 exchanges recorded from the real #698 app) and the frames the contract describes are read
 *     field by field; a hostile or malformed entry is skipped, never shown half-formed;
 *   * the four digits an owner types are checked here AND by the daemon; the code the daemon lists is never passed to the page, so a
 *     blind tap cannot approve;
 *   * a Beacon that is a scoped device (a 403) never shows a prompt and stops asking;
 *   * pairing frames never go to the activity feed (they carry an address and a device name);
 *   * the outcomes of approve and deny, by the daemon's own status codes.
 * What it cannot prove: a real WebSocket frame (the daemon's PR 3 does not exist yet; the frame tests use the contract's shape).
 */
import { readFileSync } from 'node:fs'
import { checkApproveRequest, decideOutcome, pairingPollMs, parseFrame, parseRequestList, platformLabel, type DecideOutcome, type WaitingRequest } from '@shared/join-owner'
import { PairingWatcher, type WatcherDeps } from './pairing/watcher'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[approve-join-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 44
const tryRun = <T>(f: () => T): T | 'threw' => {
  try {
    return f()
  } catch {
    return 'threw'
  }
}

interface Wire {
  name: string
  request: { method: string; path: string; body: unknown }
  response: { status: number; date: string | null; body: unknown }
}
const W = JSON.parse(readFileSync('src/main/fixtures/pairing_owner_wire_698.json', 'utf8')) as { exchanges: Wire[] }
const wire = (name: string): Wire => {
  const w = W.exchanges.find((e) => e.name === name)
  if (!w) throw new Error(`no recorded exchange named ${name}`)
  return w
}
const serverNow = (w: Wire): number => Date.parse(w.response.date ?? '') / 1000
const listOf = (name: string): ReturnType<typeof parseRequestList> | 'threw' => {
  const w = wire(name)
  return tryRun(() => parseRequestList(w.response.status, w.response.body, serverNow(w), serverNow(w) * 1000))
}
const RID = 'c3f1a9e07b2d4a6831ff09aa5e2b7c44'

// ── words for a platform ──────────────────────────────────────────────────────────────────────────
const sameSecond = {
  requests: [3, 2, 1].map((n) => ({ request_id: n.toString(16).padStart(32, '0'), device_name: `Device ${n}`, platform: 'macos', source_ip: '10.0.0.1', created_at: 1_760_000_000, expires_at: 1_760_000_300, ttl_seconds: 300 })).concat([{ request_id: (9).toString(16).padStart(32, '0'), device_name: 'Earlier', platform: 'macos', source_ip: '10.0.0.1', created_at: 1_759_999_990, expires_at: 1_760_000_290, ttl_seconds: 300 }])
}
const ordered = tryRun(() => parseRequestList(200, sameSecond, 1_760_000_100, 0))
assert(ordered !== 'threw' && ordered.kind === 'ok' && ordered.requests.map((r) => r.deviceName).join() === 'Earlier,Device 1,Device 2,Device 3', 'list: the one that has waited longest comes first; requests made in the same second keep the order they were made in (the daemon lists the newest first, so that list is read backwards)', JSON.stringify(ordered).slice(0, 120))
assert(platformLabel('macos') === 'Mac' && platformLabel('ios') === 'iPhone or iPad' && platformLabel('windows') === 'Windows PC' && platformLabel('linux') === 'Linux computer' && platformLabel('android') === 'Android phone' && platformLabel('other') === 'device' && platformLabel('<script>') === 'device' && platformLabel(42) === 'device', 'platform: the six the daemon knows get plain names; anything else is just "device", and a daemon\'s own text is never echoed')

// ── the list a REAL daemon gave ───────────────────────────────────────────────────────────────────
const four = listOf('list_pending_four')
assert(four !== 'threw' && four.kind === 'ok' && four.requests.length === 4 && four.requests.every((r) => /^[0-9a-f]{32}$/.test(r.requestId) && r.sourceIp === '127.0.0.1' && r.deviceName.length > 0), 'real wire: the owner\'s list of four open requests is read, each with its id, name and where it came from', JSON.stringify(four).slice(0, 200))
const fourNow = serverNow(wire('list_pending_four')) * 1000
assert(four !== 'threw' && four.kind === 'ok' && four.requests.every((r) => r.deadlineMs > fourNow && r.deadlineMs <= fourNow + 300_000) && four.requests.map((r) => r.createdAt).every((d, i, all) => i === 0 || all[i - 1] <= d), 'real wire: each request\'s time left comes from the daemon\'s own clock (its Date header), within the five minutes a request lasts')
assert(four !== 'threw' && four.kind === 'ok' && !/match|code/i.test(Object.keys(four.requests[0]).join()) && !/match|code/i.test(JSON.stringify(four.requests)), 'real wire: the code the daemon lists for its owner is NOT passed on (nothing the page receives contains it, so approving takes typing it from the new device)')
const kind = (n: string): string => {
  const r = listOf(n)
  return r === 'threw' ? 'threw' : r.kind === 'ok' ? `ok:${r.requests.length}` : r.kind
}
assert(kind('list_pending_after_decisions_empty') === 'ok:0' && kind('list_after_cancel_only_r1_remains') === 'ok:1' && kind('list_no_token') === 'signed-out' && kind('dead_token_list') === 'signed-out' && kind('scoped_list') === 'not-owner', 'real wire: an empty list, a one-request list, a missing or dead token (401: signed out) and a scoped device (403: not an owner) each read as themselves')
const hostile = {
  requests: [
    { request_id: 'not-an-id', device_name: 'A', platform: 'macos', source_ip: '1.2.3.4', created_at: 1, expires_at: 1760000300, ttl_seconds: 300 },
    { request_id: RID, device_name: 'Line' + String.fromCharCode(10) + 'break', platform: 'macos', source_ip: '1.2.3.4', created_at: 1, expires_at: 1760000300, ttl_seconds: 300 },
    { request_id: RID.replace(/.$/, '1'), device_name: 'Fine', platform: 'macos', source_ip: 'x'.repeat(200), created_at: 1, expires_at: 1760000300, ttl_seconds: 300 },
    { request_id: RID.replace(/.$/, '2'), device_name: 'Fine', platform: 'macos', source_ip: '1.2.3.4', created_at: 1, expires_at: 'soon', ttl_seconds: 300 },
    { request_id: RID.replace(/.$/, '3'), device_name: 'Over', platform: 'macos', source_ip: '1.2.3.4', created_at: 1, expires_at: 1759999000, ttl_seconds: 300 },
    'text',
    null,
    { request_id: RID.replace(/.$/, '4'), device_name: 'Good one', platform: 'ios', source_ip: '192.168.1.42', created_at: 1760000000, expires_at: 1760000300, ttl_seconds: 300 }
  ]
}
const hl = tryRun(() => parseRequestList(200, hostile, 1760000100, 5_000_000))
assert(hl !== 'threw' && hl.kind === 'ok' && hl.requests.length === 1 && hl.requests[0].deviceName === 'Good one' && hl.requests[0].platform === 'iPhone or iPad' && hl.requests[0].sourceIp === '192.168.1.42' && hl.requests[0].deadlineMs === 5_000_000 + 200_000, 'list: entries with a bad id, a name with a line break, an oversize source, no end time, nothing left, or no object at all are skipped; the good one has 200 seconds left', JSON.stringify(hl).slice(0, 220))
const many = { requests: Array.from({ length: 40 }, (_, i) => ({ request_id: i.toString(16).padStart(32, '0'), device_name: `D${i}`, platform: 'macos', source_ip: '10.0.0.1', created_at: 1, expires_at: 1760000300, ttl_seconds: 300 })) }
const ml = tryRun(() => parseRequestList(200, many, 1760000100, 0))
assert(ml !== 'threw' && ml.kind === 'ok' && ml.requests.length === 20 && kind('list_pending_four') === 'ok:4' && JSON.stringify(tryRun(() => parseRequestList(200, { nope: 1 }, null, 0))) === '{"kind":"failed"}' && JSON.stringify(tryRun(() => parseRequestList(500, null, null, 0))) === '{"kind":"failed"}' && JSON.stringify(tryRun(() => parseRequestList(0, null, null, 0))) === '{"kind":"failed"}', 'list: at most twenty are kept, and a body that is not a list, a server error or no answer is "failed"')
const noDate = tryRun(() => parseRequestList(200, hostile, null, 1760000100 * 1000))
assert(noDate !== 'threw' && noDate.kind === 'ok' && noDate.requests.length === 1 && noDate.requests[0].deadlineMs === 1760000100 * 1000 + 200_000, 'list: with no clock from the daemon, this Mac\'s own clock is used')

// ── the frames the contract describes (no real frame exists yet: PR 3 of the pairing work) ────────
const pendingPayload = { request_id: RID, device_name: "Sam's MacBook", platform: 'macos', source_ip: '192.168.1.42', match_code: '4821', created_at: 1760000000, expires_at: 1760000300, ttl_seconds: 300 }
const fp = tryRun(() => parseFrame('pairing_pending', pendingPayload, 1760000040.5, 7_000_000))
assert(fp !== 'threw' && fp !== null && fp.kind === 'pending' && fp.request.requestId === RID && fp.request.deviceName === "Sam's MacBook" && fp.request.platform === 'Mac' && fp.request.deadlineMs === 7_000_000 + 259_500 && !/match|4821/.test(JSON.stringify(fp)), 'frame: a pairing_pending is read; the time left is its end time minus the frame\'s own timestamp (both the daemon\'s clock); the code in it is dropped')
const fr = tryRun(() => parseFrame('pairing_resolved', { request_id: RID, resolution: 'approved', by: 'telegram', resolved_at: 1760000042 }, 1760000042, 0))
assert(fr !== 'threw' && fr !== null && fr.kind === 'resolved' && fr.requestId === RID && fr.resolution === 'approved' && tryRun(() => parseFrame('pairing_resolved', { request_id: RID, resolution: 'exploded' }, 1, 0)) === null && tryRun(() => parseFrame('pairing_pending', { ...pendingPayload, request_id: 'x' }, 1, 0)) === null && tryRun(() => parseFrame('chat_delta', pendingPayload, 1, 0)) === null && tryRun(() => parseFrame('pairing_pending', null, 1, 0)) === null, 'frame: a pairing_resolved is read (approved, denied, expired or canceled only); a bad id, an unknown resolution, another kind of frame or no payload is nothing')
const nots = tryRun(() => parseFrame('pairing_pending', pendingPayload, undefined, 1760000000 * 1000))
assert(nots !== 'threw' && nots !== null && nots.kind === 'pending' && nots.request.deadlineMs === 1760000000 * 1000 + 300_000, 'frame: with no timestamp, this Mac\'s clock is used')

// ── the answers to approve and deny ───────────────────────────────────────────────────────────────
const dec = (n: number): string => tryRun(() => decideOutcome(n)) as string
assert(dec(200) === 'ok' && dec(422) === 'wrong-code' && dec(409) === 'handled' && dec(410) === 'expired' && dec(404) === 'gone' && dec(403) === 'not-owner' && dec(401) === 'signed-out' && dec(400) === 'refused' && dec(500) === 'refused' && dec(0) === 'lost', 'decide: 200 ok, 422 wrong code, 409 already handled, 410 expired, 404 gone, 403 not an owner, 401 signed out, anything else refused, and no answer is lost')
const expected: Record<string, string> = { approve_wrong_match_code: 'wrong-code', approve_unknown_key_owner_true: 'refused', approve_Ra_right_code_and_rename: 'ok', approve_Ra_twice_409: 'handled', deny_Rd: 'ok', deny_Rd_twice_409: 'handled', slow_approve_A_after_ttl_410: 'expired', approve_unknown_id: 'gone', deny_unknown_id: 'gone', approve_no_token: 'signed-out', scoped_approve: 'not-owner', scoped_deny: 'not-owner' }
const wrongOnes = Object.entries(expected).filter(([n, want]) => dec(wire(n).response.status) !== want).map(([n]) => n)
assert(wrongOnes.length === 0 && Object.keys(expected).length === 12, 'real wire: the twelve real approve and deny answers recorded (right and wrong code, twice, after the end time, unknown, no token, a scoped device) each map to the outcome the screen needs', wrongOnes.join())
const ar = (o: unknown): string => JSON.stringify(tryRun(() => checkApproveRequest(o)))
assert(ar({ requestId: RID, code: '4821' }) === JSON.stringify({ requestId: RID, code: '4821' }) && ar({ requestId: RID, code: '0001', name: "Sam's Mac (kitchen)", extra: 1 }) === JSON.stringify({ requestId: RID, code: '0001', name: "Sam's Mac (kitchen)" }), 'ipc: an id, four digits and optionally a new name pass, and nothing else on the object is kept')
assert(['482', '48210', '48 1', 'abcd', 4821, null, ''].every((c) => ar({ requestId: RID, code: c }) === 'null') && ['x', RID.toUpperCase(), null, 5].every((i) => ar({ requestId: i, code: '4821' }) === 'null') && ar({ requestId: RID, code: '4821', name: 'a' + String.fromCharCode(10) + 'b' }) === 'null' && ar(null) === 'null' && ar([RID]) === 'null', 'ipc: a code that is not exactly four digits, a bad id, a name with a line break, or no object at all is refused before anything is sent')

// ── the REAL frames a daemon sent (Prometheus #699, recorded by scripts/record-pairing-frames.mjs) ──
interface RecordedFrame {
  type: string
  timestamp: number
  recvAtMs: number
  payload: Record<string, unknown>
}
const FR = JSON.parse(readFileSync('src/main/fixtures/pairing_frames_699.json', 'utf8')) as {
  requests: Record<string, string>
  sockets: { ownerA: { frames: RecordedFrame[] }; ownerBLate: { frames: RecordedFrame[] }; scoped: { allTypes: string[]; pairing: RecordedFrame[] }; ownerC: { frames: RecordedFrame[]; requestId: string } }
}
const parsedAll = (frames: RecordedFrame[]): Array<ReturnType<typeof parseFrame>> => frames.map((f) => tryRun(() => parseFrame(f.type, f.payload, f.timestamp, f.recvAtMs)) as ReturnType<typeof parseFrame>)
const everyFrame = [...FR.sockets.ownerA.frames, ...FR.sockets.ownerBLate.frames, ...FR.sockets.ownerC.frames]
const pending = parsedAll(everyFrame).flatMap((p, i) => (p && p.kind === 'pending' ? [{ p, f: everyFrame[i] }] : []))
assert(parsedAll(everyFrame).every((p) => p !== null) && everyFrame.length >= 20 && pending.length >= 10 && pending.every(({ p, f }) => Math.abs(p.request.deadlineMs - (f.recvAtMs + (Number(f.payload.expires_at) - f.timestamp) * 1000)) < 1500 && p.request.deadlineMs > f.recvAtMs) && !/match|\d{4}"/.test(JSON.stringify(pending.map((x) => x.p))), `real frames: every one of the ${everyFrame.length} frames a real daemon sent (live, late-connect backfill and an expiry) is read, each pending one has its time left from the frame's own timestamp, and none carries the four digits onward`)
const late = FR.sockets.ownerBLate.frames.filter((f) => f.type === 'pairing_pending').slice(0, 3)
const lateLeft = late.map((f) => Number(f.payload.expires_at) - f.timestamp)
assert(late.length === 3 && late.map((f) => f.payload.device_name).join() === 'Alpha Laptop,Beta Phone,Gamma Tablet' && lateLeft[0] < lateLeft[1] && lateLeft[1] < lateLeft[2] && lateLeft.every((n) => n > 290 && n <= 300), 'real frames: a socket that connects late is backfilled oldest first, and each backfilled frame\'s own timestamp gives the request less time than the next (the timestamp is the time of SENDING, as Beacon assumes)', lateLeft.join())
const resolutions = new Set(parsedAll(everyFrame).flatMap((p, i) => (p && p.kind === 'resolved' ? [`${p.resolution}/${everyFrame[i].payload.by}`] : [])))
assert(['approved/beacon', 'denied/beacon', 'canceled/requester', 'approved/cli', 'expired/system'].every((k) => resolutions.has(k)), 'real frames: approved, denied, canceled by the new device, approved in the terminal and expired by the daemon each arrive as a pairing_resolved and are read', [...resolutions].join())
assert(FR.sockets.scoped.allTypes.join() === 'connected' && FR.sockets.scoped.pairing.length === 0, 'real frames: a scoped device\'s socket, connected the whole time, was sent no pairing frame at all')
const replay = (frames: RecordedFrame[]): { shown: string[][]; end: number; w: PairingWatcher } => {
  const clock = { ms: frames[0].recvAtMs }
  const shown: string[][] = []
  const w = new PairingWatcher({ list: async () => 'unreachable', decide: async () => 'unreachable', now: () => clock.ms, schedule: () => () => undefined, publish: (r) => shown.push(r.map((x) => x.deviceName)) })
  for (const f of frames) {
    clock.ms = f.recvAtMs
    w.takesFrame(f.type, f.payload, f.timestamp)
  }
  return { shown, end: w.current().length, w }
}
const repA = replay(FR.sockets.ownerA.frames)
assert(repA.shown[2]?.join() === 'Alpha Laptop,Beta Phone,Gamma Tablet' && repA.end === 0, 'real frames: fed to the watcher in order, three waiting devices appear oldest first and every decision (approved, denied, canceled by the device, approved in the terminal) takes its request away again', JSON.stringify(repA.shown.slice(0, 4)))
const repC = replay(FR.sockets.ownerC.frames)
assert(repC.shown.length === 2 && repC.shown[0].join() === 'Epsilon Watch' && repC.end === 0, 'real frames: a request that runs out of time is shown, then taken away by the daemon\'s own expiry frame')
const doubled = replay([...FR.sockets.ownerBLate.frames.slice(0, 3), ...FR.sockets.ownerBLate.frames.slice(0, 3)])
assert(doubled.shown.length === 3 && doubled.end === 3, 'real frames: a pairing_pending that arrives twice (the backfill and the live frame, which the daemon warns can happen) is one request', JSON.stringify(doubled.shown))

// ── how often to ask (probe-only: a release build always asks every three seconds) ────────────────
const pm = (raw: string | undefined, allowed: boolean): number | null => tryRun(() => pairingPollMs({ BEACON_PAIRING_POLL: raw }, allowed)) as number | null
assert(pm(undefined, true) === 3000 && pm('off', true) === null && pm('600', true) === 600 && pm('off', false) === 3000 && pm('600', false) === 3000 && pm('5', true) === 3000 && pm('99999999', true) === 3000 && pm('abc', true) === 3000 && pm('', true) === 3000, 'poll override: a dev or probe build may turn asking off (frames only) or change it between 200 ms and ten minutes; a release build, a bad number or nothing at all means every three seconds')
const pOff = (() => {
  const delays: number[] = []
  const w = new PairingWatcher({ list: async () => 'unreachable', decide: async () => 'unreachable', now: () => 0, schedule: (_f, ms) => (delays.push(ms), () => undefined), publish: () => undefined, pollMs: null })
  w.start()
  return { delays, w }
})()
assert(pOff.delays.length === 0 && pOff.w.takesFrame('pairing_pending', { ...pendingPayload, request_id: (5).toString(16).padStart(32, '0') }, 1_760_000_000) === true && pOff.w.current().length === 1, 'poll override: with asking turned off the watcher schedules nothing and still takes frames')

// ── the watcher, with a fake daemon and a clock we turn by hand ───────────────────────────────────
interface Rig {
  w: PairingWatcher
  published: WaitingRequest[][]
  calls: Array<{ id: string; verb: string; body?: Record<string, unknown> }>
  delays: number[]
  list: Array<{ status: number; body: unknown; serverNowSec: number | null } | 'unreachable'>
  answer: Array<{ status: number } | 'unreachable'>
  clock: { ms: number }
  fire: () => Promise<void>
  cancelled: () => number
}
function rig(): Rig {
  const published: WaitingRequest[][] = []
  const calls: Rig['calls'] = []
  const delays: number[] = []
  const list: Rig['list'] = []
  const answer: Rig['answer'] = []
  const clock = { ms: 1_760_000_000_000 }
  let next: (() => void) | null = null
  let cancelled = 0
  const deps: WatcherDeps = {
    list: async () => list.shift() ?? 'unreachable',
    decide: async (id, verb, body) => {
      calls.push({ id, verb, body })
      return answer.shift() ?? 'unreachable'
    },
    now: () => clock.ms,
    schedule: (fn, ms) => {
      delays.push(ms)
      next = fn
      return () => {
        cancelled++
        if (next === fn) next = null
      }
    },
    publish: (r) => published.push(r)
  }
  const w = new PairingWatcher(deps)
  return {
    w, published, calls, delays, list, answer, clock,
    fire: async () => {
      const f = next
      next = null
      if (f) {
        f()
        await new Promise((r) => setTimeout(r, 5))
      }
    },
    cancelled: () => cancelled
  }
}
const item = (n: number, remaining = 300): Record<string, unknown> => ({ request_id: n.toString(16).padStart(32, '0'), device_name: `Device ${n}`, platform: 'macos', source_ip: '192.168.1.2', created_at: 1, expires_at: 1_760_000_000 + remaining, ttl_seconds: 300 })
const ok = (...items: Array<Record<string, unknown>>): { status: number; body: unknown; serverNowSec: number } => ({ status: 200, body: { requests: items }, serverNowSec: 1_760_000_000 })
const id = (n: number): string => n.toString(16).padStart(32, '0')

async function scenarios(): Promise<void> {
const r1 = rig()
r1.list.push(ok(item(2), item(1)), ok(item(2), item(1))) // the daemon lists the newest first
r1.w.start()
await r1.fire()
await r1.fire()
assert(r1.published.length === 1 && r1.published[0].length === 2 && r1.w.current().map((r) => r.requestId).join() === `${id(1)},${id(2)}` && r1.delays.join() === '0,3000,3000', 'watcher: it asks at once and then every three seconds, shows who is waiting (oldest first), and says nothing when nothing has changed')

const r2 = rig()
r2.list.push({ status: 403, body: { error: 'operator_only' }, serverNowSec: 1_760_000_000 })
r2.w.start()
await r2.fire()
const after403 = r2.delays.length
await r2.fire()
assert(r2.published.length === 0 && r2.w.current().length === 0 && r2.delays.length === after403, 'watcher: a Beacon that is a scoped device (403) shows nothing and stops asking')
r2.list.push(ok(item(1)))
r2.w.reset()
r2.w.start()
await r2.fire()
assert(r2.w.current().length === 1, 'watcher: after the connection changes (reset), it asks again, so a Beacon that became an owner is noticed')

const r3 = rig()
r3.list.push({ status: 401, body: null, serverNowSec: 1_760_000_000 })
r3.w.start()
await r3.fire()
const after401 = r3.delays.length
await r3.fire()
assert(r3.delays.length === after401 && r3.w.current().length === 0, 'watcher: signed out (401) also stops it asking (the connection\'s own banner says so)')

const r4 = rig()
r4.w.start()
for (let i = 0; i < 5; i++) await r4.fire()
assert(r4.delays.join() === '0,3000,3000,15000,15000,15000', 'watcher: a daemon that does not answer is asked less and less often (three seconds, then fifteen after three misses), never given up on', r4.delays.join())

const r5 = rig()
r5.list.push(ok(item(1)))
r5.w.start()
await r5.fire()
const taken = [r5.w.takesFrame('pairing_pending', { ...pendingPayload, request_id: id(2) }, 1_760_000_000), r5.w.takesFrame('pairing_pending', { ...pendingPayload, request_id: id(2) }, 1_760_000_000), r5.w.takesFrame('pairing_resolved', { request_id: id(1), resolution: 'denied' }, 1_760_000_001), r5.w.takesFrame('pairing_resolved', { request_id: id(9), resolution: 'denied' }, 1_760_000_001)]
assert(taken.every(Boolean) && r5.w.current().map((r) => r.requestId).join() === id(2) && r5.published.length === 3, 'watcher: a pairing_pending adds a request at once (twice is once), a pairing_resolved removes it, and one for a request never seen changes nothing')
assert(r5.w.takesFrame('chat_delta', {}, 1) === false && r5.w.takesFrame('agent_state', {}, 1) === false && r5.w.takesFrame('pairing_pending', null, 1) === true && r5.w.takesFrame(undefined, {}, 1) === false, 'watcher: it takes pairing frames, even a malformed one (they must never reach the activity feed), and no others')

const r6 = rig()
r6.list.push(ok(item(1), item(2)), ok(item(2)))
r6.w.start()
await r6.fire()
await r6.fire()
assert(r6.w.current().map((r) => r.requestId).join() === id(2), 'watcher: the daemon\'s list is the authority: a request it no longer lists is gone')

const r7 = rig()
r7.list.push(ok(item(1, 30), item(2, 300)))
r7.w.start()
await r7.fire()
r7.clock.ms += 31_000
assert(r7.w.current().map((r) => r.requestId).join() === id(2), 'watcher: a request past its end time is no longer offered')

const r8 = rig()
r8.list.push(ok(item(1)))
r8.w.start()
await r8.fire()
r8.answer.push({ status: 200 })
const o1 = await r8.w.approve({ requestId: id(1), code: '4821' })
assert(o1 === 'ok' && r8.calls.length === 1 && r8.calls[0].id === id(1) && r8.calls[0].verb === 'approve' && JSON.stringify(r8.calls[0].body) === '{"match_code":"4821"}' && r8.w.current().length === 0, 'watcher: approving sends the four digits typed (and nothing else) and the request is gone')
r8.list.push(ok(item(3)))
await r8.fire()
r8.answer.push({ status: 200 })
await r8.w.approve({ requestId: id(3), code: '0007', name: 'Kitchen Mac' })
assert(JSON.stringify(r8.calls[1].body) === '{"match_code":"0007","name":"Kitchen Mac"}', 'watcher: a new name goes with it, and no other key is ever sent (the daemon refuses any other)')
const bad = await r8.w.approve({ requestId: id(3), code: '12' })
assert(bad === 'refused' && r8.calls.length === 2, 'watcher: a code that is not four digits is refused here, without asking the daemon')

const outcomes: Array<[string, { status: number } | 'unreachable', DecideOutcome, boolean]> = [['wrong code', { status: 422 }, 'wrong-code', true], ['already handled', { status: 409 }, 'handled', false], ['expired', { status: 410 }, 'expired', false], ['gone', { status: 404 }, 'gone', false], ['lost', 'unreachable', 'lost', true]]
const results: string[] = []
for (const [label, ans, want, stays] of outcomes) {
  const r = rig()
  r.list.push(ok(item(1)))
  r.w.start()
  await r.fire()
  r.answer.push(ans)
  const got = await r.w.approve({ requestId: id(1), code: '4821' })
  if (got !== want || (r.w.current().length === 1) !== stays) results.push(label)
}
assert(results.length === 0, 'watcher: a wrong code or no answer leaves the request to try again; already handled, expired or gone takes it away', results.join())
const r9 = rig()
r9.list.push(ok(item(1)))
r9.w.start()
await r9.fire()
r9.answer.push({ status: 200 })
const d1 = await r9.w.deny(id(1))
assert(d1 === 'ok' && r9.calls[0].verb === 'deny' && r9.calls[0].body === undefined && r9.w.current().length === 0, 'watcher: denying asks to deny, with no body, and the request is gone')
const r9b = rig()
const denyBad = [await r9b.w.deny('x'), await r9b.w.deny(id(10).toUpperCase()), await r9b.w.deny(undefined as unknown as string)]
assert(denyBad.every((o) => o === 'refused') && r9b.calls.length === 0, 'watcher: denying something that is not a request id is refused here, without asking the daemon')
const r10 = rig()
r10.list.push(ok(item(1)))
r10.w.start()
await r10.fire()
r10.w.reset()
assert(r10.w.current().length === 0 && r10.published[r10.published.length - 1].length === 0, 'watcher: reset forgets everyone, and says so')

// ── nothing is kept, and no frame escapes ────────────────────────────────────────────────────────
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
const watcherSrc = strip(readFileSync('src/main/pairing/watcher.ts', 'utf8'))
assert(!/console\.|writeFile|appendFile|setSetting|localStorage|recordSocketEvent|\.log\(/.test(watcherSrc), 'main: the watcher never logs or stores a device name or an address')
const indexSrc = strip(readFileSync('src/main/index.ts', 'utf8'))
assert(/pollMs:\s*pairingPollMs\(process\.env,\s*debuggingAllowedHere\(\)\)/.test(indexSrc), 'main: the setting that turns asking off is read with the build flavour (a release build ignores it)')
const handler = /connection\.on\('gatewayEvent',\s*\(ev\)\s*=>\s*\{([\s\S]*?)\n  \}\)/.exec(indexSrc)?.[1] ?? ''
assert(handler.includes('takesFrame') && handler.indexOf('takesFrame') < handler.indexOf('broadcast(IPC.GATEWAY_EVENT') && /takesFrame[^\n]*\n?[^\n]*return/.test(handler), 'main: the gateway event handler gives a pairing frame to the watcher and RETURNS before the activity feed, the notifier or the tool-approval handler can see it')

}

function finish(): void {
  if (checks !== EXPECTED) {
    console.log(`[approve-join-smoke] INCOMPLETE — ${checks} checks ran, expected ${EXPECTED}`)
    process.exit(1)
  }
  console.log(failures === 0 ? `[approve-join-smoke] OK — ${checks} checks passed` : `[approve-join-smoke] FAIL — ${failures}/${checks} checks failed`)
  process.exit(failures === 0 ? 0 : 1)
}

scenarios().then(finish, (e) => {
  console.log(`[approve-join-smoke] CRASH ${e instanceof Error ? e.stack : String(e)}`)
  process.exit(1)
})
