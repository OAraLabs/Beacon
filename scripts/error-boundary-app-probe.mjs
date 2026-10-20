#!/usr/bin/env node
// error-boundary-app-probe — when a panel throws IN THE REAL APP, what does a person see, and can they
// get out? `smoke:error-boundary` asserts the wiring on the source. It cannot see a catch (SSR
// propagates throws) and it cannot see LAYOUT: a fallback can sit outside a navigation element in
// the tree and still paint over it on screen. Both questions are answered here, on the built app.
//
// RUN (not part of verify — it drives the real app on this Mac, from a scratch copy of the profile):
//   npm run build && npm run probe:error-boundary
//   PROBE_CLICK=hand npm run probe:error-boundary   # section 5 waits for YOU to click "Reload Beacon"
//
// HOW A PANEL IS MADE TO THROW, without shipping a test hook: the probe finds a component inside the
// target subtree through React's fiber and sets one of its own list states to `[null]` via that
// hook's dispatch — the same path a daemon frame takes into state. The next render dereferences the
// null and throws, exactly as it would on an unexpected shape. Which component was hit is printed.
//
// WHAT COUNTS AS "RELOADED" (section 5): a marker set on `window` before "Reload Beacon" is pressed is
// gone after it. Every other reload in this file is CDP Page.reload, which is not the button's path.
//
// WHAT COUNTS AS "REACHABLE": a real hit test (elementFromPoint at the control's centre) and a real
// mouse click at those coordinates (Input.dispatchMouseEvent). `element.click()` would succeed on a
// control buried under an opaque overlay, which is precisely the defect this exists to catch.
//
// Writes nothing to the daemon: the scratch profile has no credential (see app-driver.mjs).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, reactMode, scratchProfile, sleep } from './app-driver.mjs'

