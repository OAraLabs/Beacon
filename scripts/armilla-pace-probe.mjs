// Real-app probe for Armilla's frame pacing (src/shared/armilla-pace.ts). macOS only: it drives the
// built app through scripts/app-driver.mjs.
//
// The smoke pins the decision table; this proves the painted sky follows it. It counts actual
// redraws (attribute writes on the equator path), so a correct model wired to nothing fails here:
//   at rest, focused      → about 10 redraws/s, and still turning (a frozen sky is a failure too)
//   at rest, a step       → the equator rungs move about one viewBox unit per redraw (reads as smooth)
//   working, focused      → every display frame
//   working, unfocused    → 15–40/s (~24 on a 120 Hz screen), still moving
//   work stops            → back to the rest rate once the heat decays (≤ 6 s)
//   reduced motion        → no redraws at all
// It also prints CPU and Activity Monitor energy for Mission at rest vs Chat, for the record; those
// are too noisy to gate on, so the gates are the redraw counts.
//
// No copy of the user's profile: an empty --user-data-dir plus BEACON_GATEWAY_* env pointed at a
// fake gateway, which skips first-run setup and answers the WS with the daemon's {type:"connected"}.
// The fake also lets the probe inject work: `agent_state` frames raise the sky's heat, and none of
// the frames it sends can raise a notification (only task_* do).
//
//   npm run build && npm run probe:armilla-pace
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, sleep } from './app-driver.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { WebSocketServer } = createRequire(REPO + '/')('ws')

