#!/usr/bin/env node
// refused-tasks-app-probe: the Mission card's refused number against a fake daemon (issue 278).
//
// The fake serves what the issue measured on the live daemon: /api/tasks counts
// { completed: 214, failed: 26, blocked: 22 } (all-time), and /api/tasks?status=blocked&limit=200
// the refusal records with created_at in epoch seconds (the wire's own unit). Two scenarios:
//   A. 3 of the 22 inside the last 7 days → the card links "3 refused this week", tooltip "22 in all"
//   B. all 22 older → no link on the card; the summary line still names "22 refused" (issue 148)
// Each launch is a fresh empty profile pointed at the fake by env (no wizard, no Keychain, nothing of
// the operator's touched). The fake COUNTS the second request, so a card that never asked cannot pass.
//
// macOS (app-driver). Run after `npm run build`: node scripts/refused-tasks-app-probe.mjs

import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, sleep } from './app-driver.mjs'

let checks = 0
let failures = 0
function check(cond, label, detail) {
  checks += 1
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`)
  if (!cond) failures += 1
}
process.on('exit', () => {
  if (checks < 9) {
    console.log(`FAIL: only ${checks} checks ran`)
    process.exitCode = 1
  } else if (failures) {
    console.log(`FAIL (${failures} of ${checks})`)
    process.exitCode = 1
  } else console.log(`PASS (${checks} checks)`)
})

const NOW = Math.floor(Date.now() / 1000)
const DAY = 86_400
const record = (i, daysAgo) => ({ id: `r${i}`, type: 'local_bash', status: 'blocked', description: `refused ${i}`, running: false, created_at: NOW - daysAgo * DAY + 0.25, session_id: null })
let scenario = { recentDays: [] }
const hits = []
const fake = createServer((req, res) => {
  hits.push(req.url)
  res.setHeader('content-type', 'application/json')
  if (req.url === '/api/tasks') return res.end(JSON.stringify({ tasks: [], counts: { completed: 214, failed: 26, blocked: 22 } }))
  if (req.url?.startsWith('/api/tasks?')) {
    const u = new URL(req.url, 'http://x')
    const days = [...scenario.recentDays, ...Array.from({ length: 22 - scenario.recentDays.length }, (_, i) => 9 + i * 3)]
    const tasks = days.map((d, i) => record(i, d)).sort((a, b) => b.created_at - a.created_at)
    return res.end(JSON.stringify({ tasks: u.searchParams.get('status') === 'blocked' ? tasks : [], counts: { completed: 214, failed: 26, blocked: 22 } }))
  }
  if (req.url?.startsWith('/api/cron') || req.url?.startsWith('/api/approvals')) return res.end('[]')
  res.end('{}')
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
process.env.BEACON_GATEWAY_HOST = '127.0.0.1'
process.env.BEACON_GATEWAY_API_PORT = String(fake.address().port)
process.env.BEACON_GATEWAY_WS_PORT = '59998' // dead on purpose: this is the REST path

async function card(app) {
  return app.page.evaluate(`(() => {
    const link = document.querySelector('[data-testid="refused-recent"]')
    // The INNERMOST span starting with the sentence: its wrapper also starts with it (and holds the links).
    const sum = [...document.querySelectorAll('span')].filter((s) => /^Nothing running ·/.test(s.textContent.trim())).sort((a, b) => a.textContent.length - b.textContent.length)[0]
    return { link: link ? { text: link.textContent.trim(), title: link.getAttribute('title') } : null, summary: sum ? { text: sum.textContent.trim(), title: sum.getAttribute('title') } : null, body: document.body.innerText.includes('awaiting approval') }
  })()`)
}

for (const [name, recentDays] of [['A. 3 refusals this week, 22 all-time', [0.5, 3, 6.5]], ['B. 22 refusals, all older than 7 days', []]]) {
  console.log(`\n${name}`)
  scenario = { recentDays }
  hits.length = 0
  const profile = mkdtempSync(join(tmpdir(), 'beacon-refused-probe-'))
  const app = await launchApp({ profile })
  try {
    let c = null
    for (let i = 0; i < 60; i++) {
      c = await card(app)
      if (c.summary && (recentDays.length === 0 || c.link)) break
      await sleep(250)
    }
    check(hits.includes('/api/tasks'), 'Mission asked the daemon for the task histogram')
    check(hits.some((h) => h === '/api/tasks?status=blocked&limit=200'), 'and, since there are refusals, for the refusal records (the second request was made)', hits.filter((h) => h.startsWith('/api/tasks')))
    check(!!c.summary && c.summary.text.includes('22 refused') && /All-time/.test(c.summary.title ?? '') && /22 refused/.test(c.summary.title ?? ''), `the summary line names the all-time refusals, and its tooltip says so ("${c.summary?.text}")`, c.summary)
    check(c.body === false, 'nothing on the page says "awaiting approval"')
    if (recentDays.length) {
      check(c.link?.text === '3 refused this week →', `the card links the RECENT count ("${c.link?.text}")`, c.link)
      check(/nothing ran/.test(c.link?.title ?? '') && /3 in the last 7 days, 22 in all/.test(c.link?.title ?? ''), 'its tooltip says what a refusal is, with both counts', c.link?.title)
    } else {
      check(c.link === null, 'no recent refusals → no refused link on the card (issue 278 test)', c.link)
      check(!!c.summary && c.summary.text.includes('22 refused'), 'and the 22 are still visible on the summary line (issue 148)')
    }
  } finally {
    await app.quit()
    await sleep(800)
    try { rmSync(profile, { recursive: true, force: true }) } catch { /* helpers may still be writing */ }
  }
}
fake.close()
