#!/usr/bin/env node
// drafts-app-probe — does a composer draft survive a session switch, a relaunch and a forget, IN
// THE REAL APP? `smoke:drafts` proves @shared/drafts; it cannot see the half that lives in
// ChatShell's effects (StrictMode's double-run, the unmount flush, the restore adopting what it
// read). That half is React's sequencing, so the only rung that reaches it is the built app.
//
// RUN (not part of verify — it drives the real app on this Mac, from a scratch copy of the profile):
//   npm run build && EXPECT_REACT=production npm run probe:drafts
// and for the StrictMode path, which only a DEVELOPMENT React build exercises:
//   npm run build:react-dev && EXPECT_REACT=development npm run probe:drafts
// The React build is read off a live fiber, printed, and asserted when EXPECT_REACT is set. A claim
// about StrictMode needs `react build running: development` — see electron.vite.react-dev.config.ts.
//
// WRITES NOTHING TO THE DAEMON, and proves it rather than promising it:
//   * it types into composers and never sends — no Enter key is ever pressed;
//   * the forget case uses a SCRATCH session seeded into the scratch profile's cache, and main's
//     DELETE for it is answered locally — the daemon's DELETE writes a durable tombstone;
//   * any other DELETE is REFUSED, so a probe bug cannot forget a real conversation;
//   * every non-GET request main makes is recorded and printed at the end.
// The user's own profile is copied, never opened (see app-driver.mjs).
import { launchApp, reactMode, scratchProfile, sleep, sql } from './app-driver.mjs'

// `beacon:` rather than `desktop:` — the sidebar folds other sources into collapsed groups, and a row
// a probe cannot see is a row it cannot click. last_active = now puts it at the top of Today.
const SCRATCH = `beacon:draft-probe-${Date.now().toString(36)}`
const nonce = Math.random().toString(36).slice(2, 8)
const TA = `probe draft A ${nonce} — half a thought`
const TB = `probe draft B ${nonce}\nwith a second line`
const TS = `probe draft S ${nonce}`

