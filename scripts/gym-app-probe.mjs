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
  check(/r5/.test(now) && /Training/.test(now) && /step 1,610 of 2,346/.test(now) && /Night watch passed/.test(now) && /Disk space low · Training computer/.test(now) && /A service is down unexpectedly: voice · Serving computer/.test(now) && /1 not up, unexpectedly; 1 not up, as planned/.test(now), 'Now: the round, the phase, training progress, last night, alerts, services', now.slice(0, 600))
  check((await ev(`document.querySelectorAll('[data-testid="gym-one-reading"] .gym-dot').length`)) === 1 && /one reading so far/.test(now) && /Night watch, training computer\s*✓\s*Passed, 580 steps/.test(now), 'Now: a loss with one reading draws as a dot with its value; night watch is said per computer', now.slice(0, 900))
  await shot('gym-now.png')
  for (const [tab, want] of [
    ['rounds', /Quantisation[\s\S]*Compared[\s\S]*Candidate[\s\S]*Kept[\s\S]*r3[\s\S]*r4[\s\S]*Reference only[\s\S]*Tool-call task success[\s\S]*must gain at least 10\.0 pts[\s\S]*\+4\.2 pts[\s\S]*\+7\.6 pts[\s\S]*Fail[\s\S]*Replay: replay_236[\s\S]*171 of 208/i],
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
      check(kept === 'final,final,Reference model' && everyone === 'final,final,epoch1,Reference model', 'rounds: opens on each round’s kept candidate; the Candidate filter shows the others', `${kept} → ${everyone}`)
    }
  }
  await ev(`document.querySelector('[data-testid="gym-tab-now"]').click()`)
  await sleep(300)
  const firstCard = String(await ev(`document.querySelector('[data-testid="gym-panel"] .gym-grid > section .gym-card-title').textContent`))
  const trainingText = String(await ev(`[...document.querySelectorAll('[data-testid="gym-panel"] .gym-grid > section')].find((c) => c.querySelector('.gym-card-title')?.textContent === 'Training')?.innerText ?? ''`))
  check(firstCard === 'Where it stands' && /Running/.test(trainingText) && /Last heard from/.test(trainingText) && (await ev(`!document.querySelector('[data-testid="gym-training-toggle"]')`)) === true, 'while training: Training is the live, open card as before, and says Running', trainingText.slice(0, 200))
  const controls = await ev(`[...document.querySelectorAll('[data-testid="gym-panel"] button, [data-testid="gym-panel"] input, [data-testid="gym-panel"] a, [data-testid="gym-panel"] select')].map((b) => b.textContent.trim() || b.tagName).join(',')`)
  check(controls === 'Now,Rounds,Data,Hosts', 'read-only: on a status, the only controls are the four sections', controls)
} finally {
  await app.quit()
}

