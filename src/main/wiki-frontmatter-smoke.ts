/**
 * wiki-frontmatter-smoke — a wiki page's YAML frontmatter must not render as page text.
 *
 * Seen 2026-10-14 filming against the demo Prometheus (v0.9.10): Workspace › Wiki showed
 * "type: note first_seen: '2026-10-14' last_updated: '2026-10-14' source_count: 4 manual: true" as
 * a bold line above topics/Tern.md's title. Markdown has no frontmatter: the opening `---` is a
 * thematic break and the key lines, underlined by the closing `---`, are a setext heading.
 *
 * Three layers:
 *   1. splitFrontmatter (@shared/wiki): which leading blocks are lifted, and which are left alone —
 *      a `---` anywhere but line 1 is a horizontal rule, so is one followed by prose;
 *   2. the render: react-markdown with TextBlock's remark plugins, raw page versus split body. The
 *      raw render must SHOW the bug first, or the fixture proves nothing;
 *   3. the wiring: the wiki reader renders through WikiPageBody, which renders the split body.
 *      (WikiPageBody imports MessageRenderer, which needs the DOM typings this project lacks, so the
 *      reader is checked as source here and painted by probe:wiki-frontmatter.)
 *   4. search snippets: the daemon cuts them from the RAW page, so they carried the same YAML.
 *
 * Run: npm run build && npm run smoke:wiki-frontmatter
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as markdownNs from 'react-markdown'
import * as gfmNs from 'remark-gfm'
import * as mathNs from 'remark-math'
import { parseSearch, splitFrontmatter, wikiSnippet } from '@shared/wiki'

// These three are ESM-only and main is built as CJS. Electron's require(esm) returns the module
// namespace, and rollup's namespace interop wraps THAT again under `default`, so the export sits
// one or two `default`s down. Unwrap to the first function.
type Default<T> = T extends { default: infer D } ? Default<D> : T
function def<T>(ns: T): Default<T> {
  let m: unknown = ns
  while (typeof m !== 'function' && m && typeof m === 'object' && 'default' in m) m = (m as { default: unknown }).default
  return m as Default<T>
}
const Markdown = def(markdownNs)
const remarkGfm = def(gfmNs)
const remarkMath = def(mathNs)

const MIN_CHECKS = 55
let checks = 0
let failures = 0
function check(cond: boolean, label: string, detail?: unknown): void {
  checks += 1
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}${detail !== undefined ? `  (${JSON.stringify(detail)})` : ''}`)
    failures += 1
  }
}
// The verdict rides on 'exit', so an early return or a throw cannot skip the count guard.
process.on('exit', () => {
  if (checks < MIN_CHECKS) {
    console.error(`\n[smoke] FAIL only ${checks} checks ran, expected at least ${MIN_CHECKS}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`\n[smoke] FAIL ${failures} of ${checks}`)
    process.exitCode = 1
  } else console.log(`\n[smoke] PASS ${checks} checks`)
})

// ── FIXTURE ──────────────────────────────────────────────────────────────────────────────────
// The FRONTMATTER is what the demo daemon's topics/Tern.md rendered on screen, which a setext
// heading keeps verbatim except that line breaks become spaces: the keys, their order, the single
// quotes on the dates and the bare 4 / true are as seen. One key per line is how YAML has to break
// it. The BODY is shape only (a title, prose, a mid-page rule, a second section): I never read the
// page's body, so it is not pretended to be the real one.
const FRONT = ['---', 'type: note', "first_seen: '2026-10-14'", "last_updated: '2026-10-14'", 'source_count: 4', 'manual: true', '---']
const BODY = [
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
const TERN = [...FRONT, '', BODY].join('\n')
const FIELDS: Array<[string, string]> = [
  ['type', 'note'],
  ['first_seen', '2026-10-14'],
  ['last_updated', '2026-10-14'],
  ['source_count', '4'],
  ['manual', 'true']
]
const YAML_TEXT = ['type: note', 'first_seen', 'last_updated', 'source_count', 'manual: true']

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
/** TextBlock's remark plugins; the rehype ones (whitespace trim, lazy highlight/math) act after
 *  parsing and cannot turn a heading back into a property. */
const render = (md: string): string =>
  renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: [remarkGfm, [remarkMath, { singleDollarTextMath: false }]] }, md)
  )