let failures = 0
let checks = 0
function check(ok, what, detail) {
  checks++
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${what}${detail !== undefined ? `  — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log(`[probe] scratch session: ${SCRATCH}`)

const profile = scratchProfile()
sql(
  profile,
  `INSERT INTO sessions (id, gateway, title, last_active, message_count, watermark) VALUES ('${SCRATCH}', 'beacon', 'draft probe scratch', ${Date.now()}, 0, 0)`
)
// ESTABLISH the precondition, don't assume it. The scratch profile is a copy of the user's, and once
// drafts shipped the user's own profile holds draft rows — a copied one on A or B would read as a
// restore the probe never wrote. sql() refuses the live profile, so this only ever clears the copy.
sql(profile, `DELETE FROM settings WHERE key LIKE 'draft:%'`)
check(sql(profile, `SELECT count(*) FROM settings WHERE key LIKE 'draft:%'`) === '0', 'the scratch profile starts with no draft rows')

// ── helpers bound to one launch ─────────────────────────────────────────────────────────────
/** Why the last select() failed — a failed step has to say what it saw, or the next person guesses. */
let lastSelectMiss = ''
function bind(app) {
  const ev = app.page.evaluate
  const q = (s) => JSON.stringify(s)
  const composer = () => ev(`document.querySelector('.composer-shell textarea')?.value ?? null`)
  const setting = (key) => ev(`window.beacon.settings.get(${q(key)})`)
  async function waitFor(fn, pred, ms = 3000) {
    let v
    for (let t = 0; t < ms; t += 50) {
      v = await fn()
      if (pred(v)) return v
      await sleep(50)
    }
    return v
  }
  /** Open Chats and wait for LAUNCH TO SETTLE before anything clicks a session.
   *
   *  MainView's launch-restore resolves after the list first renders. It used to call
   *  setActive(last) unconditionally, so a click in that window was overridden by the restored
   *  session; and the list can re-render under the click. Measured on the development build: 4 of 6
   *  runs lost their first select to one or the other ("active: <the last session>" / "row not in
   *  the list at click time"). The override is fixed — the restore now yields to any choice made
   *  since mount, proven by probe:launch-restore — but the list can still re-render under a click, so
   *  the wait stays: for the restored session to be active (when it is listed), then for two
   *  identical snapshots of the list 300ms apart. */
  async function toChats() {
    await ev(`document.querySelector('nav[aria-label="Views"] button[title="Chats"]')?.click()`)
    const up = await waitFor(() => ev(`!!document.querySelector('button.session-row')`), (v) => v === true)
    if (up !== true) return false
    const last = await ev(`window.beacon.settings.get('session:last:v1')`)
    const listed = await ev(`[...document.querySelectorAll('button.session-row')].some((b) => b.title.endsWith(${q(String(last))}))`)
    if (last && listed) {
      await waitFor(() => ev(`document.querySelector('button.session-row.is-active')?.title.endsWith(${q(String(last))}) ?? false`), (v) => v === true, 5000)
    }
    const snap = () => ev(`[...document.querySelectorAll('button.session-row')].map((b) => b.title).join('|') + '#' + (document.querySelector('button.session-row.is-active')?.title ?? '')`)
    let prev = await snap()
    for (let i = 0; i < 20; i++) {
      await sleep(300)
      const next = await snap()
      if (next === prev) break
      prev = next
    }
    return true
  }
  /** Select a session by clicking its sidebar row; resolves once that row is the active one AND
   *  its composer is mounted. `settle` is extra time for effects — 0 for the "switch immediately" cases. */
  async function select(id, settle = 60) {
    lastSelectMiss = ''
    const clicked = await ev(`(() => {
      const b = [...document.querySelectorAll('button.session-row')].find((x) => x.title === ${q(id)} || x.title.endsWith(' — ' + ${q(id)}))
      if (!b) return false
      b.click()
      return true
    })()`)
    if (!clicked) {
      lastSelectMiss = `row for ${id} not in the list at click time (${await ev(`document.querySelectorAll('button.session-row').length`)} rows)`
      return false
    }
    const ok = await waitFor(
      () => ev(`(() => {
        const a = document.querySelector('button.session-row.is-active')
        return !!a && (a.title === ${q(id)} || a.title.endsWith(' — ' + ${q(id)})) && !!document.querySelector('.composer-shell textarea')
      })()`),
      (v) => v === true
    )
    if (settle) await sleep(settle)
    if (ok !== true) {
      lastSelectMiss = 'clicked, but after 3s: ' + JSON.stringify(await ev(`({ active: document.querySelector('button.session-row.is-active')?.title.split(' — ').pop() ?? null, composer: !!document.querySelector('.composer-shell textarea'), alert: [...document.querySelectorAll('[role=alert]')].map((a) => a.innerText.slice(0, 80)), rows: document.querySelectorAll('button.session-row').length })`))
    }
    return ok === true
  }
  const activeId = () => ev(`document.querySelector('button.session-row.is-active')?.title.split(' — ').pop() ?? null`)
  /** Type into the composer of `id` — and ONLY if `id` is the open session. Typing into whatever
   *  happens to be open after a failed select writes one session's text into another's draft, and
   *  every later line then reports on the contamination instead of the code. */
  async function type(id, text) {
    if ((await activeId()) !== id) return `NOT TYPED: ${await activeId()} is open, not ${id}`
    await ev(`document.querySelector('.composer-shell textarea').focus()`)
    await app.page.send('Input.insertText', { text })
    return waitFor(composer, (v) => v === text, 1500)
  }
  async function clearComposer() {
    await ev(`(() => { const t = document.querySelector('.composer-shell textarea'); t.focus(); t.select() })()`)
    await app.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await app.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    return waitFor(composer, (v) => v === '', 1500)
  }
  return { ev, composer, setting, waitFor, toChats, select, type, clearComposer }
}

/** Main-process guard: answer the scratch DELETE locally, refuse every other DELETE, record the rest. */
async function guardDaemonWrites(app) {
  const r = await app.mainEval(`(() => {
    globalThis.__probeWrites = []
    const orig = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = String(input?.url ?? input)
      const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase()
      const path = url.replace(/^[a-z]+:\\/\\/[^/]+/i, '')
      if (method !== 'GET') globalThis.__probeWrites.push(method + ' ' + path.split('?')[0])
      if (method === 'DELETE') {
        const ours = path === '/api/sessions/' + encodeURIComponent(${JSON.stringify(SCRATCH)})
        return new Response(JSON.stringify(ours ? { ok: true } : { error: 'refused by drafts-app-probe' }), {
          status: ours ? 200 : 500,
          headers: { 'content-type': 'application/json' }
        })
      }
      return orig(input, init)
    }
    return typeof globalThis.fetch === 'function'
  })()`)
  if (r !== true) throw new Error('could not install the main-process write guard: ' + JSON.stringify(r))
}
const writesOf = (app) => app.mainEval('globalThis.__probeWrites ?? []')

// ── launch 1: switch, debounce, flush, forget ──────────────────────────────────────────────
let app = await launchApp({ profile, acceptDialogs: true })
await guardDaemonWrites(app)
let d = bind(app)
const react = await reactMode(app.page)
console.log(`[probe] react build running: ${react}`)
if (process.env.EXPECT_REACT) check(react === process.env.EXPECT_REACT, `the running React build is ${process.env.EXPECT_REACT}`, react)
check((await d.toChats()) === true, 'launch 1: the Chats view is up with a session list')

const rows = await d.ev(`[...document.querySelectorAll('button.session-row')].map((b) => b.title.split(' — ').pop())`)
const [A, B] = rows.filter((id) => id !== SCRATCH)
check(!!A && !!B && A !== B, 'two real sessions to switch between', `${rows.length} rows listed`)
check(rows.includes(SCRATCH), 'the seeded scratch session is listed (the sidebar reads the cache)')

check(await d.select(A), 'selected A', lastSelectMiss || undefined)
check((await d.composer()) === '', "A's composer starts empty (no draft row yet)")
check((await d.type(A, TA)) === TA, 'typed into A')
// Stay on A past the debounce: THIS write is the timer's, since nothing has unmounted.
await sleep(700)
check((await d.setting(`draft:${A}`)) === TA, 'the debounced write reached the durable store while A stayed open')

// Switch away IMMEDIATELY and back. The in-memory tier has to carry it — no store read, no race.
const TA2 = TA + ', finished'
check((await d.type(A, ', finished')) === TA2, 'typed more into A')
check(await d.select(B, 0), 'switched to B at once')
check((await d.composer()) === '', "B's composer does not show A's draft (drafts are per-session)")
check(await d.select(A, 0), 'switched back to A')
check((await d.composer()) === TA2, "A's newest text came back on an in-app switch", JSON.stringify(await d.composer()))

// The unmount flush: type in B and leave inside the debounce. The pending timer is CLEARED on
// unmount, so without the flush draft:B would never be written — waiting longer cannot mask that.
check(await d.select(B), 'selected B')
check((await d.type(B, TB)) === TB, 'typed a two-line draft into B')
check(await d.select(A, 0), 'left B inside the debounce window')
check((await d.composer()) === TA2, "A still shows A's draft")
await sleep(900)
check((await d.setting(`draft:${B}`)) === TB, 'the unmount flush wrote B (its debounce timer was cleared)')

// Forget, while the scratch session is OPEN and holding a draft: main deletes the row, then the
// switch-away unmounts ChatShell and its flush runs — which must not write the row back.
check(await d.select(SCRATCH), 'selected the scratch session')
check((await d.type(SCRATCH, TS)) === TS, 'typed into the scratch session')
await sleep(700)
check((await d.setting(`draft:${SCRATCH}`)) === TS, 'the scratch draft is durable before the forget')
// window.confirm is a NATIVE modal in Electron: it blocks main's thread, so CDP can neither see nor
// dismiss it. Stand in for the person's click — record the question, answer yes — and assert it asked.
await d.ev(`window.__probeConfirms = []; window.confirm = (m) => { window.__probeConfirms.push(String(m)); return true }; true`)
await d.ev(`document.querySelector('button.session-forget[aria-label=${JSON.stringify(`Forget session ${SCRATCH}`)}]').click()`)
await d.waitFor(() => d.ev(`[...document.querySelectorAll('button.session-row')].some((b) => b.title.endsWith(${JSON.stringify(SCRATCH)}))`), (v) => v === false)
check((await d.ev('window.__probeConfirms')).some((m) => m.includes(SCRATCH)), 'the forget asked for confirmation, naming the session')
await sleep(1200)
check((await d.setting(`draft:${SCRATCH}`)) === null, 'the forgotten draft row stays deleted — the unmount flush did not resurrect it', JSON.stringify(await d.setting(`draft:${SCRATCH}`)))
const w1 = await writesOf(app)
check(
  w1.filter((x) => x.startsWith('DELETE')).length === 1 && w1.includes(`DELETE /api/sessions/${encodeURIComponent(SCRATCH)}`),
  'exactly one DELETE, for the scratch session, answered locally',
  JSON.stringify(w1)
)
await sleep(500) // the last keystroke is > 400ms old; quitting now tests the debounce, not luck
await app.quit()

// ── launch 2: a relaunch restores from the durable store (the memory tier is gone) ────────────
app = await launchApp({ profile, acceptDialogs: true })
await guardDaemonWrites(app)
d = bind(app)
check((await d.toChats()) === true, 'launch 2: the Chats view is up')
check(await d.select(A), 'selected A after relaunch', lastSelectMiss || undefined)
check((await d.waitFor(d.composer, (v) => v === TA2)) === TA2, "A's draft was restored from the durable store after a relaunch", JSON.stringify(await d.composer()))
check(await d.select(B), 'selected B after relaunch')
check((await d.waitFor(d.composer, (v) => v === TB)) === TB, "B's two-line draft was restored verbatim")
check(
  !(await d.ev(`[...document.querySelectorAll('button.session-row')].some((b) => b.title.endsWith(${JSON.stringify(SCRATCH)}))`)),
  'the forgotten session did not come back'
)
check((await d.setting(`draft:${SCRATCH}`)) === null, 'and neither did its draft row')

// Clearing is a WRITE of '' (what send does), not a skipped write — or the text resurrects.
check(await d.select(A), 'back to A')
check((await d.clearComposer()) === '', "cleared A's composer")
await sleep(700)
const cleared = await d.setting(`draft:${A}`)
check(cleared === '' || cleared === null, 'clearing emptied the durable row rather than leaving the old text', JSON.stringify(cleared))
await sleep(300)
await app.quit()

// ── launch 3: nothing resurrects ─────────────────────────────────────────────────────────────
app = await launchApp({ profile, acceptDialogs: true })
await guardDaemonWrites(app)
d = bind(app)
check((await d.toChats()) === true, 'launch 3: the Chats view is up')
check(await d.select(A), 'selected A', lastSelectMiss || undefined)
await sleep(800) // give a (wrong) restore every chance to land
check((await d.composer()) === '', 'the cleared draft did not come back on relaunch', JSON.stringify(await d.composer()))
check(await d.select(B), 'selected B')
check((await d.waitFor(d.composer, (v) => v === TB)) === TB, "B's draft survived a second relaunch untouched")
check((await d.clearComposer()) === '', 'cleared B (leaves the scratch profile tidy)')
await sleep(700)
const w3 = await writesOf(app)
await app.quit()

console.log(`\n[probe] non-GET requests main made, launch 1: ${JSON.stringify(w1)}   launch 3: ${JSON.stringify(w3)}`)
console.log(`[probe] react build driven: ${react}   profile: ${profile}`)
console.log(failures === 0 ? `[probe] drafts-app: all ${checks} checks passed` : `[probe] drafts-app: ${failures} of ${checks} FAILED`)
process.exit(failures === 0 ? 0 : 1)
