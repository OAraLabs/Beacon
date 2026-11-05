/**
 * home-touch-probe — Integrations → Home ("What it can touch"), PAINTED, in the real built app, at a
 * 1512×944 window (docs/HA-UI-DATA-CONTRACT.md §3.2).
 *
 * home-touch-smoke pins the logic and reads the sources; it cannot prove the screen renders, that a
 * dialog keeps the keyboard, or that nothing in it is a device control. This drives Electron over CDP,
 * reads the live DOM and measures it.
 *
 * A FAKE GATEWAY serves made-up fixtures (src/shared/home-fixtures.ts, the file the smoke uses) on the
 * REST port, so every payload travels the real path: fetch → daemon bridge → HomePanel. It plays the
 * daemon's new /api/home/* routes and the existing approval-grants routes, and records every write so
 * the probe can say exactly what the screen sent. Nothing here talks to Home Assistant; nothing is real.
 *
 * Run: npm run build && npm run probe:home-touch   (macOS; needs a free REST port)
 */
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { DEVICES_LIST, GRANTS_LIST, STATUS_CONNECTED, STATUS_UNREACHABLE } from '../src/shared/home-fixtures.ts'

const PORT = 8778
const WIDTH = 1512
const HEIGHT = 944
const out = mkdtempSync(join(tmpdir(), 'beacon-home-touch-'))

let statusMode = 'connected' // connected | unreachable | 404 | 403
let putFails = false
let devices = structuredClone(DEVICES_LIST.devices)
let grants = structuredClone(GRANTS_LIST)
const writes = [] // { method, path, body }
let served = 0

const gateway = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  const url = req.url ?? ''
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (url === '/api/devices') return res.end('[]') // no row of its own: the global token, an owner
    if (url === '/api/home/status') {
      served += 1
      if (statusMode === '404') return (res.statusCode = 404), res.end('{"error":"not_found"}')
      if (statusMode === '403') return (res.statusCode = 403), res.end('{"error":"operator_only"}')
      return res.end(JSON.stringify(statusMode === 'unreachable' ? STATUS_UNREACHABLE : STATUS_CONNECTED))
    }
    if (url === '/api/home/devices') return res.end(JSON.stringify({ ...DEVICES_LIST, devices }))
    if (url === '/api/approvals/grants' && req.method === 'GET') return res.end(JSON.stringify(grants))
    const ask = url.match(/^\/api\/home\/devices\/([^/]+)\/ask-once$/)
    if (ask && req.method === 'PUT') {
      writes.push({ method: 'PUT', path: url, body })
      if (putFails) return (res.statusCode = 500), res.end('{"error":"boom"}')
      const d = devices.find((x) => x.id === decodeURIComponent(ask[1]))
      if (d) d.relaxed = JSON.parse(body).enabled === true
      return res.end(JSON.stringify(d ?? {}))
    }
    const rev = url.match(/^\/api\/approvals\/grants\/([^/]+)$/)
    if (rev && req.method === 'DELETE') {
      writes.push({ method: 'DELETE', path: url, body })
      grants = grants.filter((g) => g.id !== decodeURIComponent(rev[1]))
      return res.end('{}')
    }
    if (url.startsWith('/api/approvals')) return res.end('[]')
    res.statusCode = 404
    res.end('[]')
  })
})
await new Promise((r) => gateway.listen(PORT, '127.0.0.1', r))

process.env.BEACON_GATEWAY_HOST = '127.0.0.1'
process.env.BEACON_GATEWAY_API_PORT = String(PORT)
process.env.BEACON_GATEWAY_WS_PORT = '59999' // dead on purpose: this probe is the REST path
process.env.BEACON_CDP_ARGS = `${process.env.BEACON_CDP_ARGS ?? ''} --user-data-dir=${join(out, 'profile')}`.trim()

const { evaluate, sleep, send, mainLog } = await import('./cdp-harness.mjs')

