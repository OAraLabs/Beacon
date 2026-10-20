/**
 * wiki-frontmatter-probe — a wiki page's YAML frontmatter, PAINTED, in the real built app.
 *
 * wiki-frontmatter-smoke proves which blocks are lifted and what react-markdown makes of the rest.
 * It cannot prove the Wiki reader paints the split page: it reads WikiPanel as source. This opens
 * Workspace › Wiki against a FAKE GATEWAY (a local REST server on an ephemeral port serving the
 * wiki routes) with the app under its own --user-data-dir, so it never touches the installed
 * Beacon's profile, the real daemon or a port another session holds.
 *
 *   1. topics/Tern.md, frontmatter as the demo daemon (Prometheus v0.9.10) writes it: no YAML text
 *      anywhere in the reader, the page opens on its h1, the fields sit in the properties row, and
 *      the mid-page rule is still a rule;
 *   2. topics/Rules.md, no frontmatter and a mid-page `---`: one rule, no properties row;
 *   3. a search for "tern": the hit's snippet, cut by the daemon from the RAW page, paints no YAML.
 *
 * Run: npm run build && npm run probe:wiki-frontmatter   (PROBE_SHOT=<png> to choose the screenshot)
 */
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

const UD = `/tmp/beacon-wiki-frontmatter-probe-ud-${process.pid}`
const SHOT = process.env.PROBE_SHOT ?? '/tmp/wiki-frontmatter-probe.png'

// The frontmatter as the demo's topics/Tern.md rendered it on screen (see the smoke's fixture
// note); the body is shape only.
const TERN = [
  '---',
  'type: note',
  "first_seen: '2026-10-14'",
  "last_updated: '2026-10-14'",
  'source_count: 4',
  'manual: true',
  '---',
  '',
  '# Tern',
  '',
  'Seabirds of the family Laridae. The Arctic tern makes the longest migration of any animal.',
  '',
  '---',
  '',
  '## Sources',
  '',
  '- field notes, 2026-10-14'
].join('\n')
const RULES = ['# Rules', '', 'Above the rule.', '', '---', '', 'Below the rule.'].join('\n')
const PAGES = { 'topics/Tern.md': TERN, 'topics/Rules.md': RULES }

const nowS = Date.now() / 1000
const served = []
const rest = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  const url = new URL(req.url ?? '/', 'http://x')
  const path = url.searchParams.get('path') ?? ''
  served.push(`${url.pathname}?path=${path}`)
  if (url.pathname === '/api/sessions') return res.end('[]')
  if (url.pathname === '/api/wiki/pages') {
    const entries = path === ''
      ? [{ name: 'topics', type: 'dir', size: 0, mtime: nowS - 60 }]
      : path === 'topics'
        ? [
            { name: 'Rules.md', type: 'file', size: RULES.length, mtime: nowS - 30, title: 'Rules' },
            { name: 'Tern.md', type: 'file', size: TERN.length, mtime: nowS - 20, title: 'Tern' }
          ]
        : []
    return res.end(JSON.stringify({ path, entries }))
  }
  if (url.pathname === '/api/wiki/search') {
    // Prometheus server.py `search_wiki` (origin/main 1c714cb): the snippet is cut from the RAW
    // page, 60 characters before the first match to 140 after, newlines flattened.
    const q = url.searchParams.get('q') ?? ''
    const needle = q.trim().toLowerCase()
    const results = []
    for (const [p, body] of Object.entries(PAGES)) {
      const title = body.split('\n').find((l) => l.startsWith('#'))?.replace(/^#+/, '').trim() ?? p
      const idx = body.toLowerCase().indexOf(needle)
      const inTitle = title.toLowerCase().includes(needle)
      const inPath = p.toLowerCase().includes(needle)
      if (!inTitle && !inPath && idx < 0) continue
      const snippet = idx >= 0 ? body.slice(Math.max(0, idx - 60), idx + 140).replace(/\n/g, ' ').trim() : ''
      results.push({ path: p, section: p.split('/')[0], title, snippet, in_title: inTitle, in_path: inPath, mtime: nowS - 20 })
    }
    return res.end(JSON.stringify({ query: q, returned: results.length, truncated: false, results }))
  }
  if (url.pathname === '/api/wiki/page' && path in PAGES) {
    const content = PAGES[path]
    return res.end(JSON.stringify({ path, size: content.length, truncated: false, binary: false, content }))
  }
  res.statusCode = 404
  res.end('{}')
})
await new Promise((r) => rest.listen(0, '127.0.0.1', r))
const API_PORT = rest.address().port

process.env.BEACON_GATEWAY_HOST = '127.0.0.1'
process.env.BEACON_GATEWAY_API_PORT = String(API_PORT)
process.env.BEACON_GATEWAY_WS_PORT = String(API_PORT) // nothing listens for WS; the wiki is REST only
process.env.BEACON_CDP_ARGS = `${process.env.BEACON_CDP_ARGS ?? ''} --user-data-dir=${UD} --use-mock-keychain`.trim()

const { evaluate, sleep, send, mainLog } = await import('./cdp-harness.mjs')

