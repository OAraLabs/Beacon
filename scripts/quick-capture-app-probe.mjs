#!/usr/bin/env node
// quick-capture-app-probe — does the quick-capture window carry files and screenshots, and stay
// up while its own picker is open, IN THE REAL APP? `smoke:quick-capture` proves the pure model
// and reads the wiring off the source; this drives the built app's real window.
//
// RUN (not part of verify: it drives the real app on this Mac, from a scratch copy of the profile):
//   npm run build && npm run probe:quick-capture
// PROBE_SHOT_DIR=<dir> also writes a screenshot of the window there (for looking at, not committing).
//
// SENDS NOTHING TO A CONVERSATION. The scratch profile has no key (app-driver), so Prometheus
// refuses every write; the one send this presses is to "New conversation", and the probe checks
// that it is refused and that the text and the file are still in the box afterwards.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, scratchProfile, sleep } from './app-driver.mjs'

const SHOTS = process.env.PROBE_SHOT_DIR
let failures = 0
let checks = 0
function check(ok, what, detail) {
  checks++
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${what}${detail !== undefined ? `  — ${detail}` : ''}`)
  if (!ok) failures++
}

const app = await launchApp({ profile: scratchProfile(), acceptDialogs: true })
const q = (s) => JSON.stringify(s)
const WIN = `__electron.BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('#capture'))`
/** Run JS in the quick-capture window's page (through main: it is a second window). */
const inWin = (js) => app.mainEval(`(async () => { const w = ${WIN}; if (!w) return { __nowin: true }; return await w.webContents.executeJavaScript(${q(js)}, true) })()`)
const win = (js) => app.mainEval(`(() => { const w = ${WIN}; return w ? (${js}) : null })()`)
async function waitFor(fn, pred, ms = 5000) {
  let v
  for (let t = 0; t < ms; t += 100) {
    v = await fn()
    if (pred(v)) return v
    await sleep(100)
  }
  return v
}

// ── open it from the menu ───────────────────────────────────────────────────────────────────
const item = await app.mainEval(`(() => { const m = __electron.Menu.getApplicationMenu()?.getMenuItemById('quick-capture'); if (!m) return null; m.click(); return m.label })()`)
check(item === 'Quick Capture', 'the app menu has Quick Capture, and it was clicked', String(item))
const up = await waitFor(() => inWin(`!!document.querySelector('textarea[aria-label="Message"]')`), (v) => v === true)
check(up === true, 'the quick-capture window is up with its message box')
check((await win('w.isVisible()')) === true, 'and visible')

// ── the target list ─────────────────────────────────────────────────────────────────────────
const opts = await inWin(`[...document.querySelector('select[aria-label="Send to"]').options].map((o) => o.textContent)`)
check(Array.isArray(opts) && opts[0] === 'New conversation', 'the target list starts with New conversation', q(opts?.slice(0, 4)))
const known = await inWin(`window.beacon.sessions.list().then((l) => l.map((s) => ({ id: s.id, title: (s.title ?? '').trim() })))`)
const selected = await inWin(`document.querySelector('select[aria-label="Send to"]').value`)
const expected = Math.min(31, known.length + 1 + (known.some((k) => k.id === selected) ? 0 : 1))
check(Array.isArray(opts) && opts.length === expected, 'it lists the conversation in use and the most recent ones, 30 at most', `${opts?.length} rows for ${known.length} conversations`)
const titled = known.filter((k) => k.title && k.title.length <= 48)
if (titled.length === 0) console.log('[probe] SKIP  no conversation in this profile has a title, so "listed by title" cannot be shown here')
else {
  const values = await inWin(`[...document.querySelector('select[aria-label="Send to"]').options].map((o) => [o.value, o.textContent])`)
  const shown = values.filter(([v]) => titled.some((k) => k.id === v))
  check(shown.length > 0 && shown.every(([v, label]) => label === titled.find((k) => k.id === v).title), 'a conversation with a title is listed by that title, not its id', `${shown.length} checked`)
}

// ── paste a file ────────────────────────────────────────────────────────────────────────────
const TYPE = `(el, text) => { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })) }`
await inWin(`(${TYPE})(document.querySelector('textarea[aria-label="Message"]'), 'probe text, never sent to a conversation')`)
await inWin(`(() => {
  const dt = new DataTransfer()
  dt.items.add(new File(['hello from the probe'], 'probe-note.txt', { type: 'text/plain' }))
  document.querySelector('textarea[aria-label="Message"]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
})()`)
const chips = () => inWin(`[...document.querySelectorAll('[aria-label="Attached"] > span')].map((c) => c.title)`)
check(((await waitFor(chips, (v) => Array.isArray(v) && v.length === 1)) ?? [])[0] === 'probe-note.txt', 'a pasted file becomes a chip')
check((await inWin(`document.querySelector('textarea[aria-label="Message"]').value`)) === 'probe text, never sent to a conversation', 'and the text typed is untouched')

// ── the hold: the window stays up without focus only while held ─────────────────────────────
await win('(w.show(), w.focus(), true)')
await sleep(300)
await inWin(`window.beacon.capture.hold(true)`)
await sleep(150)
await win('(w.blur(), true)')
await sleep(400)
check((await win('w.isVisible()')) === true, 'held: losing focus does not hide it (this is what keeps it up behind a file picker)')
await win('(w.focus(), true)')
await sleep(300)
await win('(w.blur(), true)')
const hidden = await waitFor(() => win('w.isVisible()'), (v) => v === false, 2500)
check(hidden === false, 'focus coming back ended the hold: the next loss of focus hides it')
// Given back without any focus event: this is the picker answering.
await win('(w.show(), w.focus(), true)')
await sleep(300)
await inWin(`window.beacon.capture.hold(true)`)
await sleep(150)
await inWin(`window.beacon.capture.hold(false)`)
await sleep(150)
await win('(w.blur(), true)')
check((await waitFor(() => win('w.isVisible()'), (v) => v === false, 2500)) === false, 'a hold given back (the picker answered) no longer keeps it up')
// Another window asking, AFTER the box has focus, so nothing but the refusal can explain it hiding.
check((await app.page.evaluate(`typeof window.beacon.capture.hold`)) === 'function', 'the main window has the same bridge')
await win('(w.show(), w.focus(), true)')
await sleep(300)
await app.page.evaluate(`window.beacon.capture.hold(true)`)
await sleep(200)
await win('(w.blur(), true)')
check((await waitFor(() => win('w.isVisible()'), (v) => v === false, 2500)) === false, 'a hold asked for by another window is ignored')

// ── screenshots ─────────────────────────────────────────────────────────────────────────────
await win('(w.show(), w.focus(), true)')
await sleep(300)
const own = await win('w.getMediaSourceId()')
const listed = await inWin(`window.beacon.screenshot.sources().then((r) => ({ access: r.access, ids: r.sources.map((s) => s.id) }))`)
const control = await app.page.evaluate(`window.beacon.screenshot.sources().then((r) => r.sources.map((s) => s.id))`)
const granted = listed?.access === 'granted' && Array.isArray(listed.ids) && listed.ids.length > 0
check(Array.isArray(listed?.ids), 'the window can list what can be captured', `access: ${listed?.access}, ${listed?.ids?.length} sources`)
if (!granted) console.log('[probe] SKIP  this Electron has no Screen Recording grant, so the capture checks cannot be shown here')
else {
  // The control: the main window IS in its own list under the id main reports for it, so ids are
  // written the same way on both sides and an id match can work. (macOS does not list a floating
  // window like the box at all, so there its absence is the system's doing; the filter is what
  // keeps it out elsewhere, and @shared/quick-capture's smoke covers the filter itself.)
  const mainId = await app.mainEval(`__electron.BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#')).getMediaSourceId()`)
  check(control.includes(mainId), "main's id for a window is the id the capture list uses for it", mainId)
  check(listed.ids.includes(mainId), "the box's list still has the main window, whatever the two are titled")
  check(!listed.ids.includes(own), 'and does not have the box itself', own)
}
const fromMain = await app.page.evaluate(`window.beacon.capture.shot('screen:0:0')`)
check(fromMain?.ok === false && /quick-capture window/.test(fromMain.error ?? ''), 'a shot asked for by the main window is refused', q(fromMain))
const target = listed?.ids?.find((id) => id.startsWith('screen')) ?? 'screen:0:0'
const shotP = inWin(`window.beacon.capture.shot(${q(target)}).then((r) => ({ ok: r.ok, error: r.ok ? '' : r.error, bytes: r.ok ? r.base64.length : 0 }))`)
const wentAway = await waitFor(() => win('w.isVisible()'), (v) => v === false, 1500)
check(wentAway === false, 'the window steps out of the picture for the shot')
// The toggle during the shot must not bring it back into the picture.
await app.mainEval(`(__electron.Menu.getApplicationMenu().getMenuItemById('quick-capture').click(), true)`)
check((await win('w.isVisible()')) === false, 'the toggle does nothing while the shot is being taken')
const second = await inWin(`window.beacon.capture.shot(${q(target)}).then((r) => r.ok ? 'ok' : r.error)`)
check(/already being taken/.test(String(second)), 'and a second shot is refused meanwhile', q(second))
const shot = await shotP
if (granted) check(shot?.ok === true && shot.bytes > 10_000, 'the shot is a real picture', shot?.ok ? `${shot.bytes} base64 chars` : `not captured: ${shot?.error}`)
else check(shot?.ok === false && typeof shot.error === 'string' && shot.error.length > 0, 'with no grant the shot says why it failed', q(shot?.error))
check((await waitFor(() => win('w.isVisible()'), (v) => v === true, 2500)) === true, 'and the window is back afterwards, whether or not the capture worked')

