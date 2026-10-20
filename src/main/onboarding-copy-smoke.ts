/**
 * Onboarding copy smoke (headless / ELECTRON_RUN_AS_NODE) — v0.4.0, O1.
 *
 * Principle 2 of the onboarding spec: no jargon on the main path. "Daemon", "gateway", "token", a port
 * number: the words that stopped a new user on 0.3.0. This holds the strings module to the banned-word
 * list (@shared/onboarding-banned-words.json), and holds the lint itself to account:
 *
 *   * it only reads COPY.main, so a fourth top-level namespace would be a place to hide a banned word.
 *     The namespaces are pinned;
 *   * a list that has lost words, or a matcher that has lost its word boundaries, passes everything. So
 *     every banned word must flag itself, and ordinary sentences must not be flagged;
 *   * the probe checks the RENDERED text with a JavaScript matcher (scripts/lib/banned-hits.mjs). The
 *     two matchers must agree on everything checked here.
 *
 * What it cannot prove: that a component does not type prose of its own. The probe reads the DOM.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import banned from '@shared/onboarding-banned-words.json'
import { COPY, mainStrings } from '@shared/onboarding-strings'
import { OWNER_COPY } from '@shared/owner-strings'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[onboarding-copy-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 11

const WORDS: string[] = banned.words
const escape = (w: string): string => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const hits = (text: string, words: string[] = WORDS): string[] => words.filter((w) => new RegExp(`\\b${escape(w)}\\b`, 'i').test(text))

// ── the list and the matcher ────────────────────────────────────────────────────────────────────
assert(WORDS.length >= 40 && WORDS.every((w) => typeof w === 'string' && w.trim() === w && w.length > 0), `list: ${WORDS.length} banned words, none blank`)
assert(new Set(WORDS.map((w) => w.toLowerCase())).size === WORDS.length, 'list: no word twice (case aside)')
const unflagged = WORDS.filter((w) => hits(`Beacon needs the ${w} first.`, [w]).length === 0 || hits(`${w.toUpperCase()} and ${w.toLowerCase()}`, [w]).length === 0)
assert(unflagged.length === 0, 'matcher: every banned word flags itself, in any case', unflagged.join(', '))
const innocent = [
  'Your support team made an important call.',
  'We are shipping tips for a tipping point.',
  'Open the importer, report the airport, pick a sport.',
  'Prometheus is your assistant\'s brain. Beacon gets Prometheus for you. You won\'t need to type any commands.'
]
assert(innocent.every((t) => hits(t).length === 0), 'matcher: ordinary sentences with "port" or "ip" inside other words are not flagged', innocent.filter((t) => hits(t).length > 0).join(' | '))

// ── the strings ─────────────────────────────────────────────────────────────────────────────────
assert(JSON.stringify(Object.keys(COPY)) === JSON.stringify(['main', 'advanced', 'dev']), 'copy: exactly three namespaces (main, advanced, dev); the lint reads main, so a fourth would be somewhere to hide a word', Object.keys(COPY).join(', '))
const strings = mainStrings()
assert(strings.length >= 20 && strings.every((s) => s.trim().length > 0), `copy: ${strings.length} main-path strings read, none blank`)
const offenders = strings.map((s) => ({ s, h: hits(s) })).filter((x) => x.h.length > 0)
assert(offenders.length === 0, 'copy: no main-path string contains a banned word', offenders.map((o) => `"${o.s.slice(0, 40)}…" has ${o.h.join(', ')}`).join(' ; '))

// The owner's "Approve new device?" prompt has its own module (a fourth namespace above would hide words); it is held to the same list.
// Promises are copy too. Until O10 builds them, Beacon has no Prometheus version check and no Settings controls for starting it at
// login or removing it, so no main-path string may offer one. Nor a way to add a device from Settings: a device joins by asking, and
// an owner's Beacon approves it (an owner credential cannot enrol one, Prometheus #696).
const PROMISES = [/turn (?:it|that|this|these) off/i, /\bin Settings\b/, /checks now and then/i, /newer Prometheus/i]
const promised = strings.filter((s) => PROMISES.some((re) => re.test(s)))
const plantedCaught = ['You can turn that off in Settings.', 'Beacon also checks now and then whether a newer Prometheus is available.', 'You can add it later in Settings → Devices.'].every((t) => PROMISES.some((re) => re.test(t)))
assert(plantedCaught && promised.length === 0, 'copy: no main-path string promises a switch or a check Beacon does not have yet (they come with O10)', plantedCaught ? promised.map((p) => `"${p.slice(0, 70)}…"`).join(' ; ') : 'the matcher misses a planted promise')
const ownerStrings = Object.values(OWNER_COPY)
const ownerOffenders = ownerStrings.map((t) => ({ t, h: hits(t) })).filter((x) => x.h.length > 0)
assert(ownerStrings.length >= 15 && ownerStrings.every((t) => t.trim().length > 0) && ownerOffenders.length === 0, `copy: the ${ownerStrings.length} words of the owner's "Approve new device?" prompt are none blank and none a banned word`, ownerOffenders.map((o) => `"${o.t.slice(0, 40)}…" has ${o.h.join(', ')}`).join(' ; '))

async function main(): Promise<void> {
  // ── the probe's matcher agrees ──────────────────────────────────────────────────────────────────
  const mod = (await import(/* @vite-ignore */ pathToFileURL(resolve('scripts/lib/banned-hits.mjs')).href)) as { bannedHits: (t: string, w: string[]) => string[] }
  const battery = [...strings, ...innocent, ...WORDS.map((w) => `The ${w} is here.`), 'daemon-less', 'ports and Ports', '']
  const disagree = battery.filter((t) => JSON.stringify(mod.bannedHits(t, WORDS).map((x) => x.toLowerCase()).sort()) !== JSON.stringify(hits(t).map((w) => w.toLowerCase()).sort()))
  assert(disagree.length === 0, `probe matcher: scripts/lib/banned-hits.mjs agrees with this one on ${battery.length} strings`, disagree.slice(0, 3).join(' | '))
  assert(mod.bannedHits('Connect to the daemon on your gateway', WORDS).length === 2, 'probe matcher: it flags a planted sentence (so an emptied matcher cannot pass)')

  if (checks !== EXPECTED) {
    console.error(`[onboarding-copy-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED} (a section was skipped, or one was added without updating EXPECTED)`)
    process.exit(1)
  }
  if (failures > 0) {
    console.error(`[onboarding-copy-smoke] FAIL — ${failures}/${checks} checks failed`)
    process.exit(1)
  }
  console.log(`[onboarding-copy-smoke] OK — ${checks} checks passed`)
}

void main().catch((e) => {
  console.error('[onboarding-copy-smoke] FAIL — threw:', e)
  process.exit(1)
})