let failures = 0
let checks = 0
function check(ok, what, detail) {
  checks++
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${what}${detail !== undefined ? `  — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── page-side helpers, installed once per page load ────────────────────────────────────────────
const HELPERS = `(() => {
  const fiberOf = (el) => { const k = el && Object.keys(el).find((x) => x.startsWith('__reactFiber$')); return k ? el[k] : null }
  const rootFiber = () => { const r = document.getElementById('root'); const k = Object.keys(r).find((x) => x.startsWith('__reactContainer$')); return r[k] }
  const isFn = (f) => f && (f.tag === 0 || f.tag === 11 || f.tag === 14 || f.tag === 15)
  const isBoundary = (f) => f && f.tag === 1 && typeof f.type?.getDerivedStateFromError === 'function'
  const arrayHooks = (f) => {
    const out = []
    for (let h = f.memoizedState, i = 0; h; h = h.next, i++) {
      if (h.queue && typeof h.queue.dispatch === 'function' && Array.isArray(h.memoizedState)) out.push({ h, i })
    }
    return out
  }
  const nameOf = (f) => f.type?.displayName || f.type?.name || (f.type?.render?.name) || 'anonymous'
  const visit = (f, fn) => { for (let c = f.child; c; c = c.sibling) { if (fn(c) === true || visit(c, fn)) return true } return false }
  const alerts = () => [...document.querySelectorAll('[role="alert"]')].filter((a) => a.getBoundingClientRect().width > 0)
  const reachEl = (el) => {
    if (!el) return { found: false }
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { found: true, x, y, reachable: !!hit && (hit === el || el.contains(hit)), hit: hit ? hit.tagName + (hit.getAttribute('role') ? '[role=' + hit.getAttribute('role') + ']' : '') : null }
  }
  window.__probe = {
    alerts,
    /** Every boundary fiber currently mounted, with its label. */
    boundaries() {
      const out = []
      visit(rootFiber(), (f) => { if (isBoundary(f)) out.push(f.memoizedProps?.label ?? '(root)') })
      return out
    },
    /** Walk UP from a DOM element to the nearest function component holding an array state that
     *  matches, and poison it. Used for ChatShell, whose composer it renders directly. */
    poisonAbove(selector, preferKey) {
      let f = fiberOf(document.querySelector(selector))
      for (; f; f = f.return) {
        if (isBoundary(f)) return 'reached a boundary without finding array state'
        if (!isFn(f)) continue
        const hooks = arrayHooks(f)
        const pick = hooks.find(({ h }) => h.memoizedState.length && h.memoizedState[0] && preferKey in Object(h.memoizedState[0])) || null
        if (pick) { pick.h.queue.dispatch([null]); return nameOf(f) + ' hook#' + pick.i }
      }
      return 'no candidate'
    },
    /** Poison array states INSIDE the boundary whose label matches, one at a time, until that
     *  boundary shows its fallback. Returns the component that threw. */
    async poisonInside(labelRe) {
      const re = new RegExp(labelRe)
      let target = null
      visit(rootFiber(), (f) => { if (isBoundary(f) && re.test(String(f.memoizedProps?.label ?? '(root)'))) { target = f; return true } })
      if (!target) return 'no boundary labelled ' + labelRe
      // Lists first ([null]), then object state (null): a pane with nothing loaded may hold no list
      // at all, but it still dereferences its state object on render.
      const cands = []
      visit(target, (f) => { if (isFn(f)) for (const c of arrayHooks(f)) cands.push({ f, ...c, poison: [null] }) })
      visit(target, (f) => {
        if (!isFn(f)) return
        for (let h = f.memoizedState, i = 0; h; h = h.next, i++) {
          const v = h.memoizedState
          if (h.queue && typeof h.queue.dispatch === 'function' && v && typeof v === 'object' && !Array.isArray(v)) cands.push({ f, h, i, poison: null })
        }
      })
      for (const c of cands) {
        c.h.queue.dispatch(c.poison)
        await new Promise((r) => setTimeout(r, 120))
        if (alerts().length) return nameOf(c.f) + ' hook#' + c.i + ' := ' + JSON.stringify(c.poison) + ' (' + cands.length + ' candidates)'
      }
      return 'none of ' + cands.length + ' candidates threw'
    },
    /** Poison the shell itself (MainView's session list) — only the ROOT boundary is above it. */
    poisonShell() {
      let found = null
      visit(rootFiber(), (f) => {
        if (!isFn(f)) return
        for (const { h, i } of arrayHooks(f)) {
          const x = h.memoizedState[0]
          if (x && typeof x === 'object' && 'id' in x && 'gateway' in x && 'lastActive' in x) { found = { h, i, f }; return true }
        }
      })
      if (!found) return 'no session-list state found'
      found.h.queue.dispatch([null])
      return nameOf(found.f) + ' hook#' + found.i
    },
    /** Centre of an element, and whether a hit test there lands on it (not on something covering it). */
    reach(selector) {
      return reachEl(document.querySelector(selector))
    },
    /** The same, for a button inside the visible fallback, found by its exact label. */
    button(label) {
      const a = alerts()[0]
      return reachEl(a && [...a.querySelectorAll('button')].find((b) => b.innerText.trim() === label))
    },
    alertInfo() {
      const a = alerts()[0]
      if (!a) return null
      const cs = getComputedStyle(a)
      const r = a.getBoundingClientRect()
      return {
        position: cs.position,
        coversWindow: r.left <= 1 && r.top <= 1 && r.width >= innerWidth - 2 && r.height >= innerHeight - 2,
        text: a.innerText.replace(/\\s+/g, ' ').trim(),
        buttons: [...a.querySelectorAll('button')].map((b) => b.innerText.trim())
      }
    }
  }
  return true
})()`

const q = JSON.stringify
const RAIL = (title) => `nav[aria-label="Views"] button[title=${q(title)}]`
const ROW = (id) => `button.session-row[title$=${q(id)}]`

const profile = scratchProfile()
const app = await launchApp({ profile })
const { page } = app
const ev = page.evaluate
const caught = []
await page.send('Runtime.enable')
page.on((m) => {
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    const t = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
    if (t.includes('render error caught by ErrorBoundary')) caught.push(t.slice(0, 160))
  }
})
console.log(`[probe] react build running: ${await reactMode(page)}   page: ${app.pagePath.split('/').slice(-4).join('/')}`)

async function waitFor(fn, pred, ms = 3000) {
  let v
  for (let t = 0; t < ms; t += 60) {
    v = await fn()
    if (pred(v)) return v
    await sleep(60)
  }
  return v
}
async function mouseClick(x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  }
}
async function freshPage() {
  await page.send('Page.reload', { ignoreCache: true })
  await waitFor(() => ev(`!!document.querySelector('nav[aria-label="Views"]')`), (v) => v === true, 10000)
  await ev(HELPERS)
}
async function clickReal(selector) {
  const r = await ev(`__probe.reach(${q(selector)})`)
  if (!r?.found) return false
  await mouseClick(r.x, r.y)
  return true
}
const DRAFT_CLAIM = /drafts are safe/i
/** PROBE_SHOTS=<dir> saves what a person would see at each fallback — the pixels, not the DOM. */
async function shot(name) {
  if (!process.env.PROBE_SHOTS) return
  const r = await page.send('Page.captureScreenshot', { format: 'png' })
  if (r.result?.data) writeFileSync(join(process.env.PROBE_SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64'))
}

// Every check after a poison is gated on the fallback having APPEARED: with no alert, "the alert is
// not fixed" and "the rail is reachable" are both true of a page where nothing happened.

// ── 1. a CONVERSATION throws ─────────────────────────────────────────────────────────────────
await ev(HELPERS)
console.log(`[probe] boundaries mounted at start: ${JSON.stringify(await ev('__probe.boundaries()'))}`)
await clickReal(RAIL('Chats'))
await waitFor(() => ev(`!!document.querySelector('button.session-row')`), (v) => v === true)
const ids = await ev(`[...document.querySelectorAll('button.session-row')].map((b) => b.title.split(' — ').pop())`)
const [A, B] = ids
check(!!A && !!B, 'two sessions listed', `${ids.length}`)
await clickReal(ROW(A))
await waitFor(() => ev(`!!document.querySelector('.composer-shell textarea')`), (v) => v === true)
console.log(`[probe] boundaries mounted in Chats: ${JSON.stringify(await ev('__probe.boundaries()'))}`)
const hitChat = await ev(`__probe.poisonAbove('.composer-shell textarea', 'role')`)
console.log(`[probe] poisoned: ${hitChat}`)
let info = await waitFor(() => ev('__probe.alertInfo()'), (v) => v !== null)
await shot('1-conversation')
check(info !== null, 'conversation: a throw in the open conversation is CAUGHT (a fallback rendered, not a blank window)')
check(caught.length >= 1, 'conversation: componentDidCatch ran (its console line was seen)', caught[0])
check(!!info && info.position !== 'fixed' && !info.coversWindow, 'conversation: the fallback is IN the conversation column, not over the window', JSON.stringify({ position: info?.position, coversWindow: info?.coversWindow }))
const rowB = await ev(`__probe.reach(${q(ROW(B))})`)
check(!!info && rowB.reachable === true, 'conversation: the session list is still reachable (hit test on another row)', `hit ${rowB.hit}`)
const railMission = await ev(`__probe.reach(${q(RAIL('Mission'))})`)
check(!!info && railMission.reachable === true, 'conversation: the rail is still reachable', `hit ${railMission.hit}`)
check(!!info && !DRAFT_CLAIM.test(info.text), 'conversation: the fallback does not promise drafts are safe', info?.text?.slice(0, 140))
await clickReal(ROW(B))
const recovered = await waitFor(
  () => ev(`({ alert: __probe.alerts().length, composer: !!document.querySelector('.composer-shell textarea'), active: document.querySelector('button.session-row.is-active')?.title.split(' — ').pop() ?? null })`),
  (v) => v.alert === 0 && v.composer && v.active === B
)
check(!!info && recovered.alert === 0 && recovered.composer && recovered.active === B, 'conversation: a REAL click on another session opens it — one broken conversation costs one conversation', JSON.stringify(recovered))

// ── 2. a VIEW throws ─────────────────────────────────────────────────────────────────────────
// Not every view holds list state with the daemon unreachable, so try views until one throws — and
// if none does, say so as a FAILURE rather than letting the layout checks pass on no alert at all.
await freshPage()
caught.length = 0
let viewHit = null
for (const v of ['Mission', 'Activity', 'Workspace', 'Coding', 'Config']) {
  if (v !== 'Mission') await clickReal(RAIL(v))
  await waitFor(() => ev(`__probe.boundaries().some((l) => / view$/.test(l))`), (x) => x === true)
  const r = await ev(`__probe.poisonInside(' view$')`)
  console.log(`[probe] view ${v}: ${r}`)
  if (!/^none of|^no boundary/.test(r)) { viewHit = v; break }
  await freshPage()
}
info = viewHit ? await waitFor(() => ev('__probe.alertInfo()'), (v) => v !== null) : null
await shot('2-view')
check(info !== null, `view: a throw inside a view is CAUGHT${viewHit ? ` (${viewHit})` : ' — PRECONDITION: no view could be made to throw'}`)
if (info) {
  check(info.position !== 'fixed' && !info.coversWindow, 'view: the fallback sits in the view, not over the window', JSON.stringify({ position: info.position, coversWindow: info.coversWindow }))
  const railFromView = await ev(`__probe.reach(${q(RAIL(viewHit === 'Mission' ? 'Chats' : 'Mission'))})`)
  check(railFromView.reachable === true, 'view: the rail is still reachable', `hit ${railFromView.hit}`)
  const pills = await ev(`__probe.reach('.subnav button')`)
  if (pills.found) check(pills.reachable === true, 'view: the pill row (SubNav) is still reachable — outside the boundary on screen too', `hit ${pills.hit}`)
  check(!DRAFT_CLAIM.test(info.text), 'view: the fallback does not promise drafts are safe', info.text.slice(0, 140))
  const away = viewHit === 'Mission' ? 'Chats' : 'Mission'
  await clickReal(RAIL(away))
  const left = await waitFor(() => ev(`({ alert: __probe.alerts().length, current: document.querySelector(${q(RAIL(away))})?.getAttribute('aria-current') })`), (v) => v.alert === 0 && v.current === 'page')
  check(left.alert === 0 && left.current === 'page', `view: a REAL click on the rail (${away}) leaves the broken view`, JSON.stringify(left))
}

// ── 3. a DOCK PANE throws ────────────────────────────────────────────────────────────────────
// The run inspector (⌘1) and Progress (⌘4) render daemon-shaped data. Browser and terminal are
// native views and are not React-rendered past their frame, so they are not tried.
async function chord(key) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 4, key, code: `Digit${key}`, windowsVirtualKeyCode: 48 + Number(key) })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 4, key, code: `Digit${key}`, windowsVirtualKeyCode: 48 + Number(key) })
}
let dockHit = null
for (const [key, name] of [['1', 'Run inspector'], ['4', 'Progress']]) {
  await freshPage()
  caught.length = 0
  await clickReal(RAIL('Chats'))
  await waitFor(() => ev(`!!document.querySelector('button.session-row')`), (v) => v === true)
  await clickReal(ROW(A))
  await waitFor(() => ev(`!!document.querySelector('.composer-shell textarea')`), (v) => v === true)
  await ev(`document.activeElement?.blur?.()`) // the chord is ignored inside an editable
  await chord(key)
  const open = await waitFor(() => ev(`__probe.boundaries().some((l) => / pane$/.test(l))`), (v) => v === true, 2000)
  if (!open) {
    console.log(`[probe] dock ${name}: no pane boundary mounted after the chord`)
    continue
  }
  const r = await ev(`__probe.poisonInside(' pane$')`)
  console.log(`[probe] dock ${name}: ${r}`)
  // Name the pane by the boundary that is actually mounted, not by the chord we pressed.
  const mounted = await ev(`__probe.boundaries().find((l) => / pane$/.test(l)) ?? null`)
  if (!/^none of|^no boundary/.test(r)) { dockHit = { key, name: mounted ?? name }; break }
}
info = dockHit ? await waitFor(() => ev('__probe.alertInfo()'), (v) => v !== null) : null
await shot('3-dock')
check(info !== null, `dock: a throw inside a dock pane is CAUGHT${dockHit ? ` (${dockHit.name})` : ' — PRECONDITION: no pane could be made to throw'}`)
if (info) {
  const w = await ev(`({ alert: __probe.alerts()[0].getBoundingClientRect().width, win: innerWidth })`)
  check(info.position !== 'fixed' && !info.coversWindow && w.alert < w.win / 2, 'dock: the fallback stays in the dock slot', JSON.stringify({ position: info.position, width: Math.round(w.alert), window: w.win }))
  const composer = await ev(`__probe.reach('.composer-shell textarea')`)
  check(composer.reachable === true, 'dock: the conversation beside it is still usable (hit test on the composer)', `hit ${composer.hit}`)
  const rail = await ev(`__probe.reach(${q(RAIL('Mission'))})`)
  check(rail.reachable === true, 'dock: the rail is still reachable', `hit ${rail.hit}`)
  await chord(dockHit.key)
  const closed = await waitFor(() => ev('__probe.alerts().length'), (v) => v === 0)
  check(closed === 0, `dock: the same chord closes the broken pane (⌘${dockHit.key})`, `${closed} alert(s) left`)
}

// ── 4. the SHELL throws — only the root boundary is above it ─────────────────────────────────
await freshPage()
caught.length = 0
await clickReal(RAIL('Chats'))
await waitFor(() => ev(`!!document.querySelector('button.session-row')`), (v) => v === true)
const hitShell = await ev('__probe.poisonShell()')
console.log(`[probe] poisoned: ${hitShell}`)
info = await waitFor(() => ev('__probe.alertInfo()'), (v) => v !== null)
await shot('4-shell')
check(info !== null, 'shell: a throw in the shell is caught by the root boundary')
check(!!info && info.position === 'fixed' && info.coversWindow === true, 'shell: the ROOT fallback does cover the window — there is nothing left under it to reach', JSON.stringify({ position: info?.position, coversWindow: info?.coversWindow }))
check(!!info && info.buttons.some((b) => /reload/i.test(b)), 'shell: the root fallback offers a reload', JSON.stringify(info?.buttons))
check(!!info && !DRAFT_CLAIM.test(info.text), 'shell: the root fallback does not promise drafts are safe', info?.text?.slice(0, 160))

// ── 5. "Reload Beacon" RELOADS ───────────────────────────────────────────────────────────────
// Every reload above is CDP Page.reload, which never raises will-navigate. The button is a different
// path: `window.location.reload()` DOES raise it, and in a built app the shell is a file:// page, so
// the shell's navigation guard (src/main/index.ts) refused it — the button did nothing, and the only
// button on the root fallback was dead. Nothing here had ever pressed it. So press it: find it on the
// fallback, click it for real, and require a NEW document. A marker is set on `window` before the
// click; only a reload removes it. "The page still works afterwards" would pass on a reload that
// never happened.
//
// PROBE_CLICK=hand: the probe sets each fallback up and then WAITS for a person to click the button in
// the window, sending no input of its own for that click. Otherwise it clicks with Input.dispatchMouseEvent.
// Either way the button records its own click in sessionStorage, which survives a reload of the same
// tab, so the result shows that a trusted click reached THAT button, not only that the page reloaded.
const BY_HAND = process.env.PROBE_CLICK === 'hand'
const CLICK_KEY = '__probeReloadClick'
const refusals = () => (app.log.join('').match(/refused will-navigate/g) ?? []).length
async function pressReload(where) {
  const marker = `reload-${where}-${Date.now()}`
  const set = await ev(`(window.__reloadMarker = ${q(marker)})`)
  check(set === marker, `${where}: the marker is on window before the click`, set)
  const armed = await ev(`(() => {
    const b = [...(__probe.alerts()[0]?.querySelectorAll('button') ?? [])].find((x) => x.innerText.trim() === 'Reload Beacon')
    if (!b) return false
    sessionStorage.removeItem(${q(CLICK_KEY)})
    b.addEventListener('click', (e) => sessionStorage.setItem(${q(CLICK_KEY)}, JSON.stringify({ trusted: e.isTrusted })), { capture: true })
    return true
  })()`)
  const btn = await ev(`__probe.button('Reload Beacon')`)
  check(armed === true && btn?.found === true && btn.reachable === true, `${where}: the fallback has a "Reload Beacon" button and a hit test lands on it`, JSON.stringify(btn))
  const refusedBefore = refusals()
  if (btn?.found && BY_HAND) {
    await app.mainEval(`(() => { const w = __electron.BrowserWindow.getAllWindows().find((x) => /index\\.html$/.test(x.webContents.getURL())); w.show(); w.focus(); return true })()`)
    console.log(`\n[probe] >>> ${where}: click "Reload Beacon" in the Beacon (Electron) window now. Waiting up to 5 minutes.\n`)
    await waitFor(() => ev(`sessionStorage.getItem(${q(CLICK_KEY)})`), (v) => typeof v === 'string', 300000)
  } else if (btn?.found) await mouseClick(btn.x, btn.y)
  // An evaluate that fails mid-navigation returns undefined, not an object: it cannot pass for a reload.
  const after = await waitFor(
    () => ev(`({ marker: window.__reloadMarker ?? null, shell: !!document.querySelector('nav[aria-label="Views"]'), alerts: [...document.querySelectorAll('[role="alert"]')].filter((a) => a.getBoundingClientRect().width > 0).length, click: sessionStorage.getItem(${q(CLICK_KEY)}) })`),
    (v) => v?.marker === null && v.shell === true && v.alerts === 0,
    8000
  )
  const refused = refusals() - refusedBefore
  check(after?.click === JSON.stringify({ trusted: true }), `${where}: the click reached the button (it recorded a trusted click event)${BY_HAND ? ' — by hand' : ''}`, String(after?.click ?? null))
  check(!!btn?.found && after?.marker === null && after.shell === true && after.alerts === 0, `${where}: a REAL click on "Reload Beacon" reloads the window (the marker is gone, the shell is back, no fallback)`, `${JSON.stringify(after)}; main refused ${refused} navigation(s)`)
  check(refused === 0, `${where}: main's navigation guard refused nothing for it`, `${refused} "[shell] refused will-navigate" line(s) after the click`)
  await ev(HELPERS)
}

// 5a. a PANEL's fallback (the conversation), where Reload is the secondary way out.
await freshPage()
await clickReal(RAIL('Chats'))
await waitFor(() => ev(`!!document.querySelector('button.session-row')`), (v) => v === true)
await clickReal(ROW(A))
await waitFor(() => ev(`!!document.querySelector('.composer-shell textarea')`), (v) => v === true)
// The composer mounts before the conversation's messages load; until they do there is no list to
// poison, so retry until the poison lands rather than racing the history fetch.
const hitReload = await waitFor(() => ev(`__probe.poisonAbove('.composer-shell textarea', 'role')`), (v) => typeof v === 'string' && / hook#/.test(v))
console.log(`[probe] reload (panel) poisoned: ${hitReload}`)
info = await waitFor(() => ev('__probe.alertInfo()'), (v) => v !== null)
check(info !== null && info.position !== 'fixed', 'reload (panel): the conversation fallback is showing', JSON.stringify(info?.buttons))
await pressReload('reload (panel)')

// 5b. the ROOT fallback, where Reload is the primary way out.
await freshPage()
await clickReal(RAIL('Chats'))
await waitFor(() => ev(`!!document.querySelector('button.session-row')`), (v) => v === true)
console.log(`[probe] reload (root) poisoned: ${await ev('__probe.poisonShell()')}`)
info = await waitFor(() => ev('__probe.alertInfo()'), (v) => v !== null)
check(info !== null && info.position === 'fixed', 'reload (root): the root fallback is showing', JSON.stringify(info?.buttons))
await pressReload('reload (root)')

await app.quit()
console.log(failures === 0 ? `\n[probe] error-boundary-app: all ${checks} checks passed` : `\n[probe] error-boundary-app: ${failures} of ${checks} FAILED`)
process.exit(failures === 0 ? 0 : 1)