console.log('[smoke] === 1. the Tern page: the block is lifted, the page is kept ===')
const tern = splitFrontmatter(TERN)
check(tern.frontmatter !== null, 'a leading block is recognised as frontmatter')
check(same(tern.frontmatter?.fields, FIELDS), 'its fields, in order, quotes removed', tern.frontmatter?.fields)
check(tern.body === BODY, 'the body is the page after the block, the blank line after it dropped', tern.body.slice(0, 80))
check(tern.body.startsWith('# Tern'), 'so the page opens on its title')
check(tern.body.includes('\n---\n'), 'and the mid-page rule is still in the body')

const crlf = splitFrontmatter(TERN.replace(/\n/g, '\r\n'))
check(same(crlf.frontmatter?.fields, FIELDS), 'CRLF line endings: the same fields, no stray \\r', crlf.frontmatter?.fields)
check(crlf.body === BODY.replace(/\n/g, '\r\n'), 'CRLF: the body keeps its own line endings')
const bom = splitFrontmatter('﻿' + TERN)
check(same(bom.frontmatter?.fields, FIELDS) && bom.body === BODY, 'a BOM before the opening fence is allowed')
const dots = splitFrontmatter(['---', 'type: note', '...', '# T'].join('\n'))
check(same(dots.frontmatter?.fields, [['type', 'note']]) && dots.body === '# T', 'YAML\'s "..." end marker closes the block too')
const noBody = splitFrontmatter(['---', 'type: note', '---'].join('\n'))
check(noBody.frontmatter !== null && noBody.body === '', 'a page that is only frontmatter has an empty body')

console.log('[smoke] === 2. YAML shapes the compiler or a person may write ===')
const list = splitFrontmatter(['---', 'aliases:', '  - Tern', '  - "Arctic tern"', 'tags:', '- bird', '---', 'x'].join('\n'))
check(same(list.frontmatter?.fields, [['aliases', 'Tern, Arctic tern'], ['tags', 'bird']]), 'a list under a key joins with ", ", indented or not', list.frontmatter?.fields)
const folded = splitFrontmatter(['---', 'summary: >', '  long-distance', '  migrant', 'type: note', '---', 'x'].join('\n'))
check(same(folded.frontmatter?.fields, [['summary', 'long-distance migrant'], ['type', 'note']]), 'a block scalar is its text, not ">"', folded.frontmatter?.fields)
const nested = splitFrontmatter(['---', 'source:', '  url: https://example.test', 'type: note', '---', 'x'].join('\n'))
check(same(nested.frontmatter?.fields, [['source', ''], ['type', 'note']]) && nested.body === 'x', 'a nested mapping stays with its key and is not a field of its own', nested.frontmatter?.fields)
const quoted = splitFrontmatter(['---', "title: 'It''s a tern'", 'q: "say \\"hi\\""', '# a comment', '', 'k: v', '---', 'x'].join('\n'))
check(same(quoted.frontmatter?.fields, [['title', "It's a tern"], ['q', 'say "hi"'], ['k', 'v']]), 'quotes unescape; comments and blank lines are skipped', quoted.frontmatter?.fields)
const urlVal = splitFrontmatter(['---', 'source: https://example.test/a:b', '---', 'x'].join('\n'))
check(same(urlVal.frontmatter?.fields, [['source', 'https://example.test/a:b']]), 'a value may itself contain colons', urlVal.frontmatter?.fields)

