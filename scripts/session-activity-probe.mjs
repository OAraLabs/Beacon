/**
 * session-activity-probe — the sidebar's per-session working indicator, PAINTED, in the real built
 * app, fed over the REAL WebSocket path.
 *
 * session-activity-smoke proves the reducer against the captured wire. It cannot prove the frames
 * reach it (ws.ts → main → IPC → gateway-store), that the row renders the arc, or that the arc turns
 * per pulse and not on a timer. This does, against a FAKE GATEWAY: a local REST server for
 * /api/sessions and a local WS server pushing daemon-shaped frames. The app is pointed at both with
 * BEACON_GATEWAY_* and runs under its own --user-data-dir, so it never touches the installed
 * Beacon's profile or the real daemon.
 *
 * The scenario, three sessions:
 *   A — thinking, then a progress pulse every second, then chat_done + agent_state{idle}
 *   B — thinking, then silence (the lost-chat_done case): must go STALLED, not spin forever
 *   C — nothing: must show nothing
 *
 * Run: npm run build && npm run probe:session-activity      (~40 s: waits out the stall)
 */
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'

const API_PORT = 8766
const WS_PORT = 8767
const UD = `/tmp/beacon-session-activity-probe-ud-${process.pid}`
const SHOT = process.env.PROBE_SHOT ?? '/tmp/session-activity-probe.png'

const A = `beacon:${randomUUID()}`
const B = `beacon:${randomUUID()}`
const C = `beacon:${randomUUID()}`
const nowS = Date.now() / 1000
const SESSIONS = [
  { session_id: A, title: 'Probe A — finishes', gateway: 'beacon', message_count: 4, created_at: nowS - 60, last_active: nowS - 5 },
  { session_id: B, title: 'Probe B — goes quiet', gateway: 'beacon', message_count: 4, created_at: nowS - 120, last_active: nowS - 10 },
  { session_id: C, title: 'Probe C — idle', gateway: 'beacon', message_count: 4, created_at: nowS - 180, last_active: nowS - 15 }
]

let sessionsServed = 0
const rest = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url === '/api/sessions') {
    sessionsServed += 1
    res.end(JSON.stringify(SESSIONS))
    return
  }
  if (/^\/api\/sessions\/[^/]+\/messages/.test(req.url ?? '')) {
    res.end(JSON.stringify({ watermark: 0, messages: [] }))
    return
  }
  res.statusCode = 404
  res.end('[]')
})
await new Promise((r) => rest.listen(API_PORT, '127.0.0.1', r))

let sock = null
const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' })
wss.on('connection', (s) => {
  sock = s
  s.send(JSON.stringify({ type: 'connected', timestamp: Date.now() / 1000, payload: {} }))
})
// No `timestamp` on turn frames: the store restamps with the client clock anyway, and leaving it
// off means a regression to using ev.ts cannot hide behind a matching server clock.
const push = (type, payload) => sock?.send(JSON.stringify({ type, payload }))

process.env.BEACON_GATEWAY_HOST = '127.0.0.1'
process.env.BEACON_GATEWAY_API_PORT = String(API_PORT)
process.env.BEACON_GATEWAY_WS_PORT = String(WS_PORT)
process.env.BEACON_CDP_ARGS = `${process.env.BEACON_CDP_ARGS ?? ''} --user-data-dir=${UD} --use-mock-keychain`.trim()

const { evaluate, sleep, send, mainLog } = await import('./cdp-harness.mjs')

let failures = 0
let checks = 0
function check(cond, label, detail = '') {
  checks += 1
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures += 1
  }
}

/** Each probe row's indicator, as painted. Rows are found by their title text. */
const read = () =>
  evaluate(`(() => {
    const rows = [...document.querySelectorAll('.session-row')]
    const one = (label) => {
      const row = rows.find((r) => r.textContent.includes(label))
      if (!row) return null
      const ind = row.querySelector('.turn-ind')
      const title = row.querySelector('.session-title')
      const rr = row.getBoundingClientRect()
      if (!ind) return { row: true, ind: null, titleW: title ? title.getBoundingClientRect().width : 0 }
      const r = ind.getBoundingClientRect()
      return {
        row: true,
        ind: {
          cls: ind.className,
          transform: getComputedStyle(ind).transform,
          label: ind.getAttribute('aria-label'),
          w: r.width, h: r.height,
          inside: r.left >= rr.left && r.right <= rr.right && r.top >= rr.top && r.bottom <= rr.bottom
        },
        titleW: title ? title.getBoundingClientRect().width : 0
      }
    }
    return { a: one('Probe A'), b: one('Probe B'), c: one('Probe C') }
  })()`)

