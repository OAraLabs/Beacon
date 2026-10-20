/**
 * compaction-line-probe — the inline "Tidying up the conversation…" line (issue 283), PAINTED, in
 * the real built app, fed over the REAL WebSocket path.
 *
 * compaction-status-smoke proves the wire mapping, the rules and the component's markup. It cannot
 * prove ChatShell feeds the frames to the rules, swaps the line into the activity slot, or keeps
 * another conversation's pass out of this one. This does, against a FAKE GATEWAY: a local REST
 * server for /api/sessions and a local WS server pushing daemon-shaped frames, both on ephemeral
 * ports, with the app under its own --user-data-dir, so it never touches the installed Beacon's
 * profile, the real daemon or a port another session holds.
 *
 * The scenario, in session A's chat (B exists only to send frames that must not land):
 *   1. a thinking pulse → the ordinary ActivityLine
 *   2. B starts a pass → nothing changes in A
 *   3. A: start 0/5 → the line, an empty bar, the ActivityLine gone from the slot
 *   4. a pulse → the line's spinner turns, the line stays
 *   5. A: progress 2/5 → the bar at 40%
 *   6. A: done → the line gone, the ActivityLine back, "finished" announced
 *   7. A: start → failed → the plain note, no bar
 *   8. B: failed → nothing new in A
 *
 * Run: npm run build && npm run probe:compaction-line
 */
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'

const UD = `/tmp/beacon-compaction-line-probe-ud-${process.pid}`
const SHOT = process.env.PROBE_SHOT ?? '/tmp/compaction-line-probe.png'