let failures = 0
let checks = 0
function check(cond, label, detail = '') {
  checks += 1
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures += 1
  }
}
const until = async (expr, ms = 9000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await evaluate(expr).catch(() => null)
    if (v) return v
    if (Date.now() > end) return null
    await sleep(250)
  }
}
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  if (s?.result?.data) writeFileSync(join(out, `${name}.png`), Buffer.from(s.result.data, 'base64'))
}
const key = async (name, code, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code, windowsVirtualKeyCode: vk })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk })
}
const clickBy = (sel, text) =>
  `(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})]; const el = ${text === undefined ? 'els[0]' : `els.find((e) => e.innerText.trim() === ${JSON.stringify(text)})`}; if (!el) return false; el.click(); return true })()`
const PANEL = `document.querySelector('[data-testid="home-status"]')`

/** Workspace → Integrations → Home, from wherever the app is. */
async function openHome() {
  await evaluate(clickBy('nav[aria-label="Views"] button[title="Mission"]'))
  await sleep(300)
  await evaluate(clickBy('nav[aria-label="Views"] button[title="Workspace"]'))
  await until(`!!document.querySelector('.subnav-pills')`, 4000)
  await evaluate(clickBy('.subnav-pills button', 'Integrations'))
  await until(`!!document.querySelector('[data-testid="integration-row"][data-health="home"]')`, 5000)
  await evaluate(`document.querySelector('[data-testid="integration-row"][data-health="home"] [role="button"]')?.click(); true`)
}
const home = () => `(() => {
  const q = (s) => [...document.querySelectorAll(s)]
  const status = document.querySelector('[data-testid="home-status"]')
  if (!status) return null
  const devSec = document.querySelector('[data-testid="home-devices"]')
  const alwaysSec = document.querySelector('[data-testid="home-always"]')
  return {
    statusText: status.innerText.replace(/\\s+/g, ' ').trim(),
    statusState: status.dataset.state,
    statusLink: status.querySelector('[data-testid="home-open"]')?.dataset.url ?? null,
    grants: q('[data-testid="home-grant"]').map((g) => ({ text: g.innerText.replace(/\\s+/g, ' ').trim(), revoke: !!g.querySelector('button'), tier: g.querySelector('[data-testid="home-tier"]')?.innerText.trim() })),
    alwaysBeforeDevices: !!(alwaysSec && devSec && (alwaysSec.compareDocumentPosition(devSec) & Node.DOCUMENT_POSITION_FOLLOWING)),
    alwaysTop: alwaysSec?.getBoundingClientRect().top ?? null,
    devicesTop: devSec?.getBoundingClientRect().top ?? null,
    alwaysEmpty: alwaysSec?.innerText.includes('Nothing is always allowed.') ?? false,
    rooms: q('[data-testid="home-room"]').map((r) => r.dataset.room),
    devices: q('[data-testid="home-device"]').map((d) => ({
      name: d.dataset.name,
      tier: d.dataset.tier,
      badge: d.querySelector('[data-testid="home-tier"]')?.innerText.trim(),
      glyph: !!d.querySelector('[data-testid="home-tier"] svg'),
      state: d.querySelector('[data-testid="home-device-state"]')?.innerText.trim(),
      readOnly: d.querySelector('[data-testid="home-readonly"]')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
      buttons: [...d.querySelectorAll('button')].map((b) => b.innerText.trim()),
      link: d.querySelector('[data-testid="home-open"]')?.dataset.url ?? null,
      linkTarget: d.querySelector('[data-testid="home-open"]')?.getAttribute('target') ?? null,
      linkRel: d.querySelector('[data-testid="home-open"]')?.getAttribute('rel') ?? null,
      noLink: !!d.querySelector('[data-testid="home-open-none"]'),
      askOnceOn: !!d.querySelector('[data-testid="home-askonce-on"]'),
      text: d.innerText.replace(/\\s+/g, ' ').trim()
    })),
    switches: devSec ? devSec.querySelectorAll('input[type="checkbox"], [role="switch"]').length : -1,
    filters: q('[data-testid^="home-filter-"]').map((b) => [b.innerText.trim(), b.getAttribute('aria-pressed')]),
    overflowX: document.scrollingElement.scrollWidth > ${WIDTH},
    right: Math.max(...[status, alwaysSec, devSec].filter(Boolean).map((e) => e.getBoundingClientRect().right))
  }
})()`
const setSearch = (v) =>
  `(() => { const el = document.querySelector('input[aria-label="Search devices"]'); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`
