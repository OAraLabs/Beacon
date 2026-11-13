#!/usr/bin/env node
// saved-prompts-app-probe — do starters and saved prompts work IN THE REAL APP? `smoke:saved-prompts`
// proves @shared/saved-prompts; it cannot see the starter row on the new-chat screen, the dialog, or
// the `/` list in a conversation's message box. Those are React wiring, so only the built app shows
// them.
//
// RUN (not part of verify: it drives the real app on this Mac, from a scratch copy of the profile):
//   npm run build && npm run probe:saved-prompts
// PROBE_SHOT_DIR=<dir> also writes screenshots there. They show the copied profile's own session
// titles, so they are for looking at, never for committing.
//
// SENDS NOTHING. It never presses Enter in a message box and never clicks Start or Send: a starter
// is chosen by click, a `/` row by mouse-down. Every non-GET request main makes is recorded and the
// probe fails if one is a chat send. The user's own profile is copied, never opened (app-driver).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, scratchProfile, sleep, sql } from './app-driver.mjs'

const KEY = 'prompts:saved:v1'
const nonce = Math.random().toString(36).slice(2, 8)
const TITLE = `Probe ${nonce}`
const NAME = `probe-${nonce}`
const TEXT = `saved prompt probe ${nonce}: `
const SCRATCH = `beacon:prompt-probe-${Date.now().toString(36)}`
const SHOTS = process.env.PROBE_SHOT_DIR

