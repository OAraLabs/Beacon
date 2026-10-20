// Headless slash-command smoke (ELECTRON_RUN_AS_NODE electron out/main/slash-smoke.js).
// Proves the pure autocomplete model (X3): popup-open predicate, fuzzy ranking with the
// web-available partition, completion text, and the keyboard reducer — no DOM, no daemon.

import {
  SLASH_COMMANDS,
  destructiveSlash,
  slashBoundary,
  slashBoundaryReply,
  slashCompletion,
  slashKey,
  slashMatches,
  slashQuery
} from '@shared/slash-commands'

let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}

console.log('slashQuery (popup-open predicate):')
check("'/' opens", slashQuery('/') === '')
check("'/st' → 'st'", slashQuery('/st') === 'st')
check("'/status' → 'status'", slashQuery('/status') === 'status')
check("'/status x' closes (args started)", slashQuery('/status x') === null)
check("'' closes", slashQuery('') === null)
check("'hi /x' closes (not at start)", slashQuery('hi /x') === null)
check("'/home/demo/file' closes (path)", slashQuery('/home/demo/file') === null)

console.log('catalog sanity:')
const names = new Set(SLASH_COMMANDS.map((c) => c.name))
check('no duplicate names', names.size === SLASH_COMMANDS.length)
check('has core formatter commands', ['help', 'status', 'context', 'skills', 'note'].every((n) => names.has(n)))
check('has steering group', ['steer', 'queue', 'unqueue', 'clearsteers'].every((n) => names.has(n)))
check('has Telegram-only set', ['route', 'gepa', 'approve'].every((n) => names.has(n)))

console.log('slashMatches:')
{
  const r = slashMatches('')
  check('empty query → whole catalog', r.length === SLASH_COMMANDS.length)
  check('web-available first', r.findIndex((c) => !c.web) > r.findIndex((c) => c.web))
}
{
  const r = slashMatches('status')
  check("'/status' prefix-matches", r.length > 0 && r[0].name === 'status')
}
{
  const r = slashMatches('steer')
  check("'/steer' first for 'steer'", r.length > 0 && r[0].name === 'steer')
}
{
  // fuzzy: 'st' prefix-matches status/steer (web) before anything Telegram-bound
  const r = slashMatches('st')
  check("'st' ranks web prefix matches first", r.length >= 2 && r[0].web && r[1].web)
}
{
  const r = slashMatches('zzzznotacommand')
  check('garbage query → no matches', r.length === 0)
}

console.log('slashCompletion:')
check('completion inserts "/name "', slashCompletion({ name: 'note', desc: '', web: true }) === '/note ')

console.log('slashKey reducer:')
check('down wraps', slashKey('down', 2, 3).kind === 'move' && (slashKey('down', 2, 3) as { highlight: number }).highlight === 0)
check('up wraps from 0', (slashKey('up', 0, 3) as { highlight: number }).highlight === 2)
check('enter inserts highlighted', slashKey('enter', 1, 3).kind === 'insert' && (slashKey('enter', 1, 3) as { highlight: number }).highlight === 1)
check('tab inserts too', slashKey('tab', 0, 3).kind === 'insert')
check('escape dismisses', slashKey('escape', 0, 3).kind === 'dismiss')
check('count 0 → none', slashKey('down', 0, 0).kind === 'none')

// ── #126: web:false is a GATE, not a CSS class ────────────────────────────────
// The defect: slashBoundary did not exist; `web:false` only added a style + a "Telegram" badge and
// nothing checked it before send. So a command tagged Telegram-bound still fired at the daemon.
// Now the send site calls slashBoundary and replies locally instead. These pin the predicate.
console.log('slashBoundary (web:false is enforced at send):')
check('a Telegram-bound command IS gated', slashBoundary('/route foo')?.name === 'route')
check('gated with args too', slashBoundary('/gepa run')?.name === 'gepa')
check('a web-native command is NOT gated', slashBoundary('/status') === null)
check('a destructive web command is NOT gated (it runs, after confirm)', slashBoundary('/reset') === null)
check('Beacon-local command is NOT gated', slashBoundary('/search x') === null)
check('prose is NOT gated', slashBoundary('hello there') === null)
check('an unknown /command is NOT gated (the daemon router owns it)', slashBoundary('/nope') === null)
check('a leading slash mid-string is NOT gated', slashBoundary('run /route now') === null)
check('boundary reply names the command', slashBoundaryReply({ name: 'route', desc: '', web: false }).includes('/route'))
check('boundary reply says Telegram', /Telegram/.test(slashBoundaryReply({ name: 'route', desc: '', web: false })))