console.log('[smoke] === 3. what is NOT frontmatter is left exactly as it was ===')
const untouched = (label: string, md: string): void => {
  const r = splitFrontmatter(md)
  check(r.frontmatter === null && r.body === md, label, r)
}
untouched('a page with no block', BODY)
untouched('a block that is not on line 1 (a blank line first)', '\n' + TERN)
untouched('a block in the middle of a page', [BODY, '', ...FRONT, '', 'more'].join('\n'))
untouched('a block that never closes (a page cut at the read cap)', FRONT.slice(0, -1).join('\n') + '\nsummary: the read cap cut thi')
untouched('an opening rule followed by prose, then a setext underline', ['---', 'A sentence the author underlined.', '---', 'text'].join('\n'))
untouched('an opening rule, then a list, then a rule', ['---', '- one', '---', 'text'].join('\n'))
untouched('an opening rule, then "Note: …" prose that runs on', ['---', 'Note: this page moved.', 'See the new one.', '---'].join('\n'))
untouched('two rules with nothing between them (no key, so no block)', ['---', '---', 'text'].join('\n'))
untouched('a lone rule', '---')
untouched('a "----" opener is a rule, not a fence', ['----', 'type: note', '---', 'x'].join('\n'))
untouched('an indented opener', [' ---', 'type: note', '---', 'x'].join('\n'))
untouched('a block opening on an indented line (nothing for it to belong to)', ['---', '  type: note', '---', 'x'].join('\n'))
untouched('a block opening on a list item (nothing for it to belong to)', ['---', '- note', 'type: note', '---', 'x'].join('\n'))
untouched('an empty document', '')

console.log('[smoke] === 4. the render: the bug with the raw page, gone with the split one ===')
const raw = render(TERN)
// Positive control: without this the checks below could pass on a fixture that never showed the bug.
const rawH2 = /<h2>([\s\S]*?)<\/h2>/.exec(raw)?.[1] ?? ''
check(raw.startsWith('<hr/>'), 'CONTROL: the raw page opens with a rule (the opening fence)', raw.slice(0, 60))
check(YAML_TEXT.every((t) => rawH2.includes(t)), 'CONTROL: the raw page renders the YAML as an <h2> — the bug as seen', rawH2)

const html = render(tern.body)
check(YAML_TEXT.every((t) => !html.includes(t)), 'the split page renders none of the YAML', html.slice(0, 200))
check(!html.includes('2026-10-14\'') && !html.includes("'2026-10-14"), 'not even the quoted dates')
check(html.startsWith('<h1>Tern</h1>'), 'the split page opens on its title, not a rule or a heading of YAML', html.slice(0, 60))
check((html.match(/<hr\/>/g) ?? []).length === 1, 'exactly one rule remains: the one in the middle of the page', html)
const hrAt = html.indexOf('<hr/>')
check(hrAt > html.indexOf('</p>') && hrAt < html.indexOf('<h2>Sources</h2>'), 'and it sits between the prose and the next section')
check(!/<h2>[^<]*:/.test(html), 'no <h2> carries a "key:" line', html)

// A mid-page rule followed by key-like prose must still be a rule (and a heading, as markdown says).
const midRule = ['# Page', '', 'intro', '', '---', 'type: note', '---', '', 'end'].join('\n')
check(splitFrontmatter(midRule).body === midRule, 'a frontmatter-shaped block mid-page is not lifted')
check(render(splitFrontmatter(midRule).body) === render(midRule), 'so it renders exactly as markdown always rendered it')
check(render(splitFrontmatter(midRule).body).includes('<hr/>'), 'including its horizontal rule')
const plain = ['Before', '', '---', '', 'After'].join('\n')
check(render(splitFrontmatter(plain).body) === '<p>Before</p>\n<hr/>\n<p>After</p>', 'a plain mid-page "---" is still <hr/>', render(plain))
check(splitFrontmatter(['---', 'Prose', '---'].join('\n')).body === ['---', 'Prose', '---'].join('\n'), 'and an opening rule over prose renders as it always did')

