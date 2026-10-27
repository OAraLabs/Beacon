#!/usr/bin/env node
// launch-restore-app-probe — does a choice made while launch-restore is still in flight SURVIVE it,
// in the real app? MainView's launch-restore lists the sessions, then reads `session:last:v1`, then
// opens that session. The list paints before the read returns, so a person can pick something in
// between — and until the fix, the restore then opened the last session over their pick.
//
// RUN (not part of verify — it drives the real app on this Mac, from a scratch copy of the profile):
//   npm run build:react-dev && EXPECT_REACT=development npm run probe:launch-restore
// (StrictMode runs the restore twice on a development build, so that is the build that matters; a
// production build runs it once.) RUNS=5 repeats the whole thing on a fresh launch each time.
//
// Each case RELOADS the renderer with a watcher registered to run before the page's own scripts,
// so "the instant the first row appears" is measured inside the page, not by polling over CDP. A
// reload is a full renderer launch for this purpose: MainView mounts fresh and the restore runs
// from the top. Main's `settings:get` is wrapped so the probe can SEE the restore's read of
// `session:last:v1` — when it was served and what it returned — and, in one case, hold its reply.
//
// THE CASES, and why there are three:
//   row-window    click a row AFTER the restore has read the old id and BEFORE it applies it.
//                 This is the losing interleaving, constructed rather than hoped for: main holds
//                 the read's reply (the value is read on receipt), clicks through the page, then
//                 releases it. Every held read must have returned the old id, or the case did not
//                 test the window and says so.
//   row-instant   click a row the instant the first one paints. This is the literal symptom, but
//                 NOT a reliable detector: select() writes `session:last:v1` itself, and a read
//                 issued after that write returns the clicked id — the restore then "restores"
//                 the click. Whether it did is printed, from the read the restore actually got.
//   home-instant  press New chat the instant the first row paints. goHome() writes nothing, so
//                 no read can rescue it: the whole list fan-out is its window, not one round trip.
//
// WRITES NOTHING TO THE DAEMON: no credential in the scratch profile, so every /api/ call 401s
// (see app-driver.mjs). It writes `session:last:v1` in the SCRATCH profile only.
import { launchApp, reactMode, scratchProfile, sleep, sql } from './app-driver.mjs'

const LAST_KEY = 'session:last:v1'
const RUNS = Number(process.env.RUNS ?? 1)
const CASES = (process.env.CASES ?? 'row-window,row-instant,home-instant').split(',')
const SURVIVE_MS = 2000

