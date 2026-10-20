/**
 * Run every smoke, and make the ones that cannot run SAY SO.
 *
 * `npm run verify` NOW ENDS WITH THIS (it used to be typecheck + lint + build only, running none of
 * the smokes — which is how integrations-smoke sat red on main since Devices (#88), pinning
 * NAV_VIEWS.length at 15 while nav-smoke pinned 17. The gate that would have caught it never ran.)
 *
 * That costs verify ~7s -> ~150s, so the old chain kept its name as `verify:quick`. Use that in the
 * edit loop; `verify` before you push.
 *
 * The design constraint is that this must not become noise. A runner with permanent failures
 * teaches people to ignore it, so a smoke that needs a live daemon is SKIPPED with the reason and
 * the exact env it wants — never left red. Skips are loud, counted, and listed.
 *
 *   npm run smoke:all                 # daemon smokes skipped, with reasons
 *   BEACON_GATEWAY_HOST=<host> BEACON_SMOKE_TOKEN=<token> npm run smoke:all   # runs everything
 */
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { connect } from 'node:net'

/**
 * Smokes that drive the REAL daemon. Verified by running each against a live one: step2 and step4
 * pass with BEACON_API_TOKEN, step6 with BEACON_GATEWAY_TOKEN. Everything else in the repo either
 * needs no daemon or degrades to its offline half on its own.
 *
 * This list is a claim, so the runner checks it: a skipped smoke that would have PASSED offline is
 * an over-broad entry, and a failure outside this list is a real failure, never a skip.
 */
const NEEDS_DAEMON = {
  'smoke:step2': 'drives the real connection layer: WS subscribe + POST a message and await the streamed reply',
  'smoke:step4': 'reconciles the session list against the daemon',
  'smoke:step6': 'lists real sessions to check the cache↔daemon reconcile'
}

const HOST = process.env.BEACON_GATEWAY_HOST ?? ''
// One token in, three names out. The smokes read three different variables for the SAME secret
// (BEACON_API_TOKEN, PROMETHEUS_API_TOKEN, BEACON_GATEWAY_TOKEN) — a caller should not have to
// know that, and a caller who guesses wrong gets a confusing auth failure instead of a skip.
const TOKEN_NAMES = ['BEACON_SMOKE_TOKEN', 'BEACON_API_TOKEN', 'PROMETHEUS_API_TOKEN', 'BEACON_GATEWAY_TOKEN']
// PROMETHEUS_API_TOKEN belongs in this list: the comment above already says the smokes read it,
// and it is the name the daemon's own env file uses, so it is the one a caller reaches for first.
// Leaving it out meant exporting the obvious variable produced three skips AND a false OVER-BROAD.
const TOKEN = TOKEN_NAMES.map((n) => process.env[n]).find(Boolean) || ''

const reachable = (host, port) =>
  new Promise((resolve) => {
    const sock = connect({ host, port, timeout: 2500 })
    sock.on('connect', () => (sock.destroy(), resolve(true)))
    sock.on('error', () => resolve(false))
    sock.on('timeout', () => (sock.destroy(), resolve(false)))
  })

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const smokes = Object.keys(pkg.scripts).filter((s) => /^smoke:/.test(s) && s !== 'smoke:all').sort()

let daemonUp = false
let daemonWhy = 'BEACON_GATEWAY_HOST is not set'
if (HOST) {
  daemonUp = await reachable(HOST, Number(process.env.BEACON_GATEWAY_API_PORT ?? 8005))
  daemonWhy = daemonUp ? '' : `nothing answered on ${HOST}:8005`
  if (daemonUp && !TOKEN) {
    daemonUp = false
    daemonWhy = `${HOST}:8005 answered but no token was given (set one of ${TOKEN_NAMES.join(', ')})`
  }
}

const env = daemonUp
  ? { ...process.env, BEACON_API_TOKEN: TOKEN, PROMETHEUS_API_TOKEN: TOKEN, BEACON_GATEWAY_TOKEN: TOKEN }
  : process.env