const dialog = () => `(() => {
  const d = document.querySelector('[data-testid="home-dialog"]')
  if (!d) return null
  return { title: d.getAttribute('aria-label'), modal: d.getAttribute('aria-modal'), text: d.innerText.replace(/\\s+/g, ' ').trim(), focusInside: d.contains(document.activeElement), buttons: [...d.querySelectorAll('button')].map((b) => b.innerText.trim()), alert: d.querySelector('[role="alert"]')?.innerText ?? null }
})()`

await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })

// ── 1. connected ─────────────────────────────────────────────────────────────
console.log('\n=== 1. Integrations → Home, connected ===')
await openHome()
let h = await until(`(() => { const s = ${home()}; return s && s.devices.length ? s : null })()`, 12000)
check(served > 0, 'the app asked the fake gateway: the data travelled the real path')
if (!h) {
  console.error(`  FATAL: Home never appeared.\n${mainLog.join('').slice(-1200)}`)
  gateway.close()
  process.exit(1)
}
check(h.statusText.includes('Connected to Home Assistant · 13 devices'), `connection line (got "${h.statusText}")`)
check(h.statusState === 'connected' && h.statusLink === 'https://home.example.test', 'it carries the link to Home Assistant', h.statusLink)

console.log('\n=== 2. Always allowed: first, and every row can be revoked ===')
check(h.alwaysBeforeDevices && h.alwaysTop < h.devicesTop, 'the Always allowed list comes before the devices', `${h.alwaysTop} vs ${h.devicesTop}`)
check(h.grants.length === 4, `four Home grants listed; the file grant is not (got ${h.grants.length})`)
check(h.grants.every((g) => g.revoke), 'each has a Revoke button')
check(h.grants.every((g) => g.tier), 'each has its tier as a word')
check(h.grants.some((g) => g.text.includes('Hall light · Hall') && g.text.includes('permanently, until revoked')), "a row names the device and shows the daemon's own words")
check(h.grants.some((g) => g.text.includes('Every Ordinary device')), 'a tier-wide grant says so in words')
check(!h.grants.some((g) => g.text.includes('notes.txt')), 'a grant that is not Home never appears here')

console.log('\n=== 3. devices, by room, with the tier as a word and a shape ===')
check(h.rooms.join() === 'Bedroom,Garage,Hall,Kitchen,Living room,No room', `rooms in order (got ${h.rooms.join()})`)
check(h.devices.length === 13, `every device listed (got ${h.devices.length})`)
check(h.devices.every((d) => d.badge && d.glyph), 'every row has a tier word and a glyph')
check(h.devices.every((d) => d.state), 'every row has its state')
check(h.devices.find((d) => d.name === 'Spare switch')?.state === 'state unknown', 'an unreadable state says "state unknown"')
const withLink = h.devices.filter((d) => d.link)
check(withLink.length === 12 && withLink.every((d) => d.linkTarget === '_blank' && d.linkRel === 'noopener noreferrer'), '"Open in Home Assistant" on every row that has a link, opening outside Beacon')
check(h.devices.find((d) => d.name === 'Spare switch')?.noLink === true, 'a row with no link says so instead of showing a dead one')

console.log('\n=== 4. Critical is read only ===')
const crit = h.devices.filter((d) => d.tier === 'critical')
check(crit.length === 3, `three Critical rows (got ${crit.length})`)
check(crit.every((d) => d.badge === 'Critical' && d.readOnly && /Read only/.test(d.readOnly)), 'each says "Read only"')
check(crit.every((d) => d.buttons.length === 0), 'and has no control of any kind')

console.log('\n=== 5. Sensitive, and what is not classified ===')
const ev = h.devices.find((d) => d.name === 'Evening scene')
check(ev.badge === 'Sensitive' && ev.buttons.includes('Ask once…'), 'a Sensitive row offers Ask once')
const mv = h.devices.find((d) => d.name === 'Movie scene')
check(mv.askOnceOn && mv.buttons.includes('Ask every time…'), 'a relaxed row says Ask once is on, and offers to undo it')
const sp = h.devices.find((d) => d.name === 'Spare switch')
check(sp.badge === 'Sensitive' && /Not classified yet, so treated as Sensitive\./.test(sp.text), 'an unclassified device is Sensitive, with the note')
check(h.devices.filter((d) => d.tier === 'ordinary').every((d) => d.buttons.length === 0), 'an Ordinary row offers nothing to change')