let failures = 0
let checks = 0
const tally = {} // case → { pass, fail }
function check(ok, what, detail) {
  checks++
  console.log(`[probe]   ${ok ? 'PASS' : 'FAIL'}  ${what}${detail !== undefined ? `  — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}

/** Runs in the page before any of its scripts, on every load while registered. Opens Chats as soon
 *  as the nav exists, records when the first session row paints, and — per case — acts on it. It
 *  also keeps a timeline of which row is active, so an override that comes and goes is still seen. */
function watcher(mode, last) {
  return `(() => {
    const cfg = ${JSON.stringify({ mode, last })}
    const idOf = (b) => b.title.split(' — ').pop()
    const st = (window.__probe = { cfg, chatsAt: null, firstRowAt: null, clicked: null, clickedAt: null, timeline: [], lastActive: undefined, error: null })
    const act = () => {
      if (cfg.mode === 'row-instant') {
        const b = [...document.querySelectorAll('button.session-row')].find((r) => idOf(r) !== cfg.last)
        if (!b) return (st.error = 'no row other than the last session')
        st.clicked = idOf(b)
        st.clickedAt = Date.now() // stamped BEFORE the click: everything it causes is at or after this
        b.click()
      } else if (cfg.mode === 'home-instant') {
        const n = document.querySelector('button[aria-label="New chat"]')
        if (!n) return (st.error = 'no New chat button')
        st.clicked = 'HOME'
        st.clickedAt = Date.now()
        n.click()
      }
    }
    // row-window: main calls this while it holds the restore's read.
    window.__probeClick = async () => {
      const b = [...document.querySelectorAll('button.session-row')].find((r) => idOf(r) !== cfg.last)
      if (!b) return { error: 'no row other than the last session', rows: document.querySelectorAll('button.session-row').length }
      st.clicked = idOf(b)
      st.clickedAt = Date.now()
      b.click()
      await new Promise((r) => setTimeout(r, 50))
      const a = document.querySelector('button.session-row.is-active')
      return { id: st.clicked, activeAfterClick: a ? idOf(a) : null }
    }
    const tick = () => {
      if (!st.chatsAt) {
        const nav = document.querySelector('nav[aria-label="Views"] button[title="Chats"]')
        if (nav) {
          nav.click()
          st.chatsAt = Date.now()
        }
      }
      if (st.firstRowAt === null && document.querySelector('button.session-row')) {
        st.firstRowAt = Date.now()
        if (cfg.mode !== 'row-window') act()
      }
      const a = document.querySelector('button.session-row.is-active')
      const id = document.querySelector('.chat-home') ? 'HOME' : a ? idOf(a) : null
      if (id !== st.lastActive) {
        st.timeline.push([Date.now(), id])
        st.lastActive = id
      }
    }
    new MutationObserver(tick).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
  })()`
}

/** Main-process instrumentation: wrap `settings:get` to record (and optionally hold) reads of the
 *  launch key, and record every `session:active` the renderer sends. Installed once per launch. */
const INSTRUMENT = `(() => {
  const { ipcMain } = __electron
  if (globalThis.__probeRestore) return 'already'
  const orig = ipcMain._invokeHandlers && ipcMain._invokeHandlers.get('settings:get')
  if (typeof orig !== 'function') return 'no settings:get handler to wrap'
  const P = (globalThis.__probeRestore = { hold: false, reads: [], actives: [], waiters: [], click: null, quiet: null })
  ipcMain.removeHandler('settings:get')
  ipcMain.handle('settings:get', async (e, key) => {
    const v = await orig(e, key) // the store is read HERE, on receipt — holding only delays the reply
    if (key !== ${JSON.stringify(LAST_KEY)}) return v
    const r = { at: Date.now(), value: v, held: P.hold && !P.click, releasedAt: null }
    P.reads.push(r)
    if (r.held) {
      await new Promise((res) => {
        P.waiters.push(res)
        clearTimeout(P.quiet)
        // A development build runs the restore twice; wait for the reads to go quiet so every
        // chain is inside the window, then click, then let them all go.
        P.quiet = setTimeout(async () => {
          P.click = { at: Date.now(), result: null, error: null }
          try {
            P.click.result = await e.sender.executeJavaScript('window.__probeClick ? window.__probeClick() : { error: "no __probeClick" }')
          } catch (err) {
            P.click.error = String(err)
          }
          for (const w of P.waiters.splice(0)) w()
        }, 300)
      })
    }
    r.releasedAt = Date.now()
    return v
  })
  ipcMain.on('session:active', (_e, id) => P.actives.push({ at: Date.now(), id }))
  return 'installed'
})()`

async function reload(app) {
  const before = await app.page.evaluate('performance.timeOrigin')
  let loaded = false
  const armed = { on: true }
  app.page.on((m) => {
    if (armed.on && m.method === 'Page.loadEventFired') loaded = true
  })
  await app.page.send('Page.reload', { ignoreCache: true })
  for (let i = 0; i < 80 && !loaded; i++) await sleep(100)
  armed.on = false
  const after = await app.page.evaluate('performance.timeOrigin')
  // A reload that returned without reloading has fooled this repo's probes before: demand the
  // document actually changed, not just that the command came back.
  return loaded && typeof after === 'number' && after !== before
}

const fmt = (t, zero) => (t == null ? '—' : `+${t - zero}ms`)

async function runCase(app, mode, L) {
  console.log(`[probe]  case ${mode}`)
  const ev = app.page.evaluate
  // The launch key points at L, a listed session, before each reload.
  await ev(`window.beacon.settings.set(${JSON.stringify(LAST_KEY)}, ${JSON.stringify(L)})`)
  check((await ev(`window.beacon.settings.get(${JSON.stringify(LAST_KEY)})`)) === L, `${LAST_KEY} is ${L} going in`)
  await app.mainEval(`(() => { const P = globalThis.__probeRestore; P.reads = []; P.actives = []; P.click = null; P.waiters = []; P.hold = ${mode === 'row-window'}; return true })()`)

  const { result } = await app.page.send('Page.addScriptToEvaluateOnNewDocument', { source: watcher(mode, L) })
  const reloaded = await reload(app)
  if (!check(reloaded, 'the renderer really reloaded (load event AND a new timeOrigin)')) return false

  // Wait for the case's action, then give the restore SURVIVE_MS to do its worst.
  let st
  for (let i = 0; i < 100; i++) {
    st = await ev('window.__probe')
    const clicked = await app.mainEval('!!globalThis.__probeRestore.click')
    if (st?.clickedAt && (mode !== 'row-window' || clicked)) break
    await sleep(100)
  }
  await sleep(SURVIVE_MS)
  st = await ev('window.__probe')
  const P = await app.mainEval('(() => { const P = globalThis.__probeRestore; return { reads: P.reads, actives: P.actives, click: P.click } })()')
  await app.page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: result.identifier })

  const zero = st?.firstRowAt ?? 0
  const now = await ev(`(() => {
    const a = document.querySelector('button.session-row.is-active')
    return { home: !!document.querySelector('.chat-home'), active: a ? a.title.split(' — ').pop() : null, lastRow: [...document.querySelectorAll('button.session-row')].some((b) => b.title.split(' — ').pop() === ${JSON.stringify(L)}) }
  })()`)
  const want = st?.clicked
  console.log(
    `[probe]    first row ${new Date(zero).toISOString().slice(11, 23)}; clicked ${JSON.stringify(want)} at ${fmt(st?.clickedAt, zero)}; ` +
      `restore read(s) of ${LAST_KEY}: ${P.reads.map((r) => `${JSON.stringify(r.value)} served ${fmt(r.at, zero)}${r.held ? ` held→${fmt(r.releasedAt, zero)}` : ''}`).join(', ') || 'none'}`
  )
  console.log(`[probe]    active timeline: ${st?.timeline.map(([t, id]) => `${fmt(t, zero)} ${id}`).join(' → ')}`)
  console.log(`[probe]    main session:active: ${P.actives.map((a) => `${fmt(a.at, zero)} ${JSON.stringify(a.id)}`).join(' → ') || 'none'}`)

  // ── the case happened the way it claims (else it says nothing about the fix) ──
  check(!st?.error && !!want, 'the probe acted', st?.error ?? `clicked ${JSON.stringify(want)}`)
  check(want !== L, 'what it picked is NOT the last session', `last=${L}`)
  check(P.reads.length >= 1, 'the restore read the launch key at least once in this load', `${P.reads.length} read(s)`)
  check(now.lastRow, 'the last session is listed and painted (so an override would be visible)')
  if (mode === 'row-window') {
    check(!!P.click && !P.click.error && P.click.result?.id === want && P.click.result?.activeAfterClick === want, 'the click landed while the restore was held, and took', JSON.stringify(P.click))
    check(
      P.reads.every((r) => r.held && r.value === L && r.releasedAt >= st.clickedAt),
      `every restore read was held, returned the OLD id (${L}), and was released after the click — the losing interleaving`,
      JSON.stringify(P.reads)
    )
  } else if (mode === 'home-instant') {
    // New chat writes nothing, so the restore reads the old id however late it runs — but only a
    // restore that read AFTER the press could have overridden it. Otherwise this case is vacuous.
    check(
      P.reads.every((r) => r.at >= st.clickedAt && r.value === L),
      `every restore read came after the press and returned the last session (${L}) — the restore wanted to override Home`,
      JSON.stringify(P.reads)
    )
  } else {
    const after = P.reads.filter((r) => r.at >= st.clickedAt)
    console.log(
      `[probe]    note: ${after.length} of ${P.reads.length} restore read(s) were served after the click; they returned ${JSON.stringify(after.map((r) => r.value))}` +
        (after.length && after.every((r) => r.value === want) ? ' — the click\'s own write answered the restore, so this interleaving cannot show the bug' : '')
    )
  }

  // ── the claim ──
  const survived = mode === 'home-instant' ? now.home && now.active === null : now.active === want && !now.home
  const tl = st?.timeline ?? []
  const iClick = tl.findIndex(([t]) => t >= st.clickedAt)
  const overridden = (iClick < 0 ? [] : tl.slice(iClick)).some(([, id]) => id === L)
  const mainLast = P.actives.filter((a) => a.at >= st.clickedAt).pop()?.id
  const mainWant = mode === 'home-instant' ? '' : want
  const c1 = check(survived, `${SURVIVE_MS}ms later the choice is still what is showing`, JSON.stringify(now))
  const c2 = check(!overridden, 'the last session never took over after the click, not even briefly', tl.map(([, id]) => id).join(' → '))
  const c3 = check(mainLast === mainWant, 'main was last told the chosen target, not the restored one', `last session:active ${JSON.stringify(mainLast)}`)
  const ok = c1 && c2 && c3
  tally[mode] ??= { pass: 0, fail: 0 }
  tally[mode][ok ? 'pass' : 'fail']++
  return ok
}