// ── wait for the sessions and the socket ──────────────────────────────────────────────────────
// A fresh profile opens on Mission; the session rows live in the Chats view's sidebar. Target the
// rail button by its exact title, and let the loop below prove the navigation took.
let dom = null
for (let i = 0; i < 40; i++) {
  await sleep(500)
  await evaluate(`document.querySelector('button[title="Chats"]')?.click()`)
  dom = await read()
  if (dom?.a && dom?.b && dom?.c && sock) break
}
check(sessionsServed > 0, `the app fetched /api/sessions from the fake gateway (${sessionsServed}×)`)
check(!!sock, 'the app opened the fake WebSocket — frames travel the real ws.ts path')
if (!(dom?.a && dom?.b && dom?.c) || !sock) {
  console.error(`  FATAL: rows or socket never appeared. dom=${JSON.stringify(dom)}`)
  console.error(JSON.stringify(await evaluate(`({ rows: document.querySelectorAll('.session-row').length, nav: [...document.querySelectorAll('button[title]')].map(b=>b.title).slice(0,20), text: document.body.innerText.slice(0,600) })`), null, 1))
  console.error(mainLog.join('').slice(-1500))
  process.exit(1)
}
check(!dom.a.ind && !dom.b.ind && !dom.c.ind, 'before any frame, no row shows an indicator')

// ── A and B start; A pulses ──────────────────────────────────────────────────────────────────
push('agent_state', { state: 'thinking', session_id: A })
push('agent_state', { state: 'thinking', session_id: B })
await sleep(600)
const t0 = await read()
check(t0.a.ind?.cls.includes('is-working'), 'A shows working', JSON.stringify(t0.a.ind))
check(t0.b.ind?.cls.includes('is-working'), 'B shows working — two at once, keyed per session', JSON.stringify(t0.b.ind))
check(!t0.c.ind, 'C (no frames) shows nothing')
check(t0.a.ind?.w > 0 && t0.a.ind?.w <= 14 && t0.a.ind?.inside, `A's arc paints inside its row (${t0.a.ind?.w}px)`)
check(t0.a.titleW > 40, `the title keeps its width beside the arc (${t0.a.titleW}px)`)
check(/Working/.test(t0.a.ind?.label ?? ''), `the arc is labelled for a screen reader ("${t0.a.ind?.label}")`)

for (let i = 0; i < 3; i++) {
  push('agent_progress', { session_id: A, message_id: 'asst-probe', phase: 'thinking', round: 1, chars: 0 })
  await sleep(700)
}
const t1 = await read()
check(t1.a.ind?.transform !== t0.a.ind?.transform, "A's arc TURNED after its pulses", `${t0.a.ind?.transform} → ${t1.a.ind?.transform}`)
check(t1.b.ind?.transform === t0.b.ind?.transform, "B's arc did NOT turn — no pulse, no movement (never a CSS timer)", `${t0.b.ind?.transform} → ${t1.b.ind?.transform}`)

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot?.result?.data) writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'))

// ── A finishes ───────────────────────────────────────────────────────────────────────────────
push('chat_done', { session_id: A, message_id: 'asst-probe', content: 'done' })
push('agent_state', { state: 'idle', session_id: A })
await sleep(600)
const t2 = await read()
check(!t2.a.ind, 'A clears once chat_done + idle land')
check(!!t2.b.ind, "B is unaffected by A's finish")

// ── B goes quiet past the stall threshold (20 s) + the 5 s clock ────────────────────────────
let t3 = null
for (let i = 0; i < 20; i++) {
  await sleep(1500)
  t3 = await read()
  if (t3.b.ind?.cls.includes('is-stalled')) break
}
check(t3?.b.ind?.cls.includes('is-stalled'), 'B goes STALLED after 20 s without a pulse', JSON.stringify(t3?.b.ind))
check(/no pulse/.test(t3?.b.ind?.label ?? ''), `and says why ("${t3?.b.ind?.label}")`)
const shot2 = await send('Page.captureScreenshot', { format: 'png' })
if (shot2?.result?.data) writeFileSync(SHOT.replace(/\.png$/, '-stalled.png'), Buffer.from(shot2.result.data, 'base64'))

const MIN_CHECKS = 15
if (checks < MIN_CHECKS) {
  console.error(`  FAIL only ${checks} checks ran, expected at least ${MIN_CHECKS}`)
  failures += 1
}
rest.close()
wss.close()
console.log(`\n[probe] screenshots: ${SHOT}, ${SHOT.replace(/\.png$/, '-stalled.png')}`)
console.log(`${failures === 0 ? `PASS (${checks} checks)` : `FAIL (${failures})`}\n`)
process.exit(failures === 0 ? 0 : 1)