// The skip-list audit below claims to run each skipped smoke "without a daemon". Inheriting
// process.env does NOT give you that: the host and any token still in the caller's shell come
// along, the smoke reaches the real daemon, passes, and gets branded OVER-BROAD for needing the
// daemon it just used. A control has to actually withhold the thing being controlled for.
const OFFLINE_ENV = (() => {
  const e = { ...process.env }
  for (const n of [...TOKEN_NAMES, 'BEACON_GATEWAY_HOST', 'BEACON_GATEWAY_API_PORT']) delete e[n]
  return e
})()

const run = (script, runEnv = env) =>
  new Promise((resolve) => {
    const child = spawn('npm', ['run', '--silent', script], { env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ script, code, out }))
  })

console.log(`\n[smoke:all] ${smokes.length} smokes`)
console.log(daemonUp ? `[smoke:all] daemon at ${HOST} — live smokes WILL run` : `[smoke:all] no daemon (${daemonWhy}) — ${Object.keys(NEEDS_DAEMON).length} live smokes will be skipped`)

const passed = [], failed = [], skipped = [], overBroad = []
const notes = []
// A GREEN SMOKE CAN STILL BE TELLING YOU SOMETHING. This runner discards a passing smoke's output,
// and that is exactly how step4's teardown warning stayed invisible for three commits: the smoke
// warned that it had left a real session behind on the daemon, printed it to stdout, passed, and
// the warning went in the bin. Litter accumulated across runs while every run reported pass.
//
// So: a passing smoke's output is scanned for lines that admit something went wrong, and those are
// surfaced under the pass line. Deliberately narrow — these are words a smoke uses when it is
// reporting on ITSELF, not assertion chatter — because a noisy channel gets ignored, which would
// put us right back where we started.
const NOTEWORTHY = /\b(WARN|WARNING|INCOMPLETE|resurfaced|left for the next run|could not|unable to|skipping)\b/i
const noteworthy = (out) =>
  out
    .split('\n')
    .map((l) => l.trim())
    // Assertion lines are not notes: a smoke that PASSES an assertion whose text happens to contain
    // "warn" is not warning you about anything ("✓ failed_abandoned → Abandoned at cap (warn)").
    .filter((l) => l && NOTEWORTHY.test(l) && !/^[✓✗]|^\s*\[smoke\]\s*(PASS|FAIL)\b/.test(l))
    .slice(0, 4)
// `out` is passed in rather than read from a shared variable: worker() runs 4-up, and a module-level
// "last output" would be one await away from attributing one smoke's warning to another.
const reportPass = (s, out, suffix = '') => {
  passed.push(s)
  console.log(`  pass  ${s}${suffix}`)
  for (const line of noteworthy(out)) {
    notes.push({ script: s, line })
    console.log(`        note: ${line}`)
  }
}
const LIMIT = 4
// Pure smokes are independent, so run them 4-up. Live ones share ONE daemon and MUTATE its state
// (step4 poisons a watermark and expects to see the effect), so running them alongside each other
// makes them fight: step4 passed standalone and failed inside this runner with "poisoned watermark
// still pulls history (pulled 0)" the first time it was parallelised. They run serially, last.
const queue = smokes.filter((s) => !NEEDS_DAEMON[s])
const liveQueue = smokes.filter((s) => NEEDS_DAEMON[s])
async function worker() {
  while (queue.length) {
    const s = queue.shift()
    const r = await run(s)
    if (r.code === 0) {
      reportPass(s, r.out)
    } else {
      failed.push({ ...r })
      console.log(`  FAIL  ${s}`)
    }
  }
}
// Warm the Electron binary ONCE, serially, before the pool opens.
//
// Every smoke runs `ELECTRON_RUN_AS_NODE=1 electron out/main/<x>.js`. On a machine that has never
// launched this particular Electron build — a CI runner, or a dev the first time after a version
// bump — the first concurrent launches RACE, and a loser exits 1 with no stdout and no stderr at
// all. Nothing identifies it as a launch problem; it reads as "that smoke is broken".
//
// Measured on the Electron 44 bump (#124), two CI runs of the SAME commit:
//   run 1 — 4 failures: activity-frames, artifacts, at-references, attachment  (exactly LIMIT)
//   run 2 — 2 failures: approval, artifacts
// A different set each time, always early in the queue, and never reproducible once the binary is
// warm. That is also why a re-run "fixes" it — which is the property that makes this expensive:
// it teaches people to re-run a red build instead of reading it.
//
// One serial launch costs about a second and removes the whole class. It never fails the suite:
// if the warm-up itself cannot run, the smokes below will say so with their own output.
const warmUp = async () => {
  let electronBin
  try {
    electronBin = createRequire(import.meta.url)('electron')
  } catch {
    return // no electron resolved — the smokes are about to report that far better than this can
  }
  if (typeof electronBin !== 'string') return
  await new Promise((resolve) => {
    const c = spawn(electronBin, ['-e', 'process.exit(0)'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore',
    })
    c.on('exit', resolve)
    c.on('error', resolve)
  })
}
await warmUp()