let react = 'unknown'
for (let run = 1; run <= RUNS; run++) {
  console.log(`[probe] ── run ${run}/${RUNS} ──`)
  const profile = scratchProfile()
  // The side panel can hide the session list; this probe needs the list.
  sql(profile, `INSERT OR REPLACE INTO settings (key, value) VALUES ('panel:open:v1', '0')`, 'beacon')
  const app = await launchApp({ profile })
  try {
    const inst = await app.mainEval(INSTRUMENT)
    if (inst !== 'installed') throw new Error('main instrumentation: ' + JSON.stringify(inst))
    // Positive signal that the wrapper is the handler now: one read through it must be recorded.
    // Let the launch's own restore finish first — it can still be reading when the nav is up.
    await sleep(2000)
    const early = await app.mainEval('globalThis.__probeRestore.reads.length')
    await app.mainEval('(globalThis.__probeRestore.reads = [], true)')
    await app.page.evaluate(`window.beacon.settings.get(${JSON.stringify(LAST_KEY)})`)
    const seen = await app.mainEval('globalThis.__probeRestore.reads.length')
    if (seen !== 1) throw new Error(`the settings:get wrapper did not see exactly one read (${seen})`)
    console.log(`[probe]  main wrapper installed (${early} launch read(s) of ${LAST_KEY} were still arriving after the nav was up)`)

    react = await reactMode(app.page)
    console.log(`[probe]  react build running: ${react}`)
    if (process.env.EXPECT_REACT) check(react === process.env.EXPECT_REACT, `the running React build is ${process.env.EXPECT_REACT}`, react)

    // L = the first painted row: listed (so resolveLaunchTarget keeps it) and visible.
    await app.page.evaluate(`document.querySelector('nav[aria-label="Views"] button[title="Chats"]')?.click()`)
    let rows = []
    for (let i = 0; i < 60 && rows.length < 2; i++) {
      rows = await app.page.evaluate(`[...document.querySelectorAll('button.session-row')].map((b) => b.title.split(' — ').pop())`)
      if (rows.length < 2) await sleep(100)
    }
    if (rows.length < 2) throw new Error(`need two painted session rows, found ${rows.length}`)
    const L = rows[0]
    console.log(`[probe]  last session for this run: ${L}  (${rows.length} rows painted)`)
    for (const mode of CASES) await runCase(app, mode, L)
  } finally {
    await app.quit()
  }
}

console.log(`\n[probe] react build driven: ${react}`)
for (const [mode, t] of Object.entries(tally)) {
  const aside = mode === 'row-instant' ? '   (not a detector: passes with or without the fix — see the header)' : ''
  console.log(`[probe] ${mode.padEnd(13)} survived ${t.pass}/${t.pass + t.fail}${aside}`)
}
console.log(failures === 0 ? `[probe] launch-restore: all ${checks} checks passed` : `[probe] launch-restore: ${failures} of ${checks} FAILED`)
process.exit(failures === 0 ? 0 : 1)