// The button: opens the picker in the window, Esc closes the picker and not the window.
await inWin(`document.querySelector('button[aria-label="Attach a screenshot"]').click()`)
check((await waitFor(() => inWin(`!!document.querySelector('[aria-label="Capture a screenshot"]')`), (v) => v === true)) === true, 'the camera button opens the picker inside the window')
const rows = await waitFor(() => inWin(`document.querySelectorAll('[aria-label="Capture a screenshot"] button').length`), (v) => typeof v === 'number' && v > 0, 10000)
check(typeof rows === 'number' && rows > 0, 'and the picker fills in with things to capture (or the button to grant access)', String(rows))
if (SHOTS) {
  const png = await app.mainEval(`(async () => { const w = ${WIN}; return (await w.webContents.capturePage()).toPNG().toString('base64') })()`)
  if (typeof png === 'string') {
    writeFileSync(join(SHOTS, 'quick-capture.png'), Buffer.from(png, 'base64'))
    console.log(`[probe] wrote ${join(SHOTS, 'quick-capture.png')}`)
  }
}
await inWin(`document.querySelector('textarea[aria-label="Message"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
await sleep(200)
check((await inWin(`!!document.querySelector('[aria-label="Capture a screenshot"]')`)) === false, 'Esc closes the picker')
check((await win('w.isDestroyed()')) === false, 'and leaves the window open')

// ── New conversation, refused: nothing is lost ──────────────────────────────────────────────
const before = (await chips())?.length ?? 0
await inWin(`(() => { const s = document.querySelector('select[aria-label="Send to"]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, s.options[0].value); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
await sleep(150)
check((await inWin(`document.querySelector('select[aria-label="Send to"]').selectedIndex`)) === 0, 'New conversation is chosen')
check((await inWin(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Open in Beacon'))`)) === false, 'Open in Beacon is not offered for a conversation that does not exist yet')
await inWin(`document.querySelector('textarea[aria-label="Message"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`)
const note = await waitFor(() => inWin(`document.querySelector('[role="status"]')?.textContent ?? ''`), (v) => typeof v === 'string' && v.length > 0, 8000)
check(/Could not start a new conversation/.test(note ?? ''), 'with no key, starting a conversation is refused and the window says so', q(note))
check((await inWin(`document.querySelector('textarea[aria-label="Message"]').value`)) === 'probe text, never sent to a conversation', 'the text is still in the box')
check(((await chips())?.length ?? 0) === before && before >= 1, 'and so are the attached files', String(before))

await app.quit()
console.log(`[probe] ${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures} of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