await Promise.all(Array.from({ length: LIMIT }, worker))

// the live ones, one at a time, sharing the single daemon between them
for (const s of liveQueue) {
  if (!daemonUp) {
    skipped.push(s)
    console.log(`  SKIP  ${s} — ${NEEDS_DAEMON[s]} (${daemonWhy})`)
    continue
  }
  const r = await run(s)
  if (r.code === 0) {
    reportPass(s, r.out, ' (live, serial)')
  } else {
    failed.push({ ...r })
    console.log(`  FAIL  ${s} (live, serial)`)
  }
}

if (failed.length) {
  console.log('\n[smoke:all] failures in detail:')
  for (const f of failed) {
    const lines = f.out.split('\n').filter((l) => /FAIL|Error|outcome|RESULT/i.test(l)).slice(0, 6)
    console.log(`\n  ── ${f.script} (exit ${f.code})`)
    // A failure with nothing under it reads as a detail the runner chose not to show. It is the
    // opposite — the process said nothing at all, which is itself the diagnosis (it usually means
    // the binary never got as far as running the script). Say which of the two happened.
    if (lines.length === 0) {
      console.log(`     (no output on stdout or stderr — the process produced nothing before exiting ${f.code})`)
    }
    for (const l of lines) console.log(`     ${l.trim().slice(0, 160)}`)
  }
}

// AUDIT the skip list, because a skip is an excuse and excuses go stale. Each skipped smoke is
// run offline anyway: it MUST fail there. One that passes without a daemon does not need one, and
// its entry is quietly excusing a smoke that could have been running all along — the same shape as
// the stale pin this runner exists to catch.
if (skipped.length && !daemonUp) {
  console.log('\n[smoke:all] auditing the skip list (each must genuinely fail without a daemon)')
  for (const s of skipped) {
    const r = await run(s, OFFLINE_ENV)
    if (r.code === 0) {
      overBroad.push(s)
      console.log(`  OVER-BROAD  ${s} — passes WITHOUT a daemon; it should not be in NEEDS_DAEMON`)
    } else {
      console.log(`  justified   ${s}`)
    }
  }
}

console.log(`\n[smoke:all] pass ${passed.length}   fail ${failed.length}   skip ${skipped.length}`)
if (notes.length) console.log(`[smoke:all] ${notes.length} note(s) from PASSING smokes — green does not mean silent`)
if (skipped.length) {
  console.log(`[smoke:all] skipped: ${skipped.join(', ')}`)
  console.log('[smoke:all] to run them:  BEACON_GATEWAY_HOST=<host> BEACON_SMOKE_TOKEN=<token> npm run smoke:all')
}
// A skip is not a pass. It exits 0 so this is usable as a gate without a daemon, but the count is
// always printed so "everything green" can never quietly mean "three of them never ran".
if (overBroad.length) {
  console.log(`[smoke:all] ${overBroad.length} skip entr${overBroad.length === 1 ? 'y is' : 'ies are'} over-broad: ${overBroad.join(', ')}`)
}
process.exit(failed.length || overBroad.length ? 1 : 0)