// ── #126: destructive web commands confirm before running ─────────────────────
// The lie was that `/reset` wore a "Telegram" badge (implying inert on web) while it actually
// cleared the web session's context. It is web:true + destructive: it runs, but the send site
// confirms first. destructiveSlash is what the confirm dialog keys on.
console.log('destructiveSlash (destructive web commands confirm):')
check('/reset is destructive', destructiveSlash('/reset') === 'reset')
check('/clear is destructive', destructiveSlash('/clear') === 'clear')
check('/reset with trailing space still matches', destructiveSlash('/reset ') === 'reset')
check('a non-destructive web command is not', destructiveSlash('/status') === null)
check('a Telegram-bound command is not destructive (it is gated, not run)', destructiveSlash('/route') === null)
check('prose is not destructive', destructiveSlash('reset everything') === null)

// ── #126: the catalog must MIRROR the daemon's WEB_NATIVE_ONLY ────────────────
// THE PARITY PIN. `qwen` was in the daemon's set (#183-#186) but missing from the catalog — exactly
// the drift this exists to catch. The daemon's set lives in another repo (Prometheus
// web/slash_router.py WEB_NATIVE_ONLY), transcribed here as the cross-checked constant. If that set
// changes on the daemon, this list is updated in the SAME PR that updates the catalog, and a
// mismatch fails the build instead of silently lying about a command's surface.
const DAEMON_WEB_NATIVE_ONLY = [
  'start', 'route', 'benchmark', 'voice', 'tools', 'pairs',
  'approve', 'deny', 'pending', 'gepa', 'symbiote', 'audit', 'press',
  'claude', 'gpt', 'gemini', 'xai', 'grok', 'local',
  'deepseek', 'kimi', 'glm', 'mimo', 'qwen', 'escalations'
].sort()
console.log('catalog ↔ daemon WEB_NATIVE_ONLY parity:')
{
  const catalogTel = SLASH_COMMANDS.filter((c) => c.web === false).map((c) => c.name).sort()
  const missing = DAEMON_WEB_NATIVE_ONLY.filter((n) => !catalogTel.includes(n))
  const extra = catalogTel.filter((n) => !DAEMON_WEB_NATIVE_ONLY.includes(n))
  check(`every daemon Telegram-bound command is in the catalog as web:false (missing: ${missing.join(',') || 'none'})`, missing.length === 0)
  check(`no catalog web:false command is absent from the daemon set (extra: ${extra.join(',') || 'none'})`, extra.length === 0)
  check('the two sets are the same size', catalogTel.length === DAEMON_WEB_NATIVE_ONLY.length)
  // The #126 invariant in one line: a destructive command must NEVER be tagged web:false (that is
  // the lie — a "Telegram" badge on something that actually runs and wipes the session here).
  check('no destructive command is tagged web:false', SLASH_COMMANDS.every((c) => !(c.destructive && c.web === false)))
  // reset/clear specifically: web:true AND destructive (they run on web, but ask first).
  const reset = SLASH_COMMANDS.find((c) => c.name === 'reset')
  const clear = SLASH_COMMANDS.find((c) => c.name === 'clear')
  check('/reset is web:true + destructive (not the old web:false lie)', reset?.web === true && reset?.destructive === true)
  check('/clear is web:true + destructive', clear?.web === true && clear?.destructive === true)
}

console.log('===================== RESULT =====================')
if (failures > 0) {
  console.error(`slash smoke: FAIL ✗ (${failures})`)
  process.exit(1)
}
console.log('slash smoke: PASS ✓ (query predicate, catalog, ranking partition, completion, keys)')
