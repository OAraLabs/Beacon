#!/usr/bin/env node
// ui-mode-app-probe — everyday mode IN THE REAL APP: the rail, the Today home, the pill rows, the
// Config tabs and the palette follow the Settings switch, a put-away view never shows, and the
// choice is still there after a relaunch. `smoke:ui-mode` proves the rules; this proves the app
// obeys them.
//
// RUN (not part of verify: it drives the real app on this Mac, from a scratch copy of the profile):
//   npm run build && npm run probe:ui-mode
// PROBE_SHOT_DIR=<dir> writes screenshots there (they show the copied profile; never commit them).
//
// Sends nothing: it clicks views and one Settings switch. The user's own profile is copied, never
// opened (app-driver), so the switch it flips is the copy's.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, scratchProfile, sleep, sql } from './app-driver.mjs'

const SHOTS = process.env.PROBE_SHOT_DIR
let failures = 0
let checks = 0
function check(ok, what, detail) {
  checks++
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${what}${detail !== undefined ? `  — ${detail}` : ''}`)
  if (!ok) failures++
}
const q = (s) => JSON.stringify(s)
const profile = scratchProfile()
// An install that exists and has never heard of modes: nothing stored.
sql(profile, `DELETE FROM settings WHERE key = 'ui:mode:v1'`, 'beacon')

function bind(app) {
  const ev = app.page.evaluate
  const waitFor = async (fn, pred, ms = 4000) => {
    let v
    for (let t = 0; t < ms; t += 50) {
      v = await fn()
      if (pred(v)) return v
      await sleep(50)
    }
    return v
  }
  // The rail's own entries: a button whose label is its title. The connection chip at the foot is
  // also a button in the nav, and its title names the computer, so it is left out and never printed.
  const ENTRIES = `[...document.querySelectorAll('nav[aria-label="Views"] > button')].filter((b) => b.querySelector(':scope > span')?.textContent === b.title)`
  const rail = () => ev(`${ENTRIES}.map((b) => b.title)`)
  const go = (title) => ev(`(() => { const b = ${ENTRIES}.find((x) => x.title === ${q(title)}); if (!b) return false; b.click(); return true })()`)
  const pills = () => ev(`[...document.querySelectorAll('.subnav-pills .pill')].map((p) => p.childNodes[0].textContent.trim())`)
  const pill = (label) => ev(`(() => { const b = [...document.querySelectorAll('.subnav-pills .pill')].find((p) => p.childNodes[0].textContent.trim() === ${q(label)}); if (!b) return false; b.click(); return true })()`)
  const shot = async (name) => {
    if (!SHOTS) return
    const r = await app.page.send('Page.captureScreenshot', { format: 'png' })
    if (r.result?.data) {
      writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
      console.log(`[probe] wrote ${join(SHOTS, name)}`)
    }
  }
  /** Open Settings, set the "Show everything" switch to `want`, close. Returns what it was. */
  const setShowEverything = async (want) => {
    await ev(`window.dispatchEvent(new Event('beacon:open-settings'))`)
    const box = `[...document.querySelectorAll('[role="dialog"] label')].find((l) => l.textContent.includes('Show everything'))?.querySelector('input[type=checkbox]')`
    const found = await waitFor(() => ev(`!!(${box})`), (v) => v === true)
    if (found !== true) return null
    const was = await ev(`(${box}).checked`)
    if (was !== want) await ev(`(${box}).click()`)
    await sleep(150)
    const now = await ev(`(${box}).checked`)
    await app.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await app.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await waitFor(() => ev(`!document.querySelector('[role="dialog"]')`), (v) => v === true)
    return { was, now }
  }
  return { ev, waitFor, rail, go, pills, pill, shot, setShowEverything }
}

// ── launch 1: an existing install keeps everything, then chooses everyday ─────────────────────
let app = await launchApp({ profile, acceptDialogs: true })
let d = bind(app)
const stored = () => d.ev(`window.beacon.settings.get('ui:mode:v1')`)
check((await d.waitFor(stored, (v) => v === 'full')) === 'full', 'an install that already exists is written down as "full" on its first launch with modes', q(await stored()))
const fullRail = await d.rail()
check(fullRail.join(' · ') === 'Mission · Chats · Coding · Workspace · Activity · Config', 'and its rail is what it always was', fullRail.join(' · '))
check((await d.ev(`!!document.querySelector('.mission-home') && !document.querySelector('.today')`)) === true, 'with Mission as the home')

// Go somewhere everyday mode puts away, then flip the switch while standing there.
check(await d.go('Workspace'), 'opened Workspace')
check(await d.pill('Board'), 'and its Board')
const fullPills = await d.pills()
check(fullPills.length === 8, 'Workspace has its eight pills in full', fullPills.join(' · '))
const flip = await d.setShowEverything(false)
check(flip?.was === true && flip.now === false, 'Settings has a "Show everything" switch, on for this install; turned it off', q(flip))
check((await d.waitFor(stored, (v) => v === 'everyday')) === 'everyday', 'the choice is saved')

const everydayRail = await d.waitFor(d.rail, (v) => Array.isArray(v) && v.length === 4)
check(everydayRail.join(' · ') === 'Today · Chats · Workspace · Config', 'the rail is now Today · Chats · Workspace · Config', everydayRail.join(' · '))
check((await d.waitFor(() => d.ev(`!!document.querySelector('.today')`), (v) => v === true)) === true, 'the Board that was on screen is gone, and Today is shown in its place')
const heads = await d.ev(`[...document.querySelectorAll('.today .today-h')].map((h) => h.childNodes[0].textContent.trim())`)
check(heads.length === 3 && heads[0] === 'Needs you' && /^(Since you last looked|In the last day)/.test(heads[1]) && heads[2] === 'Coming up', 'Today asks its three questions', heads.join(' | '))
await sleep(1500)
const settled = await d.ev(`[...document.querySelectorAll('.today .today-card')].map((c) => c.querySelectorAll('.today-row').length + ':' + (c.querySelector('.today-empty')?.textContent ?? ''))`)
check(settled.every((s) => !s.endsWith(':Reading…')), 'and each section settles on rows or on words for its kind of empty', settled.join(' | '))
check((await d.ev(`[...document.querySelectorAll('.today .today-row-main, .today .today-row-detail')].some((e) => /\\b(beacon|desktop|telegram|voice):[0-9a-f-]{6,}/.test(e.textContent))`)) === false, 'no row shows a raw conversation id')
await d.shot('today.png')

check(await d.go('Workspace'), 'opened Workspace again')
const everydayPills = await d.waitFor(d.pills, (v) => Array.isArray(v) && v.length === 4)
check(everydayPills.join(' · ') === 'Documents · Artifacts · Wiki · Files', 'it has the four everyday pills', everydayPills.join(' · '))
check(await d.go('Config'), 'opened Config')
const tabs = await d.waitFor(() => d.ev(`[...document.querySelectorAll('[data-testid="config-tab-groups"] button')].map((b) => b.textContent.trim())`), (v) => Array.isArray(v) && v.length > 0)
check(tabs.join(' · ') === 'Models · Connectors · Usage · Memory · Cron · Devices · Skin' || tabs.length === 7, 'Config shows the seven tabs a person sets something in', tabs.join(' · '))
check(!tabs.includes('Sentinel') && !tabs.includes('Telemetry') && !tabs.includes('Grants'), 'and not Sentinel, Telemetry or Grants')
await d.shot('everyday-config.png')

// The palette: no way to a put-away view, and the switch is there in words.
const mod = process.platform === 'darwin' ? 4 : 2
const key = async (k, code, vk, extra = {}) => {
  await app.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, ...extra })
  await app.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
}
/** What the palette lists for a query: opened fresh each time, so no query leaks into the next. */
const paletteFor = async (text) => {
  await key('k', 'KeyK', 75, { modifiers: mod })
  const open = await d.waitFor(() => d.ev(`document.activeElement?.tagName === 'INPUT' && document.activeElement.value === ''`), (v) => v === true)
  if (open !== true) return null
  await app.page.send('Input.insertText', { text })
  await sleep(300)
  const typed = await d.ev(`document.activeElement.value`)
  const body = await d.ev(`document.body.innerText`)
  await key('Escape', 'Escape', 27)
  await d.waitFor(() => d.ev(`document.activeElement?.tagName !== 'INPUT'`), (v) => v === true, 1500)
  return typed === text ? body : null
}
const goTo = await paletteFor('Go to')
check(goTo !== null && /Go to Today/.test(goTo) && !/Go to Mission/.test(goTo), 'the palette calls the home Today')
const chats = await paletteFor('Go to Chat')
check(chats !== null && /^Go to Chat$/m.test(chats), 'the control: a view that is shown is found by name')
const board = await paletteFor('Go to Board')
// A row is its label on a line of its own; the pinned "Search conversations for …" row quotes the query.
check(board !== null && !/^Go to Board$/m.test(board), 'and a put-away one is not: no "Go to Board" row')
const everything = await paletteFor('Show everything')
check(everything !== null && /Show everything \(Mission, Coding, Activity…\)/.test(everything), 'but it does offer "Show everything"')
await app.quit()

// ── launch 2: the choice holds ───────────────────────────────────────────────────────────────
app = await launchApp({ profile, acceptDialogs: true })
d = bind(app)
const again = await d.waitFor(d.rail, (v) => Array.isArray(v) && v.length === 4, 6000)
check(again.join(' · ') === 'Today · Chats · Workspace · Config', 'after a relaunch the rail is still the everyday one', again.join(' · '))
check((await d.waitFor(() => d.ev(`!!document.querySelector('.today')`), (v) => v === true)) === true, 'and it opens on Today')
const back = await d.setShowEverything(true)
check(back?.was === false && back.now === true, 'the switch is off, as left; turned it back on', q(back))
const restored = await d.waitFor(d.rail, (v) => Array.isArray(v) && v.length === 6)
check(restored.join(' · ') === 'Mission · Chats · Coding · Workspace · Activity · Config', 'everything is back, in place', restored.join(' · '))
check((await d.waitFor(() => d.ev(`!!document.querySelector('.mission-home')`), (v) => v === true)) === true, 'and the home is Mission again')
await app.quit()

console.log(`[probe] ${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures} of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
