#!/usr/bin/env node
// gym-control-app-probe — Activity › Gym › Now › Rehearsal model IN THE REAL APP, against the FAKE control service
// (src/main/gym-control-smoke.ts --serve, on this computer's loopback). `smoke:gym-control` proves the rules; this proves the
// app draws them and that the whole path (page → main → fake service → OS confirmation → apply → operation) holds.
//
// Nothing real is touched: the status is a sample file (BEACON_GYM_STATUS_FILE, with its time set to now so it is not "old"),
// the control service is a fake on 127.0.0.1 (a build that may be debugged may connect to loopback; a release never), the
// confirmation window is the OS's, which this probe replaces in main with a recorder that answers, and the app runs from a
// scratch copy of the profile with a mock keychain, so the write token it is given is a made-up one that is kept nowhere real.
//
// RUN (not part of verify: it drives the real app on this Mac):
//   npm run build && npm run probe:gym-control
// PROBE_SHOT_DIR=<dir> writes screenshots there (they show the copied profile's rail; never commit them).
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchApp, scratchProfile, sleep, sql } from './app-driver.mjs'

const SHOTS = process.env.PROBE_SHOT_DIR
let failures = 0
function check(ok, what, detail) {
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${what}${detail !== undefined && !ok ? `  — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── the fake control service ──────────────────────────────────────────────────────────────────────────────────────────────
const electron = process.env.BEACON_ELECTRON || resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const fake = spawn(electron, [resolve('out/main/gym-control-smoke.js'), '--serve'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
process.on('exit', () => fake.kill())
const served = await new Promise((ok, no) => {
  let out = ''
  fake.stdout.on('data', (d) => {
    out += String(d)
    const line = out.split('\n').find((l) => l.startsWith('{'))
    if (line) ok(JSON.parse(line))
  })
  fake.on('exit', () => no(new Error('the fake control service ended: ' + out)))
  setTimeout(() => no(new Error('the fake control service did not start')), 15000)
})
const base = `http://127.0.0.1:${served.port}`
const knob = async (k) => (await fetch(`${base}/__fake`, { method: 'POST', body: JSON.stringify(k) })).json()

// ── a status that is not old ──────────────────────────────────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'gym-control-probe-'))
const sample = JSON.parse(readFileSync(resolve('src/main/fixtures/gym_status_promoted.json'), 'utf8'))
sample.generated_at = new Date().toISOString().replace('Z', '+00:00')
const sampleFile = join(dir, 'status.json')
writeFileSync(sampleFile, JSON.stringify(sample))
process.env.BEACON_GYM_STATUS_FILE = sampleFile

const profile = scratchProfile()
sql(profile, `INSERT OR REPLACE INTO settings (key, value) VALUES ('ui:mode:v1', 'full')`, 'beacon')
// A scratch copy has no token, so GET /api/devices is refused and the app cannot learn that it is the owner; it remembers the
// last role it learned per address and key (main/index.ts roleMemory), in the open Prometheus's own folder. Seed that memory as
// the owner's, for the folder the copy opens and the empty key it has. (Only a seed: nothing here is sent to that Prometheus.)
const open = execFileSync('sqlite3', [join(profile, 'app.db'), "SELECT value FROM settings WHERE key = 'daemons:active'"]).toString().trim()
const apiBase = execFileSync('sqlite3', [join(profile, 'app.db'), `SELECT api_base FROM daemon_folders WHERE id = '${open.replace(/'/g, '')}'`]).toString().trim()
if (open && apiBase) {
  const id = createHash('sha256').update(`${apiBase}\n`).digest('hex').slice(0, 32)
  execFileSync('sqlite3', [join(profile, 'daemons', open, 'cache.db'), `INSERT OR REPLACE INTO settings (key, value) VALUES ('connection.deviceRole', '${id} owner')`])
}
const app = await launchApp({ profile })
const ev = app.page.evaluate
const q = (s) => JSON.stringify(s)
const waitFor = async (expr, ms = 8000) => {
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
const card = () => ev(`document.querySelector('[data-testid="gym-rehearsal"]')?.innerText ?? ''`)
const type = async (testid, text) => {
  await ev(`document.querySelector('[data-testid="${testid}"]').focus()`)
  await app.page.send('Input.insertText', { text })
}
const click = (testid) => ev(`document.querySelector('[data-testid="${testid}"]')?.click()`)
// The OS's confirmation, replaced in main by a recorder that answers with whatever __answer says (0 Cancel, 1 the action).
await app.mainEval(`globalThis.__calls = []; globalThis.__answer = 0; __electron.dialog.showMessageBox = async (...a) => { globalThis.__calls.push(a[a.length - 1]); return { response: globalThis.__answer, checkboxChecked: false } }; true`)
const calls = async () => JSON.parse(await app.mainEval(`JSON.stringify(globalThis.__calls)`))
const answer = (n) => app.mainEval(`globalThis.__answer = ${n}; true`)

try {
  await ev(`[...document.querySelectorAll('nav[aria-label="Views"] > button')].find((x) => x.title === 'Activity')?.click()`)
  await sleep(600)
  await ev(`[...document.querySelectorAll('.subnav-pills .pill')].find((p) => p.childNodes[0].textContent.trim() === 'Gym')?.click()`)
  check(await waitFor(`!!document.querySelector('[data-testid="gym-rehearsal"]')`), 'the Now view draws a Rehearsal model card')
  let text = String(await card())
  check(/Promoted/.test(text) && /rehearsal_r5_final_q4/.test(text) && /Match what was recorded before/.test(text) && /left untouched/.test(text), 'it shows the gym\'s own record of the promotion, and what the gym says was left alone', text)
  const owner = (await ev(`!!document.querySelector('[data-testid="gym-control-toggle"]')`)) === true
  check(owner, 'this Beacon is the owner of its Prometheus, so it offers the control service setup (not the owner: nothing to try)')
  if (!owner) throw new Error('not the owner: the rest cannot be tried on this profile')
  check((await ev(`!document.querySelector('[data-testid="gym-promote"]')`)) === true && /Set up the control service/.test(String(await ev(`document.querySelector('[data-testid="gym-control-setup"]')?.innerText ?? ''`))), 'before the control service is set up there is no Promote and no Roll back, and the card says how to get them')

  // set it up through the form: an address, and a write token
  await click('gym-control-toggle')
  await waitFor(`!!document.querySelector('[data-testid="gym-control-address"]')`)
  await type('gym-control-address', base)
  await type('gym-control-token', served.token)
  await click('gym-control-save')
  check(await waitFor(`!!document.querySelector('[data-testid="gym-promote"]') && !!document.querySelector('[data-testid="gym-rollback"]')`), 'saving the address and a write token draws Promote and Roll back')
  check((await ev(`document.querySelector('[data-testid="gym-promote"]').disabled === false && document.querySelector('[data-testid="gym-rollback"]').disabled === false`)) === true, 'both can be pressed: the status is fresh, a model is offered, nothing is running')
  const tokenInDom = await ev(`document.documentElement.outerHTML.includes(${q(served.token)})`)
  check(tokenInDom === false, 'the token is not anywhere on the page once saved')
  await shot('gym-rehearsal-ready.png')

  // Promote, and Cancel
  await ev(`window.__marker = 1`)
  await click('gym-promote')
  await waitFor(`!!document.querySelector('[data-testid="gym-said"]')`)
  let c = await calls()
  const first = c[0] ?? {}
  check(c.length === 1 && first.buttons?.join() === 'Cancel,Promote' && first.defaultId === 0 && first.cancelId === 0 && /Serving now: rehearsal_base/.test(first.detail ?? '') && /Will serve: rehearsal_r5_final_q4/.test(first.detail ?? '') && /models › primary: "rehearsal_base" → "rehearsal_r5_final_q4"/.test(first.detail ?? '') && /pins › sampling › temperature: 0\.7 → 0\.2/.test(first.detail ?? '') && /Serving computer \(rehearsal_instance\)/.test(first.detail ?? '') && /rehearsal_daemon, rehearsal_student/.test(first.detail ?? ''), 'the confirmation (the OS\'s) has Cancel first and as the default, and lists the models, every setting from and to, the computer and the restarts', JSON.stringify(first))
  check(!/untouched|not touched|safe/i.test(first.detail ?? ''), 'and makes no reassurance of its own')
  check(/Cancelled\. Nothing was changed\./.test(String(await ev(`document.querySelector('[data-testid="gym-said"]').innerText`))) && (await knob({})).applies === 0, 'Cancel: the page says nothing was changed, and the service never received an apply')
  await shot('gym-rehearsal-cancelled.png')

  // Promote, confirmed
  await sleep(1800) // main makes a page that asks again at once wait a moment
  await answer(1)
  await click('gym-promote')
  check(await waitFor(`/Sent\\./.test(document.querySelector('[data-testid="gym-said"]')?.innerText ?? '')`), 'Promote, confirmed: the page says it was sent')
  check(await waitFor(`/Promote: done/.test(document.querySelector('[data-testid="gym-op"]')?.innerText ?? '')`, 15000), 'the operation is read until it is done')
  text = String(await ev(`document.querySelector('[data-testid="gym-op"]').innerText`))
  check(/files match what was recorded before/.test(text) && /real daemon was left untouched/.test(text), 'and what was left alone is said only now, from the operation\'s own answer', text)
  check((await knob({})).applies === 1 && (await knob({})).promoted === true, 'the service received exactly one apply, and the gym is promoted')
  await shot('gym-rehearsal-done.png')

  // Promote again: the service refuses in its plan; no confirmation is drawn
  await sleep(1800) // main makes a page that asks again at once wait a moment
  const before = (await calls()).length
  await click('gym-promote')
  await waitFor(`/already promoted/i.test(document.querySelector('[data-testid="gym-said"]')?.innerText ?? '')`)
  check((await calls()).length === before && (await knob({})).applies === 1, 'Promote when it is already promoted: the refusal is said in Beacon\'s words, no confirmation is shown, nothing is sent')

  // Roll back whose outcome is not known: the connection dies after the apply
  await sleep(1800) // main makes a page that asks again at once wait a moment
  await knob({ drop: true })
  await click('gym-rollback')
  await waitFor(`/didn.t get a clear answer/.test(document.querySelector('[data-testid="gym-said"]')?.innerText ?? '')`)
  const rolled = (await calls()).at(-1) ?? {}
  check(rolled.buttons?.[1] === 'Roll back' && /Serving now: rehearsal_r5_final_q4/.test(rolled.detail ?? ''), 'Roll back has its own confirmation, from its own plan')
  const said = String(await ev(`document.querySelector('[data-testid="gym-said"]').innerText`))
  check(/will not send it again/i.test(said) && (await knob({})).applies === 2, 'a connection that dies after the apply: "not known", never sent again (the service saw exactly one more apply)', said)
  await shot('gym-rehearsal-unknown.png')
  check((await ev(`window.__marker === 1`)) === true, 'the page was never reloaded')

  // The page cannot apply: nothing on the bridge names a plan or an apply
  const bridge = await ev(`Object.keys(window.beacon.gymControl).sort().join()`)
  check(bridge === 'op,run,setAddress,setToken,settings', 'the page\'s only way in is to ask: run, op and the settings', bridge)
} catch (e) {
  check(false, 'the probe ran to the end', String(e?.stack ?? e))
} finally {
  await app.quit()
  fake.kill()
  rmSync(dir, { recursive: true, force: true })
}
console.log(failures === 0 ? '[probe] OK' : `[probe] FAIL — ${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
