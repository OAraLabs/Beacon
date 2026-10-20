#!/usr/bin/env node
// markdown-lists-app-probe — chat's markdown lists, PAINTED, in the built app (owner decision, 2026-10-18, for 0.4.7: the first reply in the Path B
// film showed a bullet AND an empty checkbox on every item).
//
//   npm run build && node scripts/markdown-lists-app-probe.mjs
//
// The reader is chat's own TextBlock (the wiki page renders through it, as the first reply and every chat message do). A fake gateway on
// an ephemeral 127.0.0.1 port serves one wiki page with a plain list, a numbered list and a task list; the app runs on a scratch
// profile with the mock keychain. It checks what is drawn, not what is in the tree:
//   * a plain list: a bullet each, and no checkbox anywhere in it;
//   * a numbered list: numbers, no checkbox;
//   * a task list (- [ ] / - [x]): a checkbox each, checked as written, and NO bullet beside it.
// macOS (app-driver).
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, sleep } from './app-driver.mjs'

if (process.platform !== 'darwin') {
  console.log('[probe] SKIPPED: macOS only (app-driver)')
  process.exit(3)
}
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_') || k.startsWith('PROMETHEUS_')) delete process.env[k]
let failures = 0
let checks = 0
const check = (ok, label, extra = '') => {
  checks++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${String(extra).slice(0, 600)}` : ''}`)
  if (!ok) failures++
}
const MIN_CHECKS = 5
process.on('exit', () => {
  if (failures || checks < MIN_CHECKS) {
    console.log(`\n[probe] FAIL — ${failures} failed, ${checks} ran (at least ${MIN_CHECKS} expected)`)
    process.exitCode = 1
  } else console.log(`\n[probe] OK — ${checks} checks passed`)
})

// The film's reply, as a small model writes a plan, beside the two plain kinds.
const PAGE = [
  '# Lists',
  '',
  'Plain:',
  '',
  '- Choose the menu',
  '- Make a shopping list',
  '',
  'Numbered:',
  '',
  '1. Go grocery shopping',
  '2. Prepare ingredients',
  '',
  'Steps:',
  '',
  '- [ ] Cook the meal',
  '- [x] Set the table'
].join('\n')
const nowS = Date.now() / 1000
const rest = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  const url = new URL(req.url ?? '/', 'http://x')
  const path = url.searchParams.get('path') ?? ''
  if (url.pathname === '/api/wiki/pages') return res.end(JSON.stringify({ path, entries: path === '' ? [{ name: 'Lists.md', type: 'file', size: PAGE.length, mtime: nowS - 10, title: 'Lists' }] : [] }))
  if (url.pathname === '/api/wiki/page' && path === 'Lists.md') return res.end(JSON.stringify({ path, size: PAGE.length, truncated: false, binary: false, content: PAGE }))
  if (url.pathname === '/api/sessions') return res.end('[]')
  res.statusCode = 404
  res.end('{}')
})
await new Promise((r) => rest.listen(0, '127.0.0.1', r))
const PORT = rest.address().port
if ([8005, 8010].includes(PORT)) throw new Error('refusing the real ports')
Object.assign(process.env, { BEACON_GATEWAY_HOST: '127.0.0.1', BEACON_GATEWAY_API_PORT: String(PORT), BEACON_GATEWAY_WS_PORT: String(PORT) })
const profile = mkdtempSync(join(tmpdir(), 'beacon-md-lists-probe-'))

async function clickBy(app, finder) {
  const at = await app.page.evaluate(`(() => { const el = (${finder})(); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const h = document.elementFromPoint(x, y); return { x, y, hit: !!h && (h === el || el.contains(h)) } })()`)
  if (!at?.hit) return false
  for (const type of ['mousePressed', 'mouseReleased']) await app.page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })
  return true
}
const until = async (fn, ms) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v || Date.now() > end) return v
    await sleep(250)
  }
}

let app = null
try {
  app = await launchApp({ profile })
  check(app.pagePath.includes('/out/renderer/'), "the page is this checkout's build", app.pagePath)
  // Each step retried until it lands: the pill row and the page list render a beat after the click before them (a single try missed).
  await until(() => clickBy(app, `() => [...document.querySelectorAll('nav[aria-label="Views"] button')].find((b) => b.innerText.trim() === 'Workspace')`), 10000)
  await until(() => clickBy(app, `() => [...document.querySelectorAll('button')].find((b) => b.offsetParent && !b.closest('nav[aria-label="Views"]') && b.getBoundingClientRect().top < 240 && b.innerText.trim() === 'Wiki')`), 10000)
  const opened = await until(() => clickBy(app, `() => [...document.querySelectorAll('button')].find((b) => b.offsetParent && (b.textContent ?? '').trim().startsWith('Lists'))`), 10000)
  const lists = await until(
    () =>
      app.page.evaluate(`(() => {
        const md = document.querySelector('.md-body'); if (!md || !md.querySelector('ol')) return null
        // What is drawn: the list's marker (a bullet or a number shows unless list-style-type is none), and the checkboxes with a box.
        const drawn = (list) => ({
          tag: list.tagName,
          marker: getComputedStyle(list).listStyleType,
          items: [...list.querySelectorAll(':scope > li')].map((li) => ({
            text: li.innerText.trim(),
            marker: getComputedStyle(li).listStyleType,
            boxes: [...li.querySelectorAll('input[type=checkbox]')].filter((i) => i.getBoundingClientRect().width > 0).map((i) => i.checked)
          }))
        })
        return [...md.querySelectorAll(':scope > ul, :scope > ol')].map(drawn)
      })()`),
    15000
  )
  check(opened && Array.isArray(lists) && lists.length === 3, 'the page with the three lists opened in the reader (chat\'s TextBlock)', JSON.stringify(lists))
  const [plain, numbered, tasks] = lists ?? []
  const shows = (m) => m && m !== 'none'
  check(
    plain?.tag === 'UL' && plain.items.length === 2 && plain.items.every((i) => shows(i.marker) && i.boxes.length === 0),
    'a plain list: a bullet on each item, and no checkbox',
    JSON.stringify(plain)
  )
  check(numbered?.tag === 'OL' && numbered.items.every((i) => shows(i.marker) && i.boxes.length === 0), 'a numbered list: numbers, no checkbox', JSON.stringify(numbered))
  check(
    tasks?.tag === 'UL' && tasks.items.length === 2 && tasks.items.every((i) => !shows(i.marker) && i.boxes.length === 1) && tasks.items[0].boxes[0] === false && tasks.items[1].boxes[0] === true,
    'a task list (- [ ] / - [x]): one checkbox per item, checked as written, and no bullet beside it',
    JSON.stringify(tasks)
  )
} catch (e) {
  check(false, 'the probe ran to the end', e?.stack ?? String(e))
} finally {
  if (app) await app.quit().catch(() => undefined)
  rest.closeAllConnections?.()
  rest.close()
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