let failures = 0
let checks = 0
const check = (ok, what, detail = '') => {
  checks++
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${what}${!ok && detail ? `\n        ${detail}` : ''}`)
  if (!ok) failures++
}
// The verdict rides process exit, so an early throw can't skip it into a silent pass.
process.on('exit', (code) => {
  if (checks < 12) console.log(`[probe] FAIL  only ${checks} checks ran — the probe stopped early`)
  if (failures || checks < 12 || code) {
    console.log(`[probe] ${failures} failure(s)`)
    process.exitCode = 1
  } else console.log(`[probe] all ${checks} checks passed`)
})

// ── fake gateway ──
let restHits = 0
const sockets = new Set()
const http = createServer((_req, res) => {
  restHits++
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{}')
})
await new Promise((r) => http.listen(0, '127.0.0.1', r))
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
await new Promise((r) => wss.on('listening', r))
wss.on('connection', (s) => {
  sockets.add(s)
  s.on('close', () => sockets.delete(s))
  s.send(JSON.stringify({ type: 'connected' }))
})
const sendFrame = (type) => {
  for (const s of sockets) s.send(JSON.stringify({ type, payload: {}, timestamp: Date.now() / 1000 }))
}
process.env.BEACON_GATEWAY_HOST = '127.0.0.1'
process.env.BEACON_GATEWAY_API_PORT = String(http.address().port)
process.env.BEACON_GATEWAY_WS_PORT = String(wss.address().port)

const profile = mkdtempSync(join(tmpdir(), 'beacon-armilla-pace-'))
const app = await launchApp({ repo: REPO, profile })
const { page, mainEval } = app

try {
  for (let i = 0; i < 40; i++) {
    if ((await page.evaluate('window.beacon.connection.status().then(s => s.state)')) === 'connected') break
    await sleep(250)
  }
  check((await page.evaluate('window.beacon.connection.status().then(s => s.state)')) === 'connected', 'the link is up against the fake gateway', `ws sockets=${sockets.size}`)

  const go = async (label) => {
    const ok = await page.evaluate(`(() => { const b = document.querySelector('nav[aria-label="Views"] [title="${label}"]'); if (!b) return false; b.click(); return true })()`)
    await sleep(1500)
    return ok
  }
  const setFocus = async (on) => {
    if (on) {
      await mainEval('(__electron.BrowserWindow.getAllWindows().forEach(w => w.setAlwaysOnTop(false)), true)')
      await page.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    } else {
      // Blurring alone can drop the window behind others, and a covered window gets no animation
      // frames at all, which would measure "hidden", not "unfocused". Keep it on top while blurred.
      await page.send('Emulation.setFocusEmulationEnabled', { enabled: false })
      await mainEval('(__electron.BrowserWindow.getAllWindows().forEach(w => { w.setAlwaysOnTop(true); w.blur() }), true)')
    }
    await sleep(300)
    return page.evaluate('document.hasFocus()')
  }

  // Count redraws of the equator rungs for `ms`, and the largest per-redraw step of any rung.
  // Every draw() rewrites the rungs' `d`; a MutationObserver records each write, changed or not.
  const sample = (ms) =>
    page.evaluate(`new Promise((done) => {
      const f = document.querySelector('[data-k="eqR-f"]'), b = document.querySelector('[data-k="eqR-b"]')
      if (!f || !b) return done({ absent: true })
      const starts = () => [...(f.getAttribute('d') + (b.getAttribute('d') || '')).matchAll(/M([-\\d.]+) ([-\\d.]+)/g)].map((m) => [+m[1], +m[2]])
      let draws = 0, maxStep = 0, prev = starts(); const first = f.getAttribute('d') + b.getAttribute('d')
      const mo = new MutationObserver((recs) => {
        if (!recs.some((r) => r.target === f)) return
        draws++
        const cur = starts()
        for (const p of cur) {
          let near = Infinity
          for (const q of prev) near = Math.min(near, Math.hypot(p[0] - q[0], p[1] - q[1]))
          if (near !== Infinity) maxStep = Math.max(maxStep, near)
        }
        prev = cur
      })
      mo.observe(f, { attributes: true, attributeFilter: ['d'] })
      setTimeout(() => { mo.disconnect(); done({ perSec: draws / (${ms} / 1000), maxStep, moved: f.getAttribute('d') + b.getAttribute('d') !== first, visible: document.visibilityState === 'visible' }) }, ${ms})
    })`)

  // Keep the agent "working": a gateway frame every 400 ms holds the heat up.
  const working = async (fn) => {
    const iv = setInterval(() => sendFrame('agent_state'), 400)
    sendFrame('agent_state')
    await sleep(600)
    try {
      return await fn()
    } finally {
      clearInterval(iv)
    }
  }

  const measureEnergy = async (secs = 15) => {
    await mainEval('(__electron.app.getAppMetrics(), true)')
    const pids = await mainEval('__electron.app.getAppMetrics().map(m => m.pid)')
    const out = execFileSync('top', ['-l', '2', '-s', String(secs), '-stats', 'pid,cpu,power', ...pids.flatMap((p) => ['-pid', String(p)])]).toString()
    let energy = 0
    for (const line of out.split(/\n(?=Processes:)/).pop().split('\n')) {
      const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)$/)
      if (m && pids.includes(+m[1])) energy += +m[3]
    }
    const cpu = await mainEval('__electron.app.getAppMetrics().reduce((a, m) => a + m.cpu.percentCPUUsage, 0)')
    return { cpu, energy }
  }

  check(await go('Mission'), 'navigated to Mission')
  check(await setFocus(true), 'the page reports focus (CDP focus emulation)')
  await sleep(3000) // let any startup heat decay

  const rest = await sample(3000)
  console.log(`[probe]   at rest, focused: ${rest.perSec.toFixed(1)} redraws/s, largest step ${rest.maxStep.toFixed(2)} units`)
  check(rest.visible, 'the window is visible while measuring')
  check(rest.perSec <= 12, 'at rest the sky redraws about 10 times a second, not every display frame', `got ${rest.perSec.toFixed(1)}/s`)
  check(rest.perSec >= 6 && rest.moved, 'at rest the sky still turns: slowed, never frozen', `got ${rest.perSec.toFixed(1)}/s, moved=${rest.moved}`)
  check(rest.maxStep <= 1.5, 'at rest each redraw moves the rungs about one viewBox unit at most', `largest step ${rest.maxStep.toFixed(2)}`)

  const busy = await working(() => sample(2000))
  console.log(`[probe]   working, focused: ${busy.perSec.toFixed(1)} redraws/s`)
  check(busy.perSec >= 50, 'working and focused, the sky redraws every display frame', `got ${busy.perSec.toFixed(1)}/s`)

  await sleep(7000) // heat decays to 0 within 6 s of the last frame
  const after = await sample(2000)
  console.log(`[probe]   6 s+ after work stops: ${after.perSec.toFixed(1)} redraws/s`)
  check(after.perSec <= 12, 'once the work heat decays, the sky drops back to the rest rate', `got ${after.perSec.toFixed(1)}/s`)

  const unfocusedOk = !(await setFocus(false))
  check(unfocusedOk, 'the page reports NO focus after blurring the window (else the next check means nothing)')
  const away = await working(() => sample(2000))
  console.log(`[probe]   working, unfocused: ${away.perSec.toFixed(1)} redraws/s`)
  check(away.visible, 'the window stayed visible while unfocused (a covered window gets no frames at all)')
  check(unfocusedOk && away.perSec >= 15 && away.perSec <= 40, 'working while unfocused, the sky slows to 15–40/s', `got ${away.perSec.toFixed(1)}/s`)
  check(away.moved, 'working while unfocused, the sky still moves')

  await setFocus(true)
  await sleep(7000)
  const missionRest = await measureEnergy()
  await go('Chats')
  const chat = await measureEnergy()
  console.log(`[probe]   (record) Mission at rest: ${missionRest.cpu.toFixed(1)}% CPU, energy ${missionRest.energy.toFixed(1)}; Chat: ${chat.cpu.toFixed(1)}% CPU, energy ${chat.energy.toFixed(1)}`)

  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await go('Mission')
  const still = await working(() => sample(2000))
  check(still.perSec === 0, 'under reduced motion the sky never redraws, even while working', `got ${still.perSec.toFixed(1)}/s`)

  check(restHits > 0, `the fake gateway was actually used (rest=${restHits})`)
} catch (e) {
  check(false, 'the probe ran to completion', String(e?.stack ?? e))
} finally {
  await app.quit()
  http.close()
  wss.close()
  // quit() waits for main to exit, but a Chromium helper can still be flushing into the profile for a
  // moment after it, and a plain rmSync then throws ENOTEMPTY — which used to exit 1 after all 15
  // checks had passed. Retry, and if the scratch dir still will not go, say so; cleanup never decides
  // the verdict.
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (e) {
    console.log(`[probe] note: could not remove the scratch profile ${profile} (${e.code ?? e}) — remove it by hand`)
  }
}
