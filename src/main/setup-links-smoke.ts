/**
 * Setup-links smoke (headless / ELECTRON_RUN_AS_NODE) — 0.3.1, B11.
 *
 * The setup screens send people to four pages (@shared/setup-links). A link only leaves the app if
 * BOTH halves hold, so this pins both:
 *   1. every URL is one main's window-open handler will pass to shell.openExternal: it must survive
 *      safeExternalUrl unchanged (http/https only), and here it must be https;
 *   2. every anchor on the setup screens is `target="_blank"` (so the click reaches that handler
 *      instead of navigating the shell window), every SETUP_LINKS entry is linked at least once, and
 *      none of the four addresses is left as plain text.
 * The scanner proves itself first on planted snippets: a guard that can't see a bad link is a note.
 *
 * What it can't prove: that a click reaches the browser. `npm run probe:setup-links` clicks each
 * link in the built app (macOS) with openExternal replaced.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { safeExternalUrl } from '@shared/browser-pane'
import { SETUP_LINKS } from '@shared/setup-links'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[setup-links-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const FIXED = 21 // 14 + one per SETUP_LINKS entry added since (website, macUpdate: v0.4.0; O9: anthropicKeys, anthropicBilling, openaiKeys, openaiBilling, openrouterCredits)

/** Every `<a …>` opening tag in a source text, with what it links and whether it opens outside. */
function anchors(text: string): { tag: string; key: string | null; external: boolean }[] {
  const out: { tag: string; key: string | null; external: boolean }[] = []
  for (const m of text.matchAll(/<a\b[^>]*>/g)) {
    const tag = m[0]
    out.push({
      tag,
      key: tag.match(/href=\{SETUP_LINKS\.(\w+)\}/)?.[1] ?? null,
      external: /target="_blank"/.test(tag) && /rel="noreferrer"/.test(tag)
    })
  }
  return out
}

// ── 0. the scanner sees what it is for (planted) ── [3]
assert(anchors(`<a href={SETUP_LINKS.guide} target="_blank" rel="noreferrer">x</a>`)[0]?.external === true, 'scanner: a proper external link reads as external')
assert(anchors(`<a href={SETUP_LINKS.guide}>x</a>`)[0]?.external === false, 'scanner: a link with no target="_blank" is caught')
assert(anchors(`<p>see <code>api.slack.com/apps</code></p>`).length === 0 && /api\.slack\.com\/apps<\/code>/.test(`<code>api.slack.com/apps</code>`), 'scanner: a plain-text address has no anchor (and the plain-text pattern matches it)')

// ── 1. every URL survives the shell's gate, and is https ── [4]
for (const [key, url] of Object.entries(SETUP_LINKS)) {
  assert(safeExternalUrl(url) === url && url.startsWith('https://'), `${key}: ${url} passes safeExternalUrl unchanged, over https`)
}

// ── 2. the setup screens use them as external links ── [7]
// The two existing setup screens come first (the index-based checks below name them), then every screen
// of the v0.4.0 first run, so its links are held to the same rules as the ones they replace.
const ONBOARDING_DIR = 'src/renderer/src/components/onboarding'
const files = [
  'src/renderer/src/components/SetupWizard.tsx',
  'src/renderer/src/components/FirstRunSetup.tsx',
  ...readdirSync(ONBOARDING_DIR)
    .filter((f) => f.endsWith('.tsx'))
    .sort()
    .map((f) => `${ONBOARDING_DIR}/${f}`)
]
const texts: string[] = []
for (const f of files) {
  try {
    texts.push(readFileSync(f, 'utf8'))
  } catch {
    texts.push('')
  }
}
assert(texts.every((t) => t.length > 0) && files.length >= 8, `read the setup screens (${files.length} files: both existing ones and the v0.4.0 first run)`)
const all = texts.flatMap(anchors)
const notExternal = all.filter((a) => !a.external).map((a) => a.tag)
assert(all.length >= 6 && notExternal.length === 0, `every anchor on the setup screens opens in the browser (${all.length} anchors)`, notExternal.join(' | '))
const used = new Set(all.map((a) => a.key).filter(Boolean))
const unused = Object.keys(SETUP_LINKS).filter((k) => !used.has(k))
assert(unused.length === 0, 'every SETUP_LINKS entry is linked at least once', `unlinked: ${unused.join(', ')}`)
assert(anchors(texts[1]).some((a) => a.key === 'guide'), 'Quick connect links the setup guide')
assert(anchors(texts[0]).filter((a) => a.key === 'guide').length >= 2, 'the wizard links the setup guide on Welcome and on Connect')
const plain = texts.flatMap((t) => [...t.matchAll(/<code>(api\.slack\.com\/apps|discord\.com\/developers\/applications|@BotFather|t\.me\/BotFather)<\/code>/g)].map((m) => m[1]))
assert(plain.length === 0, 'no setup address is left as plain text', plain.join(', '))
assert(!texts.join('\n').includes('href="http'), 'no setup link hard-codes its URL outside SETUP_LINKS')

if (checks !== FIXED) {
  console.error(`[setup-links-smoke] FAIL — ran ${checks}/${FIXED} checks (a section was skipped)`)
  process.exit(1)
}
if (failures > 0) {
  console.error(`[setup-links-smoke] FAIL — ${failures}/${checks} checks failed`)
  process.exit(1)
}
console.log(`[setup-links-smoke] OK — ${checks}/${FIXED} checks passed`)