const A = `beacon:${randomUUID()}`
const B = `beacon:${randomUUID()}`
const nowS = Date.now() / 1000
const SESSIONS = [
  { session_id: A, title: 'Probe A — compacts', gateway: 'beacon', message_count: 2, created_at: nowS - 60, last_active: nowS - 5 },
  { session_id: B, title: 'Probe B — elsewhere', gateway: 'beacon', message_count: 2, created_at: nowS - 120, last_active: nowS - 10 }
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
await new Promise((r) => rest.listen(0, '127.0.0.1', r))
const API_PORT = rest.address().port

let sock = null
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
await new Promise((r) => wss.once('listening', r))
const WS_PORT = wss.address().port
wss.on('connection', (s) => {
  sock = s
  s.send(JSON.stringify({ type: 'connected', timestamp: Date.now() / 1000, payload: {} }))
})
const push = (type, payload) => sock?.send(JSON.stringify({ type, timestamp: Date.now() / 1000, payload }))
const pulse = (sid) => push('agent_progress', { session_id: sid, message_id: 'asst-probe', phase: 'thinking', round: 1, chars: 0 })
const compaction = (sid, stage, extra = {}) => push('context_compaction', { session_id: sid, message_id: 'asst-probe', stage, tokens_before: 241427, threshold: 200000, ...extra })

process.env.BEACON_GATEWAY_HOST = '127.0.0.1'
process.env.BEACON_GATEWAY_API_PORT = String(API_PORT)
process.env.BEACON_GATEWAY_WS_PORT = String(WS_PORT)
process.env.BEACON_CDP_ARGS = `${process.env.BEACON_CDP_ARGS ?? ''} --user-data-dir=${UD} --use-mock-keychain`.trim()

const { evaluate, sleep, send, mainLog } = await import('./cdp-harness.mjs')

const MIN_CHECKS = 30
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

/** The chat's activity slot, as painted. */
const read = () =>
  evaluate(`(() => {
    const vis = (el) => !!el && el.getBoundingClientRect().height > 0
    const line = document.querySelector('.compaction-line')
    const failed = document.querySelector('.compaction-failed')
    const bar = document.querySelector('.compaction-bar')
    const fill = document.querySelector('.compaction-bar-fill')
    const spinner = line?.querySelector('.activity-spinner')
    const act = [...document.querySelectorAll('.activity-line')].filter((el) => !el.classList.contains('compaction-line') && !el.classList.contains('compaction-failed'))
    const live = [...document.querySelectorAll('.compaction-live[aria-live="polite"]')].map((el) => el.textContent)
    return {
      line: vis(line) ? line.textContent : null,
      failed: vis(failed) ? failed.textContent : null,
      bar: bar ? { now: bar.getAttribute('aria-valuenow'), cls: bar.className, w: bar.getBoundingClientRect().width } : null,
      fillW: fill ? fill.getBoundingClientRect().width : null,
      spin: spinner ? getComputedStyle(spinner).transform : null,
      activity: act.filter(vis).map((el) => el.textContent),
      live
    }
  })()`)

// ── open A's chat ────────────────────────────────────────────────────────────────────────────
let ready = false
for (let i = 0; i < 40; i++) {
  await sleep(500)
  await evaluate(`document.querySelector('button[title="Chats"]')?.click()`)
  const opened = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.session-row')].find((r) => r.textContent.includes('Probe A'))
    if (!row) return false
    row.click()
    return true
  })()`)
  if (opened && sock) {
    await sleep(800)
    ready = true
    break
  }
}
check(sessionsServed > 0, `the app fetched /api/sessions from the fake gateway (${sessionsServed}×)`)
check(!!sock, 'the app opened the fake WebSocket — frames travel the real ws.ts path')
if (!ready) {
  console.error('  FATAL: the chat never opened')
  console.error(JSON.stringify(await evaluate(`({ text: document.body.innerText.slice(0,600) })`), null, 1))
  console.error(mainLog.join('').slice(-1500))
  process.exit(1)
}

// 1. an ordinary pulse: the ActivityLine, no compaction line
pulse(A)
await sleep(500)
const r1 = await read()
check(r1.activity.length === 1, 'a thinking pulse shows the ordinary ActivityLine in A', JSON.stringify(r1))
check(r1.line === null && r1.failed === null, 'and no compaction line yet', JSON.stringify(r1))
check(r1.live.length === 1 && r1.live[0] === '', 'the compaction live region is mounted and silent', JSON.stringify(r1.live))

// 2. B compacts: A's chat does not change
compaction(B, 'start', { chunks_done: 0, chunks_total: 3 })
await sleep(500)
const r2 = await read()
check(r2.line === null, "B's pass does not show in A's chat", JSON.stringify(r2))
check(r2.activity.length === 1, "A's ActivityLine is untouched by B's pass", JSON.stringify(r2))
check(r2.live[0] === '', 'nothing is announced in A for B', JSON.stringify(r2.live))

// 3. A starts, in a thread long enough to scroll, with the reader parked at the bottom. The line
// mounts with no new message: it must still be in view, not under the fold (found by the live check).
// One message taller than the window, as in the live run. Which node Chromium's scroll anchoring
// picks decides whether the view happens to shift when the line mounts below it; with short
// messages it picked one below the line and "followed" by accident, so the check passed unfixed.
push('chat_message', { session_id: A, message_id: 9000, ordinal: 0, role: 'assistant', created_at: Date.now() / 1000,
  content: 'Filler. ' + 'A long paragraph that makes the thread far taller than the window. '.repeat(160) })
// The live order: the previous turn's chat_done clears the activity slot, then the next turn's pass
// starts, so the line mounts into an EMPTY slot and the thread grows by its height.
push('chat_done', { session_id: A, message_id: 'asst-prev' })
await sleep(3000) // let the previous turn's follow-up renders settle, so a scroll after the mount is the line's own
// Chromium's scroll anchoring sometimes shifts the view when content mounts below the anchor node,
// depending on which node it picked; in the live run it did not, and the line sat clipped for the
// whole pass. Switch it off here so the check measures Beacon's own rule, not that luck.
await evaluate(`document.querySelector('main.messages').style.overflowAnchor = 'none'`)
const geoBefore = await evaluate(`(() => { const sc = document.querySelector('main.messages'); return { top: Math.round(sc.scrollTop), gap: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight), h: sc.scrollHeight } })()`)
compaction(A, 'start', { chunks_done: 0, chunks_total: 5 })
await sleep(800)
const r3 = await read()
check(geoBefore.gap <= 1, `the reader is parked at the bottom when the pass starts (gap ${geoBefore.gap}px)`)
const inView = await evaluate(`(() => {
  const line = document.querySelector('.compaction-line')
  const sc = line?.closest('main')
  if (!line || !sc) return null
  const l = line.getBoundingClientRect(), b = sc.getBoundingClientRect()
  return { lineTop: Math.round(l.top), lineBottom: Math.round(l.bottom), viewTop: Math.round(b.top), viewBottom: Math.round(b.bottom), scrolls: sc.scrollHeight > sc.clientHeight, gap: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight), lineH: Math.round(l.height) }
})()`)
check(inView?.scrolls === true, 'the thread is long enough to scroll (else the next check is vacuous)', JSON.stringify(inView))
check(!!inView && inView.lineBottom <= inView.viewBottom + 1 && inView.lineTop >= inView.viewTop, 'the line is fully in view for a reader at the bottom', JSON.stringify(inView))
check(r3.line?.includes('Tidying up the conversation so we can keep going'), `A's start shows the line ("${r3.line}")`)
check(r3.bar?.now === '0' && r3.bar?.w > 20, `with a drawn, empty bar (valuenow ${r3.bar?.now}, ${r3.bar?.w}px wide)`)
check(r3.fillW === 0, `the fill is empty at 0 of 5 (${r3.fillW}px)`)
check(r3.activity.length === 0, 'the line takes the activity slot: the ActivityLine is not shown beside it', JSON.stringify(r3.activity))
check(/Tidying up/.test(r3.live[0] ?? ''), `the start is announced politely ("${r3.live[0]}")`)