console.log('[smoke] === 5. the wiring: the wiki reader renders the split body ===')
// Comments are stripped first: a comment explaining the change would satisfy a text search.
const src = (p: string): string =>
  readFileSync(resolve(process.cwd(), p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\{\s*\}/g, '')
const panel = src('src/renderer/src/components/WikiPanel.tsx')
const body = src('src/renderer/src/components/WikiPageBody.tsx')
check(/<WikiPageBody\s+content=\{page\.content\}\s*\/>/.test(panel), 'WikiPanel renders the page through WikiPageBody')
check(!/<TextBlock\b/.test(panel), 'and nowhere hands page text to TextBlock itself')
check(/splitFrontmatter\(content\)/.test(body), 'WikiPageBody splits the page it is given')
check(/<TextBlock\s+text=\{body\}\s*\/>/.test(body), 'and renders the split body, not the raw content')
check(!/<TextBlock\s+text=\{content\}/.test(body), 'never the raw content')

console.log('[smoke] === 6. search snippets: cut from the raw page, so the YAML rode along ===')
// A line-for-line port of Prometheus server.py `search_wiki` (origin/main 1c714cb, 2026-10-14):
//   idx = body.lower().find(needle); start = max(0, idx - 60)
//   snippet = body[start : idx + 140].replace("\n", " ").strip()
// so the inputs below are what the daemon sends for these pages, not shapes guessed at.
function daemonSnippet(body: string, q: string): string {
  const needle = q.trim().toLowerCase()
  const idx = body.toLowerCase().indexOf(needle)
  if (idx < 0) return ''
  return body.slice(Math.max(0, idx - 60), idx + 140).replace(/\n/g, ' ').trim()
}
const YAML_SNIPPET = ['manual: true', 'source_count', "'2026-10-14'"]

const rawTern = daemonSnippet(TERN, 'tern')
check(YAML_SNIPPET.some((t) => rawTern.includes(t)) && rawTern.includes(' ---  # Tern'), 'CONTROL: the daemon\'s snippet for "tern" carries the YAML', rawTern)
const tSnip = wikiSnippet(rawTern, 'tern')
check(tSnip.startsWith('# Tern  Seabirds') && YAML_SNIPPET.every((t) => !tSnip.includes(t)), 'cleaned: it starts at the page, no YAML', tSnip)
check(tSnip.includes(' ---  ## Sources'), 'and the page\'s own mid-page rule is still in it', tSnip)

const rawLar = daemonSnippet(TERN, 'laridae')
check(!rawLar.startsWith('---') && rawLar.includes('manual: true'), 'CONTROL: a window that starts INSIDE the block (no opening fence in it)', rawLar)
const lSnip = wikiSnippet(rawLar, 'laridae')
check(lSnip.startsWith('# Tern') && !lSnip.includes('manual'), 'cleaned from the closing fence on', lSnip)

// Tern's body is short enough that every window reaches back into the block; a longer page is not.
const LONG = [...FRONT, '', '# Tern', '', 'Seabirds of the family Laridae, found on every continent and most coasts, nesting in open colonies on sand, shingle and rock. The Arctic tern makes the longest migration of any animal.', '', '---', '', '## Sources'].join('\n')
const rawArc = daemonSnippet(LONG, 'arctic')
check(rawArc.includes(' ---  ## Sources') && !rawArc.includes('manual'), 'CONTROL: a window past the block that holds the mid-page rule', rawArc)
check(wikiSnippet(rawArc, 'arctic') === rawArc, 'a body rule after prose is not taken for a fence: the snippet is unchanged')

const rawNote = daemonSnippet(TERN, 'note')
const nSnip = wikiSnippet(rawNote, 'note')
check(nSnip === "type: note first_seen: '2026-10-14' last_updated: '2026-10-14' source_count: 4 manual: true", 'a match INSIDE the properties shows them, fences dropped', nSnip)

const plainPage = ['# Rules', '', 'Above the rule.', '', '---', '', 'Below the rule, where the tern is.'].join('\n')
const rawPlain = daemonSnippet(plainPage, 'tern')
check(rawPlain.includes(' --- ') && wikiSnippet(rawPlain, 'tern') === rawPlain, 'a page with no frontmatter: unchanged, rule and all', rawPlain)
check(wikiSnippet('', 'tern') === '', 'an empty snippet (a title or path hit) stays empty')
check(wikiSnippet('queries live under…', 'queries') === 'queries live under…', 'a snippet with no fence is untouched')
const opened = wikiSnippet("--- type: note first_seen: '2026-10-1", 'note')
check(opened === "type: note first_seen: '2026-10-1", 'a window that ends inside the block: the opening fence dropped', opened)

const parsed = parseSearch({ query: 'tern', returned: 1, truncated: false, results: [{ path: 'topics/Tern.md', title: 'Tern', snippet: rawTern, in_title: true, in_path: true, mtime: 1 }] })
check(parsed?.hits[0]?.snippet === tSnip, 'parseSearch hands the panel the cleaned snippet', parsed?.hits[0]?.snippet)
check(/\{h\.snippet\}/.test(panel) && !/wikiSnippet|\.snippet\s*\.replace/.test(panel), 'and the panel shows the parsed hit\'s snippet as-is (no second, divergent cleaning)')