let failures = 0
let checks = 0
function check(ok, what, detail) {
  checks++
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${what}${detail !== undefined ? `  — ${detail}` : ''}`)
  if (!ok) failures++
}

const profile = scratchProfile()
// Saved prompts are Beacon-wide (app.db); drafts and conversations belong to one Prometheus.
sql(profile, `DELETE FROM settings WHERE key = '${KEY}'`, 'beacon')
sql(profile, `DELETE FROM settings WHERE key LIKE 'draft:%'`)
sql(
  profile,
  `INSERT INTO sessions (id, gateway, title, last_active, message_count, watermark) VALUES ('${SCRATCH}', 'beacon', 'prompt probe scratch', ${Date.now()}, 0, 0)`
)

const app = await launchApp({ profile, acceptDialogs: true })
const ev = app.page.evaluate
const q = (s) => JSON.stringify(s)
async function waitFor(fn, pred, ms = 4000) {
  let v
  for (let t = 0; t < ms; t += 50) {
    v = await fn()
    if (pred(v)) return v
    await sleep(50)
  }
  return v
}
async function shot(name) {
  if (!SHOTS) return
  const r = await app.page.send('Page.captureScreenshot', { format: 'png' })
  if (!r.result?.data) return console.log('[probe] no screenshot data for ' + name)
  writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
  console.log(`[probe] wrote ${join(SHOTS, name)}`)
}
const click = (js) => ev(`(() => { const e = ${js}; if (!e) return false; e.click(); return true })()`)
const byText = (sel, text) => `[...document.querySelectorAll(${q(sel)})].find((b) => b.textContent.trim() === ${q(text)})`
async function typeInto(js, text) {
  await ev(`(() => { const e = ${js}; e.focus(); if (e.select) e.select() })()`)
  await app.page.send('Input.insertText', { text })
}

// Record what main writes to the daemon; nothing here may be a chat send.
await app.mainEval(`(() => {
  globalThis.__probeWrites = []
  const orig = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase()
    const path = String(input?.url ?? input).replace(/^[a-z]+:\\/\\/[^/]+/i, '').split('?')[0]
    if (method !== 'GET') globalThis.__probeWrites.push(method + ' ' + path)
    return orig(input, init)
  }
  return true
})()`)

// ── the new-chat screen ─────────────────────────────────────────────────────────────────────
await click(`document.querySelector('nav[aria-label="Views"] button[title="Chats"]')`)
await waitFor(() => ev(`!!document.querySelector('button.session-row')`), (v) => v === true)
await sleep(1500) // let launch-restore settle before choosing Home (see probe:launch-restore)
check(await click(`document.querySelector('button[aria-label="New chat"]')`), 'pressed New chat')
check((await waitFor(() => ev(`!!document.querySelector('.chat-home-starters')`), (v) => v === true)) === true, 'the new-chat screen has a starter row')

const chips = () => ev(`[...document.querySelectorAll('.chat-home-starters .starter-chip')].map((b) => b.textContent.trim())`)
const first = await chips()
check(first.length === 5 && first[4] === 'Edit prompts…', 'a profile with no saved prompts shows the four built-in starters and Edit prompts…', first.join(' | '))
const home = () => ev(`document.querySelector('.chat-home textarea')?.value ?? null`)
check((await home()) === '', 'the message box starts empty')
check(await click(byText('.starter-chip', first[0])), `clicked the "${first[0]}" starter`)
const filled = await waitFor(home, (v) => typeof v === 'string' && v.length > 0)
const PLAN = 'Help me plan today. Here is what is on my plate:\n\n'
check(first[0] === 'Plan my day' && filled === PLAN, 'its text is in the message box exactly as written, the blank line it ends on included', q(filled))
check((await ev(`!!document.querySelector('.chat-home')`)) === true, 'and nothing was sent: still on the new-chat screen, no conversation opened')
check((await chips()).at(-1) === 'Save as a prompt…', 'with text in the box the last chip offers Save as a prompt…')
await shot('saved-prompts-home.png')

// ── save one from the box ───────────────────────────────────────────────────────────────────
const key = async (k, code, vk, extra = {}) => {
  await app.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, ...extra })
  await app.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
}
/** Enter with the key held: a first keyDown, then auto-repeats, as a real held key sends them. */
const heldEnter = async () => {
  await app.page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  for (let i = 0; i < 3; i++) {
    await sleep(60)
    await app.page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, autoRepeat: true })
  }
  await app.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
}
const focused = () => ev(`(() => { const a = document.activeElement; return a ? a.tagName + (a.getAttribute('aria-label') ? ':' + a.getAttribute('aria-label') : '') + (a.placeholder ? ':' + a.placeholder : '') : null })()`)

check(await click(byText('.starter-chip', 'Save as a prompt…')), 'clicked Save as a prompt…')
const dlg = `document.querySelector('[role="dialog"][aria-label="Saved prompts"]')`
check((await waitFor(() => ev(`!!${dlg}`), (v) => v === true)) === true, 'the dialog opened')
check((await ev(`${dlg}.querySelector('textarea').value`)) === filled, 'on a new prompt already holding the text from the box')
check((await waitFor(focused, (v) => typeof v === 'string' && v.startsWith('INPUT'))).startsWith('INPUT'), 'with the cursor in the Name field', await focused())
const saveDisabled = () => ev(`${byText('[role="dialog"] button', 'Save')}?.disabled ?? null`)
const hintText = () => ev(`document.getElementById('saved-prompt-name-hint')?.textContent ?? ''`)
check((await saveDisabled()) === true, 'Save is off until it has a name')
await typeInto(`${dlg}.querySelector('input')`, 'status')
check((await waitFor(saveDisabled, (v) => v === false)) === false, '"status" can be saved as a name')
check(/\/status is a command, so this prompt has no \/ name/.test(await hintText()), 'and the form says it gets no / name, because /status is a command', q(await hintText()))
await typeInto(`${dlg}.querySelector('input')`, TITLE)
await typeInto(`${dlg}.querySelector('textarea')`, TEXT)
check((await waitFor(hintText, (v) => v.includes(`/${NAME}`))).includes(`type /${NAME}`), 'a free name: the form says which / name it gets', q(await hintText()))
// Esc with typed text asks first; it does not throw the text away.
await key('Escape', 'Escape', 27)
check((await waitFor(() => ev(`!!${dlg}?.querySelector('[role="alertdialog"]')`), (v) => v === true)) === true, 'Esc with text typed asks before discarding')
check(await click(byText('[role="dialog"] button', 'Keep editing')), 'Keep editing')
check((await ev(`${dlg}.querySelector('textarea').value`)) === TEXT, 'and the text is still there')
// A press on the backdrop does not close the form either.
await ev(`${dlg}.parentElement.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
await sleep(150)
check((await ev(`!!${dlg}`)) === true, 'a click outside does not close the form')
await click(byText('[role="dialog"] button', 'Save'))
const stored = await waitFor(() => ev(`window.beacon.settings.get(${q(KEY)})`), (v) => typeof v === 'string' && v.includes(TITLE))
check(typeof stored === 'string' && JSON.parse(stored).prompts.length === 1, 'the prompt is in the settings table', stored)
check(JSON.parse(stored).prompts[0].text === TEXT && JSON.parse(stored).prompts[0].title === TITLE && !('name' in JSON.parse(stored).prompts[0]), 'with its text exactly, and no stored / name')
check((await ev(`${dlg}.querySelectorAll('button[aria-label^="Change "]').length`)) === 5, 'the dialog now lists it with the four built-ins')
check((await waitFor(focused, (v) => v === 'H2')) === 'H2', 'the list rests on its heading, not on a Use button', await focused())
// A held Enter here presses nothing: no prompt is used, the dialog stays.
await heldEnter()
await sleep(200)
check((await ev(`!!${dlg}`)) === true, 'a held Enter on the list uses nothing')
await shot('saved-prompts-dialog.png')

