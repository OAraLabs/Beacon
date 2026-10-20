// Shared by the onboarding probes (scripts/onboarding-*-probe.mjs). The setup-resume and
// setup-links probes keep their own inline copies: they are shipped and mutation-tested, and moving
// them buys nothing.
//
// What lives here is what every probe needs and every probe got wrong at least once:
//   * a verdict on process 'exit', so an early exit or a throw cannot skip the count guard;
//   * REAL input (Input.dispatchMouseEvent / dispatchKeyEvent) after proving nothing covers the
//     target, because el.click() passes on a button a fixed overlay sits on top of;
//   * waitFor, so a slow launch is reported as a failed check and not as a hang.
import { createConnection } from 'node:net'
import { sleep } from '../app-driver.mjs'

/** `check(ok, what, detail)` and an exit-time verdict. Fewer than `minChecks` checks is a failure:
 *  a probe that stopped early must not read as a pass. */
export function startChecks(name, minChecks) {
  let failures = 0
  let checks = 0
  process.on('exit', (code) => {
    if (checks < minChecks) {
      console.log(`[probe] ${name}: only ${checks} checks ran (expected at least ${minChecks}) — INCOMPLETE`)
      process.exitCode = 1
      return
    }
    console.log(failures === 0 ? `[probe] ${name}: all ${checks} checks passed` : `[probe] ${name}: ${failures} of ${checks} FAILED`)
    if (failures > 0 || code !== 0) process.exitCode = 1
  })
  return function check(ok, what, detail) {
    checks++
    console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${what}${detail !== undefined ? `  — ${detail}` : ''}`)
    if (!ok) failures++
  }
}

export function portTaken(port) {
  return new Promise((res) => {
    const s = createConnection({ host: '127.0.0.1', port })
    s.once('connect', () => (s.destroy(), res(true)))
    s.once('error', () => res(false))
  })
}

/** Poll `fn` until `pred(value)` or `ms` pass; returns the last value either way. */
export async function waitFor(fn, pred, ms) {
  const end = Date.now() + ms
  let v
  for (;;) {
    v = await fn()
    if (pred(v) || Date.now() > end) return v
    await sleep(200)
  }
}

export const pageText = (app, sel = 'body') => app.page.evaluate(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`)

/** A REAL left click on the first visible element matching `find` (a JS expression evaluated in the
 *  page that returns an element or null). Proves the element's centre is not covered, and that it is
 *  not disabled, before pressing there. Returns 'clicked' or the reason it did not. */
async function clickWhere(app, label, find) {
  const where = await app.page.evaluate(`(() => {
    const b = (${find})()
    if (!b) return null
    b.scrollIntoView({ block: 'center' })
    const r = b.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    const top = document.elementFromPoint(x, y)
    return { x, y, hit: !!top && (top === b || b.contains(top)), disabled: b.disabled === true || b.getAttribute('aria-disabled') === 'true' }
  })()`)
  if (!where) return `nothing visible matches ${label}`
  if (!where.hit) return `${label} is covered at its centre`
  if (where.disabled) return `${label} is disabled`
  for (const type of ['mousePressed', 'mouseReleased'])
    await app.page.send('Input.dispatchMouseEvent', { type, x: where.x, y: where.y, button: 'left', clickCount: 1 })
  return 'clicked'
}

/** Click the visible <button> or <a> whose text starts with `text`. */
export function clickText(app, text) {
  return clickWhere(
    app,
    `"${text}"`,
    `() => [...document.querySelectorAll('button, a[href], [role="radio"]')].find((x) => x.innerText.trim().startsWith(${JSON.stringify(text)}) && x.offsetParent !== null) ?? null`
  )
}

/** Click the first visible element matching a CSS selector. */
export function clickSelector(app, selector) {
  return clickWhere(app, selector, `() => [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.offsetParent !== null) ?? null`)
}

const KEYS = { Escape: { code: 'Escape', vk: 27 }, Enter: { code: 'Enter', vk: 13 }, ArrowDown: { code: 'ArrowDown', vk: 40 }, ArrowUp: { code: 'ArrowUp', vk: 38 } }
/** A real key press (keyDown + keyUp) delivered to the page. */
export async function press(app, key) {
  const k = KEYS[key]
  if (!k) throw new Error(`press: no key table entry for ${key}`)
  for (const type of ['keyDown', 'keyUp'])
    await app.page.send('Input.dispatchKeyEvent', { type, key, code: k.code, windowsVirtualKeyCode: k.vk })
}

/** Replace the text of an input with REAL input: a triple click on it (which selects what is there), then
 *  Input.insertText, which is what typing delivers. Returns 'typed' or the reason it did not. */
export async function typeInto(app, selector, text) {
  const where = await app.page.evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.offsetParent !== null)
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    const top = document.elementFromPoint(x, y)
    return { x, y, hit: !!top && (top === el || el.contains(top)), disabled: el.disabled === true }
  })()`)
  if (!where) return `nothing visible matches ${selector}`
  if (!where.hit) return `${selector} is covered at its centre`
  if (where.disabled) return `${selector} is disabled`
  for (const type of ['mousePressed', 'mouseReleased']) await app.page.send('Input.dispatchMouseEvent', { type, x: where.x, y: where.y, button: 'left', clickCount: 3 })
  await app.page.send('Input.insertText', { text })
  return 'typed'
}

/** The text of `selector` with every element matching `exclude` removed: the screen's own words, without
 *  what a computer or an assistant said (untrusted text is marked, and the copy rules do not apply to it). */
export const textWithout = (app, selector, exclude) =>
  app.page.evaluate(`(() => { const root = document.querySelector(${JSON.stringify(selector)}); if (!root) return ''; const c = root.cloneNode(true); c.querySelectorAll(${JSON.stringify(exclude)}).forEach((n) => n.remove()); return c.innerText ?? '' })()`)

export { bannedHits } from './banned-hits.mjs'