console.log('\n=== 6. no device control anywhere ===')
check(h.switches === 0, 'no on/off switch or checkbox in the device list')
const allButtons = h.devices.flatMap((d) => d.buttons)
check(allButtons.every((t) => /^Ask once…|^Ask every time…/.test(t)), 'the only buttons on a device are Ask once / Ask every time', JSON.stringify([...new Set(allButtons)]))
check(!h.overflowX && h.right <= WIDTH, 'nothing overflows the 1512×944 window', `right ${h.right}`)
await shot('connected')

// ── 7. search and filter ─────────────────────────────────────────────────────
console.log('\n=== 7. search and tier filter ===')
await evaluate(setSearch('garage'))
let s = await until(`(() => { const x = ${home()}; return x && x.devices.length === 2 ? x : null })()`, 3000)
check(!!s && s.devices.map((d) => d.name).sort().join() === 'Garage door,Garage light', 'search narrows by name or room')
await evaluate(setSearch('zzz'))
check(!!(await until(`document.querySelector('[data-testid="home-devices"]')?.innerText.includes('No devices match.')`, 3000)), 'no match says so')
await evaluate(setSearch(''))
await evaluate(clickBy('[data-testid="home-filter-critical"]'))
s = await until(`(() => { const x = ${home()}; return x && x.devices.length === 3 ? x : null })()`, 3000)
check(!!s && s.devices.every((d) => d.tier === 'critical'), 'the Critical filter shows only Critical')
check(!!s && s.filters.find((f) => f[0] === 'Critical')?.[1] === 'true' && s.filters.find((f) => f[0] === 'All')?.[1] === 'false', 'and the filter says which one is on')
await evaluate(clickBy('[data-testid="home-filter-all"]'))
await until(`(() => { const x = ${home()}; return x && x.devices.length === 13 })()`, 3000)