// 4. a pulse during the pass turns the line's spinner and keeps the line
pulse(A)
await sleep(500)
const r4 = await read()
check(r4.line !== null, 'a pulse during the pass leaves the line up')
check(r4.spin !== r3.spin, `the spinner turned with the pulse (${r3.spin} → ${r4.spin})`)

// 5. progress 2/5
compaction(A, 'progress', { progress: 0.4, chunks_done: 2, chunks_total: 5 })
await sleep(700)
const r5 = await read()
check(r5.bar?.now === '40', `progress 2/5 moves the bar to 40 (valuenow ${r5.bar?.now})`)
const ratio = r5.fillW / r5.bar?.w
check(Math.abs(ratio - 0.4) < 0.05, `the painted fill is 40% of the bar (${r5.fillW}/${r5.bar?.w} = ${ratio.toFixed(2)})`)
const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot?.result?.data) writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'))

// 6. done. The daemon's pulse says "compacting" during a pass; the last one seen before done must
// not come back as a stale "Tidying up…" once the line has gone (found by the live check).
push('agent_progress', { session_id: A, message_id: 'asst-probe', phase: 'compacting', round: 1, chars: 0 })
await sleep(400)
compaction(A, 'done', { tokens_after: 112000, duration_ms: 5400 })
await sleep(500)
const r6s = await read()
check(!r6s.activity.some((a) => /Tidying up/.test(a)), 'after done, no stale "Tidying up" ActivityLine from the last compacting pulse', JSON.stringify(r6s.activity))
pulse(A)
await sleep(500)
const r6 = await read()
check(r6.line === null && r6.bar === null, 'done hides the line and the bar', JSON.stringify(r6))
check(r6.failed === null, 'done shows no failure note')
check(r6.activity.length === 1, 'the ActivityLine is back in the slot', JSON.stringify(r6.activity))
check(/Finished/.test(r6.live[0] ?? ''), `the finish is announced ("${r6.live[0]}")`)

// 7. start → failed
compaction(A, 'start')
await sleep(400)
const r7a = await read()
check(r7a.bar?.cls.includes('compaction-bar-indeterminate') && r7a.bar?.now === null, 'a start with no counts draws the indeterminate bar', JSON.stringify(r7a.bar))
compaction(A, 'failed', { reason: 'summarizer timed out', duration_ms: 9000 })
await sleep(500)
const r7 = await read()
check(r7.failed?.startsWith('Couldn’t tidy up'), `failed leaves the plain note ("${r7.failed}")`)
check(!(r7.failed ?? '').includes('summarizer'), "the daemon's internal reason is not shown")
check(r7.line === null && r7.bar === null, 'and no running line or bar')
const shot2 = await send('Page.captureScreenshot', { format: 'png' })
if (shot2?.result?.data) writeFileSync(SHOT.replace(/\.png$/, '-failed.png'), Buffer.from(shot2.result.data, 'base64'))

// 8. B fails: A's note is A's own
compaction(B, 'failed', { reason: 'other' })
compaction(B, 'done')
await sleep(500)
const r8 = await read()
check(r8.failed === r7.failed && r8.live[0] === r7.live[0], "B's frames leave A's note and announcement alone", JSON.stringify(r8))

// 9. A starts again and the turn is stopped mid-pass: the daemon sends failed{reason:"cancelled"}.
// The turn already says it was stopped, so the line just goes; no "Couldn't tidy up" note.
compaction(A, 'start', { chunks_done: 1, chunks_total: 4 })
await sleep(400)
const r9a = await read()
check(r9a.line !== null && r9a.failed === null, 'a new pass replaces the old note with the line', JSON.stringify(r9a))
compaction(A, 'failed', { reason: 'cancelled', duration_ms: 1200 })
await sleep(500)
const r9 = await read()
check(r9.line === null && r9.failed === null && r9.bar === null, 'stopped mid-pass: the line goes and no note is left', JSON.stringify(r9))

if (checks < MIN_CHECKS) {
  console.error(`  FAIL only ${checks} checks ran, expected at least ${MIN_CHECKS}`)
  failures += 1
}
rest.close()
wss.close()
console.log(`\n[probe] screenshots: ${SHOT}, ${SHOT.replace(/\.png$/, '-failed.png')}`)
console.log(`${failures === 0 ? `PASS (${checks} checks)` : `FAIL (${failures})`}\n`)
process.exit(failures === 0 ? 0 : 1)
