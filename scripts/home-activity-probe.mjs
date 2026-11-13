/**
 * home-activity-probe — Integrations → Home → Activity, PAINTED, in the real built app, at a 1512×944 window
 * (docs/HA-UI-DATA-CONTRACT.md §3.3).
 *
 * home-activity-smoke pins the logic and reads the sources; it cannot prove the timeline renders, that a refused call is
 * unmistakable, or that nothing on the screen can change anything. This drives Electron over CDP and reads the live DOM.
 *
 * A FAKE GATEWAY serves made-up fixtures (src/shared/home-fixtures.json, the file the smoke uses) on the REST port, so every
 * payload travels the real path: fetch → daemon bridge → HomeActivity. It plays the daemon's /api/home/* routes, applies the
 * filters it is sent, pages by cursor, and RECORDS EVERY REQUEST so the probe can say that the screen only ever read.
 * Nothing here talks to Home Assistant; nothing is real.
 *
 * Run: npm run build && npm run probe:home-activity   (macOS; needs a free REST port)
 */
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'

const { ACTIVITY_PAGE_1, ACTIVITY_PAGE_2, DEVICES_LIST, STATUS_CONNECTED, GRANTS_LIST } = JSON.parse(
  readFileSync(new URL('../src/shared/home-fixtures.json', import.meta.url), 'utf8')
)

const PORT = 8779
const WIDTH = 1512
const HEIGHT = 944
const out = mkdtempSync(join(tmpdir(), 'beacon-home-activity-'))

let mode = 'normal' // normal | fail | empty
let capable = true // whether this fake Prometheus advertises home/1 on GET /api/status
const seen = [] // { method, url }
const ALL = [...ACTIVITY_PAGE_1.entries, ...ACTIVITY_PAGE_2.entries].sort((a, z) => z.at - a.at)