const MIN_CHECKS = 19
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
process.on('exit', () => {
  if (checks < MIN_CHECKS) {
    console.error(`\n[probe] FAIL only ${checks} checks ran, expected at least ${MIN_CHECKS}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`\n[probe] FAIL ${failures} of ${checks}`)
    process.exitCode = 1
  } else console.log(`\n[probe] PASS ${checks} checks`)
})

const until = async (expr, ms = 15000) => {
  for (let t = 0; t < ms; t += 250) {
    const v = await evaluate(expr)
    if (v && !v.__error) return v
    await sleep(250)
  }
  return null
}
const clickWhere = (pred) => evaluate(`(() => {
  const hit = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null && !b.disabled).find((b) => { const t = (b.textContent ?? '').trim(); return ${pred} })
  if (!hit) return false
  hit.click()
  return true
})()`)

/** The reader, as painted: only what has a box counts. */
const read = () =>
  evaluate(`(() => {
    const md = document.querySelector('.md-body')
    if (!md || md.getBoundingClientRect().height === 0) return null
    const reader = md.parentElement
    const props = reader.querySelector('dl.wiki-props')
    const first = md.querySelector(':scope > *')
    return {
      text: reader.innerText,
      first: first ? { tag: first.tagName, text: first.textContent } : null,
      h2: [...md.querySelectorAll('h2')].map((h) => h.textContent),
      hr: [...md.querySelectorAll('hr')].filter((h) => h.getBoundingClientRect().width > 0).length,
      props: props && props.getBoundingClientRect().height > 0
        ? [...props.querySelectorAll(':scope > div')].map((d) => [d.querySelector('dt')?.textContent, d.querySelector('dd')?.textContent])
        : null
    }
  })()`)

const openPage = async (name) => {
  const opened = await until(`(() => {
    const row = [...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && (b.textContent ?? '').trim().startsWith(${JSON.stringify(name)}))
    if (!row) return null
    row.click()
    return true
  })()`)
  if (!opened) return null
  return until(`(() => { const h = document.querySelector('.md-body > :first-child'); return h && h.getBoundingClientRect().height > 0 && h.textContent === ${JSON.stringify(name)} ? true : null })()`)
}

// ── drive to Workspace › Wiki › topics ───────────────────────────────────────────────────────
const booted = await until(`document.querySelector('[aria-label="Views"]') ? true : null`, 40000)
if (!booted) {
  console.error('  FATAL: never reached the main view\n' + mainLog.join('').slice(-1500))
  process.exit(1)
}
check(await clickWhere(`t === 'Workspace' || t.startsWith('Workspace')`), 'opened the Workspace surface')
const pill = await until(`(() => {
  const nav = document.querySelector('[data-testid="subnav"] nav')
  const hit = nav && [...nav.querySelectorAll('button.pill')].find((b) => (b.textContent ?? '').trim().startsWith('Wiki'))
  if (!hit) return null
  hit.click()
  return true
})()`)
check(Boolean(pill), 'opened the Wiki pill')
const topics = await until(`(() => {
  const row = [...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && (b.textContent ?? '').trim().startsWith('topics'))
  if (!row) return null
  row.click()
  return true
})()`)
check(Boolean(topics), 'opened topics/ from the fake gateway listing')

// 1. Tern: frontmatter lifted
check(Boolean(await openPage('Tern')), 'topics/Tern.md opened and painted its h1')
check(served.includes('/api/wiki/page?path=topics/Tern.md'), 'the page came from the fake gateway', served.join(', '))
const tern = await read()
check(!!tern, 'the reader painted a page')
for (const t of ['type: note', 'first_seen', "'2026-10-14'", 'source_count:', 'manual: true'])
  check(!tern?.text.includes(t), `no raw YAML in the painted reader: "${t}"`)
check(tern?.first?.tag === 'H1' && tern.first.text === 'Tern', 'the page opens on its own title', JSON.stringify(tern?.first))
check(tern?.hr === 1, `the mid-page rule is still drawn (${tern?.hr} rule)`)
check(JSON.stringify(tern?.h2) === JSON.stringify(['Sources']), 'the only h2 is the page\'s own section', JSON.stringify(tern?.h2))
check(
  JSON.stringify(tern?.props) === JSON.stringify([['type', 'note'], ['first seen', '2026-10-14'], ['last updated', '2026-10-14'], ['source count', '4'], ['manual', 'true']]),
  'the fields sit in the properties row',
  JSON.stringify(tern?.props)
)
await sleep(400)
const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot?.result?.data) writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'))

// 2. Rules: no frontmatter, a mid-page rule
check(Boolean(await openPage('Rules')), 'topics/Rules.md opened and painted its h1')
const rules = await read()
check(rules?.hr === 1, `a page with no frontmatter keeps its "---" rule (${rules?.hr})`)
check(rules?.props === null, 'and shows no properties row', JSON.stringify(rules?.props))
check(rules?.text.includes('Above the rule.') && rules.text.includes('Below the rule.'), 'with the text either side of it')

// 3. search: the snippet
const typed = await evaluate(`(() => {
  const box = document.querySelector('input[aria-label="Search the wiki"]')
  if (!box) return false
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(box, 'tern')
  box.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
check(typed === true, 'typed "tern" into the wiki search')
const hit = await until(`(() => {
  const row = [...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && (b.textContent ?? '').includes('topics/Tern.md'))
  return row ? row.innerText : null
})()`)
check(served.some((u) => u.startsWith('/api/wiki/search')), 'the search went to the fake gateway')
check(!!hit && hit.includes('Seabirds'), 'the Tern hit paints a snippet of the page', JSON.stringify(hit))
for (const t of ['manual: true', 'source_count', "'2026-10-14'"])
  check(!!hit && !hit.includes(t), `no raw YAML in the painted snippet: "${t}"`, JSON.stringify(hit))
await sleep(300)
const shot2 = await send('Page.captureScreenshot', { format: 'png' })
if (shot2?.result?.data) writeFileSync(SHOT.replace(/\.png$/, '-search.png'), Buffer.from(shot2.result.data, 'base64'))

console.log(`\n[probe] screenshots: ${SHOT}, ${SHOT.replace(/\.png$/, '-search.png')}`)
rest.close()
process.exit(failures === 0 ? 0 : 1)