// ── the same screen on the post-train sample: training finished, after-training checks running on a candidate ──────────────────
process.env.BEACON_GYM_STATUS_FILE = resolve('src/main/fixtures/gym_status_post_train.json')
const app2 = await launchApp({ profile })
const ev2 = app2.page.evaluate
const shot2 = async (name) => {
  if (!SHOTS) return
  const r = await app2.page.send('Page.captureScreenshot', { format: 'png' })
  if (r.result?.data) {
    writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
    console.log(`[probe] wrote ${join(SHOTS, name)}`)
  }
}
const key = (type, k) => app2.page.send('Input.dispatchKeyEvent', { type, key: k, code: k === ' ' ? 'Space' : k, text: k === 'Enter' ? '\r' : k, windowsVirtualKeyCode: k === 'Enter' ? 13 : 32 })
try {
  await ev2(`[...document.querySelectorAll('nav[aria-label="Views"] > button')].find((x) => x.title === 'Activity')?.click()`)
  await sleep(600)
  await ev2(`[...document.querySelectorAll('.subnav-pills .pill')].find((p) => p.childNodes[0].textContent.trim() === 'Gym')?.click()`)
  for (let t = 0; t < 60; t++) {
    if ((await ev2(`!!document.querySelector('[data-testid="gym-panel"] .gym-card')`)) === true) break
    await sleep(100)
  }
  const cards = () => ev2(`[...document.querySelectorAll('[data-testid="gym-panel"] .gym-grid > section')].map((c) => (c.querySelector('.gym-card-title')?.textContent ?? c.querySelector('.gym-collapse-line')?.textContent ?? '').trim())`)
  const order = await cards()
  check(order[0] === 'After-training checks' && order[1] === 'Where it stands' && order.some((t) => t.startsWith('Training done')) && !order.includes('Training'), 'post-train: the after-training checks lead the page and Training is a finished one-line card', JSON.stringify(order))
  const live = String(await ev2(`document.querySelector('[data-testid="gym-panel"] .gym-grid > section').innerText`))
  check(/Running/.test(live) && /Now on\s*score-d/.test(live) && /Working on\s*the final candidate/.test(live) && /Last heard from/.test(live) && !/\d+ of \d+/.test(live), 'post-train: the live card says Running, the step, the candidate and when it was last heard from, with no "N of M"', live)
  const btn = `document.querySelector('[data-testid="gym-training-toggle"]')`
  const line = String(await ev2(`${btn}.querySelector('.gym-collapse-line').textContent`))
  check(line === 'Training done · 2,333 steps · val 0.656 / ep1 0.650' && !/heard/i.test(String(await ev2(`${btn}.innerText`))), 'post-train: the finished Training card is one line with the steps and both validation losses, and no "last heard from"', line)
  check((await ev2(`${btn}.tagName`)) === 'BUTTON' && (await ev2(`${btn}.getAttribute('aria-expanded')`)) === 'false' && (await ev2(`!document.getElementById('gym-training-detail')`)) === true, 'post-train: it is a real button, collapsed (aria-expanded false, no detail yet)')
  await shot2('gym-post-train-collapsed.png')
  // Keyboard: focus it and press Enter, then Space.
  await ev2(`${btn}.focus()`)
  await key('keyDown', 'Enter')
  await key('keyUp', 'Enter')
  await sleep(200)
  const openedByKey = (await ev2(`${btn}.getAttribute('aria-expanded')`)) === 'true'
  await key('keyDown', ' ')
  await key('keyUp', ' ')
  await sleep(200)
  const closedByKey = (await ev2(`${btn}.getAttribute('aria-expanded')`)) === 'false'
  check(openedByKey && closedByKey, 'post-train: Enter opens it and Space closes it from the keyboard')
  await ev2(`${btn}.click()`)
  await sleep(200)
  const detail = String(await ev2(`document.getElementById('gym-training-detail')?.innerText ?? ''`))
  check((await ev2(`${btn}.getAttribute('aria-expanded')`)) === 'true' && /Done/.test(detail) && /Last heard from/.test(detail) && /Validation loss, by step/.test(detail), 'post-train: opened, it shows the existing detail (status Done, last heard from, the loss charts)', detail.slice(0, 200))
  await shot2('gym-post-train-expanded.png')
  await ev2(`${btn}.click()`)
  // Readable in both themes: the one line against its card, measured.
  const ratio = (theme) => ev2(`(() => {
    document.documentElement.setAttribute('data-theme', ${q(theme)})
    // A computed colour may be rgb(), rgba(), color(srgb …) or transparent: read all of them as [r, g, b, a] on 0-255.
    const rgb = (c) => {
      if (c === 'transparent') return [0, 0, 0, 0]
      const n = c.match(/-?[\\d.]+(?:e-?\\d+)?/g)
      if (!n) throw new Error('cannot read colour ' + c)
      const v = n.map(Number)
      return c.startsWith('color(') ? [v[0] * 255, v[1] * 255, v[2] * 255, v.length > 3 ? v[3] : 1] : [v[0], v[1], v[2], v.length > 3 ? v[3] : 1]
    }
    const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0)
    const card = document.querySelector('[data-testid="gym-training-finished"]')
    // The ground behind the text: the card's own background, over whatever is behind it, down to the page.
    const layers = []
    for (let el = card; el; el = el.parentElement) layers.push(rgb(getComputedStyle(el).backgroundColor))
    let bg = [255, 255, 255]
    for (const l of layers.reverse()) bg = bg.map((v, i) => l[i] * l[3] + v * (1 - l[3]))
    const out = {}
    for (const sel of ['.gym-collapse-line', '.gym-collapse-hint', '.gym-chev']) {
      const fg = rgb(getComputedStyle(card.querySelector(sel)).color)
      const a = lum(fg.slice(0, 3)), b = lum(bg)
      out[sel] = Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 10) / 10
    }
    return JSON.stringify(out)
  })()`)
  const lightRaw = await ratio('light')
  const light = typeof lightRaw === 'string' ? JSON.parse(lightRaw) : lightRaw
  await shot2('gym-post-train-light.png')
  const darkRaw = await ratio('dark')
  const dark = typeof darkRaw === 'string' ? JSON.parse(darkRaw) : darkRaw
  await shot2('gym-post-train-dark.png')
  check(Object.values(light).every((r) => r >= 4.5) && Object.values(dark).every((r) => r >= 4.5), 'post-train: the finished line, its hint and its arrow read at 4.5:1 or better in the light and the dark theme', `light ${JSON.stringify(light)} dark ${JSON.stringify(dark)}`)
} finally {
  await app2.quit()
}
console.log(`[probe] ${failures === 0 ? 'OK' : 'FAIL'} — ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