// ── 8. Ask once: a confirmation that names the device, and keeps the keyboard ─
console.log('\n=== 8. Ask once ===')
writes.length = 0
await evaluate(`(() => { const b = document.querySelector('[data-name="Evening scene"] button'); b.focus(); b.click(); return true })()`)
let d = await until(dialog(), 3000)
check(!!d && d.modal === 'true' && /Evening scene/.test(d.title), 'a modal dialog opens and names the device', JSON.stringify(d))
check(!!d && /Always allow/.test(d.text) && /Nothing is allowed until you choose it/.test(d.text), 'it says what changes, and that nothing is granted by it')
check(!!d && d.focusInside, 'focus moved into the dialog')
for (let i = 0; i < 6; i++) await key('Tab', 'Tab', 9)
d = await evaluate(dialog())
check(!!d && d.focusInside, 'Tab, six times, never leaves the dialog')
await key('Escape', 'Escape', 27)
await sleep(300)
check((await evaluate(dialog())) === null, 'Escape closes it')
check(writes.length === 0, 'and nothing was sent')
check((await evaluate(`document.activeElement?.getAttribute('aria-label')`)) === 'Ask once for Evening scene', 'focus went back to the button that opened it')
await evaluate(clickBy('[data-name="Evening scene"] button'))
await until(dialog(), 3000)
await evaluate(clickBy('[data-testid="home-dialog"] button', 'Turn on Ask once'))
await until(`(() => { const x = ${home()}; return x?.devices.find((y) => y.name === 'Evening scene')?.askOnceOn })()`, 6000)
check(writes.length === 1 && writes[0].method === 'PUT' && writes[0].path === '/api/home/devices/dev-evening-scene/ask-once' && writes[0].body === '{"enabled":true}', 'confirming sends exactly one PUT to that device', JSON.stringify(writes))
check((await evaluate(dialog())) === null, 'the dialog closes')
h = await evaluate(home())
check(h.devices.find((x) => x.name === 'Evening scene').askOnceOn, 'the row now says Ask once is on')
check(h.grants.length === 4, 'and no grant was created by it')
// a failed write is said, in the dialog
putFails = true
writes.length = 0
await evaluate(clickBy('[data-name="Evening scene"] button', 'Ask every time…'))
await until(dialog(), 3000)
check(/Ask every time/.test((await evaluate(dialog())).title) && /stays until you revoke it/.test((await evaluate(dialog())).text), 'undoing it names the device and says an existing grant stays')
await evaluate(clickBy('[data-testid="home-dialog"] button', 'Ask every time'))
d = await until(`(() => { const x = ${dialog()}; return x && x.alert ? x : null })()`, 4000)
check(!!d && /That didn't go through/.test(d.alert), 'a write that fails is said in the dialog, not swallowed', d?.alert ?? '')
check(!!d, 'and the dialog stays open')
putFails = false
await key('Escape', 'Escape', 27)
await sleep(300)

// ── 9. Revoke ────────────────────────────────────────────────────────────────
console.log('\n=== 9. Revoke ===')
writes.length = 0
await evaluate(`(() => { const g = [...document.querySelectorAll('[data-testid="home-grant"]')].find((e) => e.innerText.includes('Hall light')); g.querySelector('button').click(); return true })()`)
d = await until(dialog(), 3000)
check(!!d && /Hall light/.test(d.title) && /permanently, until revoked/.test(d.text) && /ask you again/i.test(d.text), "it names what is revoked, in the daemon's words, and what happens next", JSON.stringify(d))
await evaluate(clickBy('[data-testid="home-dialog"] button', 'Cancel'))
await sleep(300)
check(writes.length === 0 && (await evaluate(home())).grants.length === 4, 'Cancel revokes nothing')
await evaluate(`(() => { const g = [...document.querySelectorAll('[data-testid="home-grant"]')].find((e) => e.innerText.includes('Hall light')); g.querySelector('button').click(); return true })()`)
await until(dialog(), 3000)
await evaluate(clickBy('[data-testid="home-dialog"] button', 'Revoke'))
await until(`(() => { const x = ${home()}; return x && x.grants.length === 3 })()`, 6000)
check(writes.length === 1 && writes[0].method === 'DELETE' && writes[0].path === '/api/approvals/grants/grant-hall', 'Revoke sends one DELETE to that grant', JSON.stringify(writes))
check(!(await evaluate(home())).grants.some((g) => g.text.includes('Hall light · Hall')), 'and the row is gone')
await shot('after-revoke')

// ── 10. the words for each failure ───────────────────────────────────────────
console.log('\n=== 10. failures are words ===')
statusMode = 'unreachable'
await openHome()
h = await until(`(() => { const x = ${home()}; return x && x.statusState === 'unreachable' ? x : null })()`, 12000)
check(!!h && /did not answer \(timed out after 8 seconds\)/.test(h.statusText), "an unreachable Home Assistant shows the daemon's own sentence", h?.statusText)
statusMode = '404'
await openHome()
let u = await until(`document.querySelector('[data-testid="home-unavailable"]')?.innerText`, 12000)
check(!!u && /This Prometheus has no Home Assistant support\./.test(u), 'a Prometheus without Home says so', u ?? '')
check((await evaluate(`!document.querySelector('[data-testid="home-devices"]')`)) === true, 'and asks nothing else')
statusMode = '403'
await openHome()
u = await until(`document.querySelector('[data-testid="home-unavailable"][data-kind="forbidden"]')?.innerText`, 12000)
check(!!u && /Only an owner device can see this\./.test(u), 'a device that is not an owner is told so', u ?? '')
await shot('forbidden')

const MIN_CHECKS = 53
if (checks < MIN_CHECKS) {
  console.error(`  FAIL only ${checks} checks ran, expected at least ${MIN_CHECKS}`)
  failures += 1
}
gateway.close()
console.log(`\n[probe] screenshots in ${out}`)
console.log(`${failures === 0 ? `PASS (${checks} checks)` : `FAIL (${failures})`}\n`)
process.exit(failures === 0 ? 0 : 1)