const gateway = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  const url = req.url ?? ''
  req.on('data', () => {})
  req.on('end', () => {
    seen.push({ method: req.method, url })
    if (url === '/api/devices') return res.end('[]')
    if (url === '/api/status') return res.end(JSON.stringify({ state: 'idle', model: 'stub-model', capabilities: capable ? ['home/1'] : [] }))
    if (url === '/api/home/status') return res.end(JSON.stringify(STATUS_CONNECTED))
    if (url === '/api/home/devices') return res.end(JSON.stringify(DEVICES_LIST))
    if (url === '/api/approvals/grants') return res.end(JSON.stringify(GRANTS_LIST))
    if (url.startsWith('/api/home/activity')) {
      if (mode === 'fail') return (res.statusCode = 500), res.end('{"error":"boom"}')
      if (mode === 'empty') return res.end(JSON.stringify({ entries: [], next_before: null }))
      const q = new URL(url, 'http://x').searchParams
      const filtered = q.get('device') || q.get('room') || q.get('tier')
      if (!filtered) return res.end(JSON.stringify(q.get('before') === 'cursor-2' ? ACTIVITY_PAGE_2 : ACTIVITY_PAGE_1))
      const entries = ALL.filter(
        (e) => (!q.get('device') || e.device.id === q.get('device')) && (!q.get('room') || e.device.room === q.get('room')) && (!q.get('tier') || e.tier === q.get('tier'))
      )
      return res.end(JSON.stringify({ entries, next_before: null }))
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
const choose = (label, value) =>
  `(() => { const el = document.querySelector('[data-testid="home-activity"] select[aria-label="${label}"]'); if (!el) return false; const s = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; s.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`

async function openActivity() {
  await evaluate(clickBy('nav[aria-label="Views"] button[title="Mission"]'))
  await sleep(300)
  await evaluate(clickBy('nav[aria-label="Views"] button[title="Workspace"]'))
  await until(`!!document.querySelector('.subnav-pills')`, 4000)
  await evaluate(clickBy('.subnav-pills button', 'Integrations'))
  await until(`!!document.querySelector('[data-testid="integration-row"][data-health="home"]')`, 5000)
  await evaluate(`document.querySelector('[data-testid="integration-row"][data-health="home"] [role="button"]')?.click(); true`)
  await until(`!!document.querySelector('#home-tab-activity')`, 8000)
  await evaluate(`document.querySelector('#home-tab-activity').click(); true`)
}
const timeline = () => `(() => {
  const root = document.querySelector('[data-testid="home-activity"]')
  if (!root) return null
  const entry = (e) => ({
    device: e.dataset.device,
    result: e.dataset.result,
    chip: e.querySelector('[data-testid="activity-result"]')?.innerText.trim(),
    glyph: e.querySelector('[data-testid="activity-result"]')?.dataset.glyph,
    tier: e.querySelector('[data-testid="home-tier"]')?.innerText.trim(),
    tierGlyph: !!e.querySelector('[data-testid="home-tier"] svg'),
    askedBy: e.querySelector('[data-testid="activity-asked-by"]')?.innerText.trim(),
    approval: e.querySelector('[data-testid="activity-approval"]')?.innerText.trim(),
    resulting: e.querySelector('[data-testid="activity-resulting"]')?.innerText.trim() ?? null,
    reason: e.querySelector('[data-testid="activity-reason"]')?.innerText.trim() ?? null,
    text: e.innerText.replace(/\\s+/g, ' ').trim()
  })
  const all = [...root.querySelectorAll('[data-testid="activity-entry"]')]
  const batches = [...root.querySelectorAll('[data-testid="activity-batch"]')].map((b) => ({ id: b.dataset.batch, entries: b.querySelectorAll('[data-testid="activity-entry"]').length, more: b.querySelector('[data-testid="activity-more"]') ? { text: b.querySelector('[data-testid="activity-more"]').innerText.trim(), expanded: b.querySelector('[data-testid="activity-more"]').getAttribute('aria-expanded') } : null, head: b.firstElementChild.innerText.replace(/\\s+/g, ' ').trim() }))
  const r = root.getBoundingClientRect()
  return {
    entries: all.map(entry),
    standalone: all.filter((e) => !e.closest('[data-testid="activity-batch"]')).map((e) => e.dataset.device),
    batches,
    days: [...root.querySelectorAll('[data-testid="activity-day"]')].map((d) => d.innerText.trim()),
    buttons: [...root.querySelectorAll('button')].map((b) => b.innerText.trim()),
    selects: [...root.querySelectorAll('select')].map((s) => s.getAttribute('aria-label')),
    empty: root.querySelector('[data-testid="activity-empty"]')?.innerText.trim() ?? null,
    alert: root.querySelector('[role="alert"]')?.innerText.trim() ?? null,
    older: !!root.querySelector('[data-testid="activity-older"]'),
    switches: root.querySelectorAll('input[type="checkbox"], [role="switch"], form').length,
    text: root.innerText,
    overflowX: document.scrollingElement.scrollWidth > ${WIDTH},
    right: r.right
  }
})()`

await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })

// ── 1. the timeline ──────────────────────────────────────────────────────────
console.log('\n=== 1. Integrations → Home → Activity ===')
await openActivity()
let t = await until(`(() => { const x = ${timeline()}; return x && x.entries.length ? x : null })()`, 12000)
if (!t) {
  console.error(`  FATAL: the timeline never appeared.\n${mainLog.join('').slice(-1200)}`)
  gateway.close()
  process.exit(1)
}
check(seen.some((r) => r.url.startsWith('/api/home/activity?limit=50')), 'the app asked the fake gateway for the first page: the data travelled the real path')
check((await evaluate(`document.querySelector('#home-tab-activity').getAttribute('aria-selected')`)) === 'true', 'the Activity tab says it is the open one')
check(t.standalone.slice(0, 4).join() === 'Hall light,Front door lock,Garage light,Evening scene', `newest first (got ${t.standalone.slice(0, 4).join()})`)
check(t.entries.every((e) => e.tier && e.tierGlyph), 'every entry has its tier as a word and a glyph')
check(t.entries.every((e) => e.chip && e.glyph), 'every entry has its result as a word and a glyph')
check(t.days.length >= 2, `entries are grouped under day headings (${t.days.join(' | ')})`)

console.log('\n=== 2. what really happened ===')
const hall = t.entries.find((e) => e.device === 'Hall light')
check(hall.result === 'unconfirmed' && hall.chip === 'Not confirmed' && hall.glyph === 'warn', 'accepted but still off reads Not confirmed, with the warning shape')
check(hall.resulting === 'off' && /Asked for on, 60%/.test(hall.text), 'it shows what was asked for and what the device really became')
check(hall.askedBy === 'Your chat' && hall.approval === 'You approved it once', 'who asked, and how it was approved')
const sched = t.entries.find((e) => e.device === 'Garage light' && e.askedBy.startsWith('A schedule'))
check(sched.askedBy === 'A schedule · Evening routine' && sched.approval === 'Allowed by a saved permission' && sched.chip === 'Confirmed' && sched.glyph === 'check', 'a schedule that ran under a saved permission')
check(t.entries.some((e) => e.approval === 'You chose Always allow') && t.entries.some((e) => e.approval === 'You denied it'), 'Always allow and a denial are both on the record')

console.log('\n=== 3. refused calls are unmistakable ===')
const refused = t.entries.filter((e) => e.result === 'refused')
check(refused.length === 3, `three refused calls (got ${refused.length})`)
check(refused.every((e) => e.chip === 'Refused' && e.glyph === 'refused'), 'each says Refused, with its own shape')
check(refused.every((e) => e.resulting === null), 'and none claims a resulting state')
const lock = refused.find((e) => e.device === 'Front door lock')
check(lock.tier === 'Critical' && lock.reason === 'Why: Front door lock is a Critical device, and Critical devices cannot be controlled from Prometheus.', "the server's reason, verbatim", lock.reason)
const bg = refused.find((e) => e.device === 'Evening scene')
check(bg.askedBy === 'A background task' && /never use the sensitive tool/.test(bg.reason), 'a background run refused, and why')
const glyphs = new Set(['check', 'warn', 'cross', 'refused'])
check(t.entries.every((e) => glyphs.has(e.glyph)), 'results use only the four shapes')
await shot('timeline')

console.log('\n=== 4. a bulk call ===')
check(t.batches.length === 1 && t.batches[0].id === 'b-01', 'the eight lights are one group')
check(t.batches[0].entries === 5 && t.batches[0].more?.text === 'and 3 more' && t.batches[0].more.expanded === 'false', 'collapsed to 5, with "and 3 more"')
check(/8 devices · turn_off/.test(t.batches[0].head) && /Some failed/.test(t.batches[0].head), 'the group line says how many, what, and that some failed')
await evaluate(clickBy('[data-testid="activity-more"]'))
t = await until(`(() => { const x = ${timeline()}; return x && x.batches[0]?.entries === 8 ? x : null })()`, 3000)
check(!!t && t.batches[0].more?.text === 'Show fewer' && t.batches[0].more.expanded === 'true', 'it expands to all 8 and says it is open')
check(!!t && t.entries.some((e) => e.device === 'Bathroom light' && e.result === 'failed' && /did not answer for this one/.test(e.reason ?? '')), 'the one that failed shows the server reason')
await evaluate(clickBy('[data-testid="activity-more"]'))

console.log('\n=== 5. older entries ===')
t = await evaluate(timeline())
const before = t.entries.length
check(t.older, 'there is a way to load older entries')
await evaluate(clickBy('[data-testid="activity-older"]'))
t = await until(`(() => { const x = ${timeline()}; return x && x.entries.length > ${before} ? x : null })()`, 4000)
check(!!t && t.entries.length === before + 3, `the next page adds its 3 (${before} → ${t?.entries.length})`)
check(!!t && !t.older, 'and the button goes when there is no more')
check(seen.some((r) => r.url.includes('before=cursor-2')), 'it asked with the daemon\'s own cursor')

// ── 6. filters ───────────────────────────────────────────────────────────────
console.log('\n=== 6. filters ===')
check(t.selects.join() === 'Device,Room,Tier', 'Device, Room and Tier filters, each labelled')
seen.length = 0
await evaluate(choose('Device', 'dev-hall-light'))
let f = await until(`(() => { const x = ${timeline()}; return x && x.entries.length && x.entries.every((e) => e.device === 'Hall light') ? x : null })()`, 4000)
check(!!f && f.entries.length === 3, 'Device: only that device (its own two, and its place in the bulk call)')
check(seen.some((r) => r.url.includes('device=dev-hall-light')), 'and the filter went to the daemon')
await evaluate(choose('Device', ''))
await evaluate(choose('Room', 'Living room'))
f = await until(`(() => { const x = ${timeline()}; return x && x.entries.length === 3 ? x : null })()`, 4000)
check(!!f && f.entries.map((e) => e.device).sort().join() === 'Evening scene,Living room lamp,Thermostat', 'Room: only that room')
await evaluate(choose('Room', ''))
await evaluate(choose('Tier', 'critical'))
f = await until(`(() => { const x = ${timeline()}; return x && x.entries.length === 1 ? x : null })()`, 4000)
check(!!f && f.entries[0].device === 'Front door lock' && f.entries[0].result === 'refused', 'Tier: Critical shows the refused lock')
await evaluate(choose('Device', 'dev-hall-light'))
f = await until(`(() => { const x = ${timeline()}; return x && x.empty ? x : null })()`, 4000)
check(!!f && f.empty === 'Nothing matches these filters.', 'filters that match nothing say so')
check(!!f && f.buttons.includes('Show everything'), 'and offer the way back')
await evaluate(clickBy('[data-testid="home-activity"] button', 'Show everything'))
f = await until(`(() => { const x = ${timeline()}; return x && x.entries.length >= 12 ? x : null })()`, 4000)
check(!!f, 'Show everything restores the timeline')

// ── 7. read only ─────────────────────────────────────────────────────────────
console.log('\n=== 7. read only ===')
t = await evaluate(timeline())
const allowed = /^(Refresh|Show everything|and \d+ more|Show fewer|Show older \(\d+ more\)|Loading…)$/
check(t.buttons.every((b) => allowed.test(b)), 'the only buttons are Refresh, Show everything, and the list controls', JSON.stringify([...new Set(t.buttons)]))
check(t.switches === 0, 'no form, no switch, no checkbox')
check(!/Delete|Clear|Remove|Export|Revoke/.test(t.text), 'nothing on it says delete, clear, remove, export or revoke')
// Beacon's own connection handshake with the gateway (an identity check) is not the screen's; the screen's routes are Home and approvals.
const theirs = seen.filter((r) => r.url.startsWith('/api/home') || r.url.startsWith('/api/approvals'))
check(theirs.length > 0 && theirs.every((r) => r.method === 'GET'), 'every Home and approvals request the screen made was a GET', JSON.stringify(theirs.filter((r) => r.method !== 'GET')))
check(!t.overflowX && t.right <= WIDTH, 'nothing overflows the 1512×944 window', `right ${t.right}`)

// ── 8. keyboard ──────────────────────────────────────────────────────────────
console.log('\n=== 8. keyboard ===')
await evaluate(`document.querySelector('#home-tab-activity').focus(); true`)
await key('ArrowLeft', 'ArrowLeft', 37)
check((await until(`document.querySelector('#home-tab-devices')?.getAttribute('aria-selected') === 'true'`, 3000)) === true, 'the arrow keys move between the tabs')
await key('ArrowRight', 'ArrowRight', 39)
check((await until(`document.querySelector('#home-tab-activity')?.getAttribute('aria-selected') === 'true' && !!document.querySelector('[data-testid="home-activity"]')`, 3000)) === true, 'and back to Activity')
check((await evaluate(`[...document.querySelectorAll('[data-testid="home-activity"] select, [data-testid="home-activity"] button')].every((e) => e.tabIndex >= 0)`)) === true, 'every control on the timeline is reachable by keyboard')

// ── 9. the words for each failure ────────────────────────────────────────────
console.log('\n=== 9. failures are words ===')
mode = 'fail'
await evaluate(clickBy('[data-testid="home-activity"] button', 'Refresh'))
t = await until(`(() => { const x = ${timeline()}; return x && x.alert ? x : null })()`, 4000)
check(!!t && /Couldn't read Home: .*HTTP 500/.test(t.alert), 'a failed read is said, with its reason', t?.alert ?? '')
mode = 'empty'
await evaluate(clickBy('[data-testid="home-activity"] button', 'Refresh'))
t = await until(`(() => { const x = ${timeline()}; return x && x.empty ? x : null })()`, 4000)
check(!!t && t.empty === 'No Home actions yet.', 'an empty record says so')
mode = 'normal'
await shot('after')

// ── 10. no timeline unless the Prometheus advertises Home ────────────────────
console.log('\n=== 10. the capability gate ===')
capable = false
seen.length = 0
await evaluate(clickBy('nav[aria-label="Views"] button[title="Mission"]'))
await sleep(300)
await evaluate(clickBy('nav[aria-label="Views"] button[title="Workspace"]'))
await until(`!!document.querySelector('.subnav-pills')`, 4000)
await evaluate(clickBy('.subnav-pills button', 'Integrations')) // opening the page asks the Prometheus again
await sleep(2500)
check((await evaluate(`!document.querySelector('[data-testid="integration-row"][data-health="home"]') && !document.querySelector('#home-tab-activity') && !document.querySelector('[data-testid="home-activity"]')`)) === true, 'a Prometheus that stops advertising Home: no Home row, no Activity tab, no timeline')
check(!seen.some((r) => r.url.startsWith('/api/home')), 'and nothing under /api/home is asked of it', JSON.stringify(seen.filter((r) => r.url.startsWith('/api/home')).map((r) => r.url)))
capable = true

const MIN_CHECKS = 46
if (checks < MIN_CHECKS) {
  console.error(`  FAIL only ${checks} checks ran, expected at least ${MIN_CHECKS}`)
  failures += 1
}
gateway.close()
console.log(`\n[probe] screenshots in ${out}`)
console.log(`${failures === 0 ? `PASS (${checks} checks)` : `FAIL (${failures})`}\n`)
process.exit(failures === 0 ? 0 : 1)