await key('Escape', 'Escape', 27)
check((await waitFor(() => ev(`!${dlg}`), (v) => v === true)) === true, 'Esc closes the dialog')
check((await ev(`!!document.activeElement?.closest('.chat-home')`)) === true, 'and focus is back on the new-chat screen', await focused())
const after = await chips()
check(after[0] === TITLE, 'the saved prompt is the first starter on the new-chat screen', after.join(' | '))

// ── the / list in a conversation ────────────────────────────────────────────────────────────
// From here Enter IS pressed in a message box. Nothing can reach a conversation: the scratch
// profile has no key (app-driver), and the checks below are that the text stays in the box.
const picked = await ev(`(() => {
  const b = [...document.querySelectorAll('button.session-row')].find((x) => x.title.endsWith(' — ' + ${q(SCRATCH)}) || x.title === ${q(SCRATCH)})
  if (!b) return false
  b.click()
  return true
})()`)
check(picked === true, 'opened the scratch conversation')
const box = `document.querySelector('.composer-shell textarea')`
await waitFor(() => ev(`!!${box} && !document.querySelector('.chat-home')`), (v) => v === true)
await sleep(200)
await typeInto(box, `/${NAME.slice(0, 9)}`)
const rows = await waitFor(
  () => ev(`[...document.querySelectorAll('[aria-label="Slash commands"] .slash-item')].map((r) => r.textContent)`),
  (v) => Array.isArray(v) && v.length > 0
)
check(Array.isArray(rows) && rows.length > 0 && rows[0].includes(`/${NAME}`) && rows[0].includes('prompt'), 'typing / and its name lists it, tagged prompt', q(rows))
await shot('saved-prompts-slash.png')
// Chosen with a HELD Enter: the first press inserts, and the repeats must not send.
await heldEnter()
check((await waitFor(() => ev(`${box}.value`), (v) => v === TEXT)) === TEXT, 'Enter puts the prompt text in the box', q(await ev(`${box}.value`)))
check((await ev(`document.querySelectorAll('[aria-label="Slash commands"] .slash-item').length`)) === 0, 'and the list closes')
await sleep(400)
check((await ev(`${box}.value`)) === TEXT, 'the held key did not send it: the text is still in the box')

// ── the palette ─────────────────────────────────────────────────────────────────────────────
await ev(`(() => { const t = ${box}; t.focus(); t.select() })()`)
await key('Backspace', 'Backspace', 8)
check((await waitFor(() => ev(`${box}.value`), (v) => v === '')) === '', 'cleared the box')
await ev(`${box}.blur()`)
const mod = process.platform === 'darwin' ? 4 : 2
await key('k', 'KeyK', 75, { modifiers: mod })
const palette = await waitFor(() => ev(`document.activeElement?.tagName === 'INPUT' && !document.activeElement.closest('.composer-shell')`), (v) => v === true, 2500)
check(palette === true, 'the command palette opened on ⌘K')
const opening = await ev(`document.body.innerText`)
check(/Reconnect to gateway/.test(opening) && /Saved prompts…/.test(opening), 'the list it opens on still has Reconnect and Saved prompts…')
await app.page.send('Input.insertText', { text: `Use prompt: ${TITLE}` })
check((await waitFor(() => ev(`document.body.innerText.includes(${q(`Use prompt: ${TITLE}`)})`), (v) => v === true, 2000)) === true, 'typing finds "Use prompt: …" for it')
await heldEnter()
check((await waitFor(() => ev(`${box}?.value ?? null`), (v) => v === TEXT, 3000)) === TEXT, 'Enter on it puts the text in the conversation\'s box, exactly', q(await ev(`${box}?.value ?? null`)))
await sleep(400)
check((await ev(`${box}.value`)) === TEXT, 'and the held key did not send it')

const writes = await app.mainEval('globalThis.__probeWrites ?? []')
check(!writes.some((w) => /\/api\/chat/.test(w)), 'main made no chat request', writes.join(', ') || 'no writes at all')
console.log(`[probe] non-GET requests main made: ${writes.length ? writes.join(', ') : 'none'}`)

await app.quit()
console.log(`[probe] ${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures} of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
