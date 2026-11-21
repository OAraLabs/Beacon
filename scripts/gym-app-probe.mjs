#!/usr/bin/env node
// gym-app-probe — Activity › Gym IN THE REAL APP, on the sample status (src/main/fixtures/gym_status.json): the view is in the
// Activity pill row, it says it is showing sample data, each of its four sections draws, and it holds no control that changes
// anything but the section. `smoke:gym` proves the rules; this proves the app draws them.
//
// RUN (not part of verify: it drives the real app on this Mac, from a scratch copy of the profile):
//   npm run build && npm run probe:gym
// PROBE_SHOT_DIR=<dir> writes screenshots there (they show the copied profile's rail; never commit them).
//
// Sends nothing and asks no gym anything: a build that may be debugged reads the sample file instead (BEACON_GYM_STATUS_FILE).
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launchApp, scratchProfile, sleep, sql } from './app-driver.mjs'

const SHOTS = process.env.PROBE_SHOT_DIR
let failures = 0
let checks = 0
function check(ok, what, detail) {
  checks++
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${what}${detail !== undefined && !ok ? `  — ${detail}` : ''}`)
  if (!ok) failures++
}
const q = (s) => JSON.stringify(s)
const profile = scratchProfile()
sql(profile, `INSERT OR REPLACE INTO settings (key, value) VALUES ('ui:mode:v1', 'full')`, 'beacon')
process.env.BEACON_GYM_STATUS_FILE = resolve('src/main/fixtures/gym_status.json')

const app = await launchApp({ profile })
const ev = app.page.evaluate
const waitFor = async (expr, ms = 6000) => {
  for (let t = 0; t < ms; t += 100) {
    if ((await ev(expr)) === true) return true
    await sleep(100)
  }
  return false
}
const shot = async (name) => {
  if (!SHOTS) return
  const r = await app.page.send('Page.captureScreenshot', { format: 'png' })
  if (r.result?.data) {
    writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
    console.log(`[probe] wrote ${join(SHOTS, name)}`)
  }
}
try {
  const rail = await ev(`(() => { const b = [...document.querySelectorAll('nav[aria-label="Views"] > button')].find((x) => x.title === 'Activity'); if (!b) return false; b.click(); return true })()`)
  check(rail === true, 'the rail has Activity')
  await waitFor(`!!document.querySelector('.subnav-pills')`)
  const pills = await ev(`[...document.querySelectorAll('.subnav-pills .pill')].map((p) => p.childNodes[0].textContent.trim())`)
  check(Array.isArray(pills) && pills.join() === 'Live,Tool Feed,Status,Gym', 'Activity’s pills are Live, Tool Feed, Status, Gym', String(pills))
  await ev(`[...document.querySelectorAll('.subnav-pills .pill')].find((p) => p.childNodes[0].textContent.trim() === 'Gym')?.click()`)
  check(await waitFor(`!!document.querySelector('[data-testid="gym-panel"] .gym-card')`), 'the Gym view draws the status')
  const fresh = await ev(`document.querySelector('[data-testid="gym-fresh"]')?.textContent ?? ''`)
  check(String(fresh).includes('Sample data, not a gym.'), 'it says it is showing sample data', fresh)
  const text = () => ev(`document.querySelector('[data-testid="gym-panel"]').innerText`)
  const now = String(await text())
  check(/r5/.test(now) && /Training/.test(now) && /step 1,610 of 2,346/.test(now) && /Night watch passed/.test(now) && /Disk space low · Training computer/.test(now) && /A service is down unexpectedly: voice · Serving computer/.test(now) && /1 down unexpectedly, 1 down as planned/.test(now), 'Now: the round, the phase, training progress, last night, alerts, services', now.slice(0, 600))
  check((await ev(`document.querySelectorAll('[data-testid="gym-one-reading"] .gym-dot').length`)) === 1 && /one reading so far/.test(now) && /Night watch, training computer\s*✓\s*Passed, 580 training steps/.test(now), 'Now: a loss with one reading draws as a dot with its value; night watch is said per computer', now.slice(0, 900))
  await shot('gym-now.png')
  for (const [tab, want] of [
    ['rounds', /Quantisation[\s\S]*Compared[\s\S]*Candidate[\s\S]*Kept[\s\S]*r3[\s\S]*r4[\s\S]*Reference only[\s\S]*Tool-call task success[\s\S]*must gain at least 10\.0 pts[\s\S]*\+4\.2 pts[\s\S]*\+7\.6 pts[\s\S]*Fail[\s\S]*Replay: replay 236[\s\S]*171 of 208/i],
    ['data', /61,234[\s\S]*examples in the pool[\s\S]*day by day[\s\S]*Added over these days[\s\S]*Most examples from one seed\s*12[\s\S]*Written task sets[\s\S]*tw-v2[\s\S]*Token plan[\s\S]*Accepting requests/i],
    ['hosts', /Training computer[\s\S]*Business model\s*·\s*Down, as planned: training window until [\s\S]*Tunnel\s*✓\s*Up[\s\S]*GPU temperature[\s\S]*Serving computer[\s\S]*Reference model\s*✓\s*Up[\s\S]*Voice\s*✕\s*Down unexpectedly: not answering/i]
  ]) {
    await ev(`document.querySelector(${q(`[data-testid="gym-tab-${tab}"]`)}).click()`)
    await sleep(300)
    const t = String(await text())
    check(want.test(t), `${tab}: draws what the sample holds`, t.slice(0, 700))
    await shot(`gym-${tab}.png`)
    if (tab === 'rounds') {
      const cols = () => ev(`[...document.querySelectorAll('.gym-rounds thead tr:nth-child(2) th .gym-cand')].map((x) => x.textContent).join(',')`)
      const kept = await cols()
      await ev(`[...document.querySelectorAll('[aria-label="Candidate"] button')].find((b) => b.textContent === 'All').click()`)
      await sleep(200)
      const everyone = await cols()
      check(kept === 'final,final,reference' && everyone === 'final,final,epoch1,reference', 'rounds: opens on each round’s kept candidate; the Candidate filter shows the others', `${kept} → ${everyone}`)
    }
  }
  const controls = await ev(`[...document.querySelectorAll('[data-testid="gym-panel"] button, [data-testid="gym-panel"] input, [data-testid="gym-panel"] a, [data-testid="gym-panel"] select')].map((b) => b.textContent.trim() || b.tagName).join(',')`)
  check(controls === 'Now,Rounds,Data,Hosts', 'read-only: on a status, the only controls are the four sections', controls)
} finally {
  await app.quit()
}
console.log(`[probe] ${failures === 0 ? 'OK' : 'FAIL'} — ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
