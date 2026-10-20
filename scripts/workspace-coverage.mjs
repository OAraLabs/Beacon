#!/usr/bin/env node
/**
 * workspace-coverage — does the session-grouping feature have a population?
 *
 * Measures the REAL predicate, not a proxy: `GET /api/sessions/{id}/workspace` with
 * `source === 'session'` is a workspace someone bound with `/workspace <path>`. A proxy over
 * message text (paths mentioned in conversation) answers a wider question and overstates; this
 * asks the question the grouping would actually branch on.
 *
 * RUN:  BEACON_API_TOKEN=… node scripts/workspace-coverage.mjs
 *       (also accepts PROMETHEUS_API_TOKEN or BRIDGE_BACKEND_TOKEN)
 *       BEACON_GATEWAY_API=http://host:8005 overrides the default gateway.
 *
 * CONSTRAINTS THIS SCRIPT HOLDS TO
 *   read-only   GET only. No POST/PUT/DELETE anywhere, no local state written.
 *   no argv     the token is read from the environment. A command-line argument is visible in
 *               `ps` to every user on the box and lands in shell history.
 *   safe output the output is meant to be pasted back into a conversation, so it prints COUNTS
 *               and BASENAMES ONLY — never a full path, never `cwd`, never a host or user
 *               segment. This project has already reproduced a MagicDNS identity six times in a
 *               report; a measurement's own output is exactly where that happens next.
 *   breakdown   not just a headline — the three source states, the same three for the last 30
 *               days (the decisive slice: concurrent active work, not the findability tail), the
 *               same three for HARNESS, and the distinct-basename count so worktree
 *               fragmentation is measured rather than inferred.
 */

const GATEWAY = process.env.BEACON_GATEWAY_API || 'http://127.0.0.1:8005'
const TOKEN =
  process.env.BEACON_API_TOKEN || process.env.PROMETHEUS_API_TOKEN || process.env.BRIDGE_BACKEND_TOKEN || ''

if (!TOKEN) {
  console.error('FATAL: no token in the environment.')
  console.error('  Set one of BEACON_API_TOKEN / PROMETHEUS_API_TOKEN / BRIDGE_BACKEND_TOKEN and re-run.')
  console.error('  Do NOT pass it as an argument — argv is visible in `ps` and saved to shell history.')
  process.exit(2)
}

const HEADERS = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** GET returning parsed JSON, or {__status} on a non-2xx. Never throws on HTTP status. */
async function get(path) {
  try {
    const res = await fetch(`${GATEWAY}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(15000) })
    if (!res.ok) return { __status: res.status }
    return await res.json()
  } catch (e) {
    return { __error: String(e?.message ?? e).slice(0, 80) }
  }
}

// ── the same classifier the sidebar ships (session-sources.ts) ───────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isHarnessId = (id) => {
  const s = (id || '').trim()
  if (!s) return false
  if (s.includes(':')) return false
  return !UUID_RE.test(s)
}

/**
 * Basename, resolved to the REPOSITORY rather than the checkout.
 *
 * Five git worktrees of one repo must not become five project sections — that is the feature
 * inverting itself at the derivation layer. Stripping a `-wt` suffix would be a pattern match on
 * what someone named a directory, right by coincidence and wrong the day a repo is legitimately
 * named that way. `git rev-parse --git-common-dir` resolves a linked worktree to its parent repo,
 * which is a rule about what a project IS.
 *
 * This script cannot run git against a remote host's paths, so it reports the RAW basename and
 * flags candidate worktree fragmentation separately. Resolution belongs wherever the derivation
 * lives — possibly the daemon, which may already do it.
 */
const basename = (p) => {
  const s = String(p || '').replace(/\/+$/, '')
  const i = s.lastIndexOf('/')
  return i >= 0 ? s.slice(i + 1) : s
}

const DAY = 86_400_000
const lastActiveMs = (s) => {
  const v = s?.last_active ?? s?.lastActive ?? s?.updated_at ?? null
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000
  if (typeof v === 'string') {
    const t = Date.parse(v.endsWith('Z') || /[+-]\d\d:\d\d$/.test(v) ? v : `${v}Z`)
    return Number.isFinite(t) ? t : 0
  }
  return 0
}

const main = async () => {
  const list = await get('/api/sessions')
  if (list?.__status || list?.__error) {
    console.error(`FATAL: GET /api/sessions failed (${list.__status ?? list.__error}).`)
    console.error(list.__status === 401 ? '  401 — the token is wrong or expired.' : '')
    process.exit(3)
  }
  const sessions = Array.isArray(list) ? list : (list.sessions ?? list.items ?? [])
  if (!Array.isArray(sessions) || sessions.length === 0) {
    console.error('FATAL: no sessions in the response — refusing to report 0% off an empty list.')
    process.exit(4)
  }

  const now = Date.now()
  const tally = () => ({ session: 0, daemon: 0, neither: 0, unreadable: 0 })
  const all = tally()
  const recent = tally()
  const harness = tally()
  const names = new Map() // basename -> count

  process.stderr.write(`probing ${sessions.length} sessions…\n`)
  let n = 0
  let usable = 0 // rows that actually carried an id — see the guard after the loop
  for (const s of sessions) {
    const id = s?.id ?? s?.session_id
    if (!id) continue
    usable += 1
    const ws = await get(`/api/sessions/${encodeURIComponent(id)}/workspace`)
    const isRecent = now - lastActiveMs(s) <= 30 * DAY
    const isHarn = isHarnessId(id)

    let key
    // A 404 is NOT a measured absence. The daemon's documented unbound case is a 200 carrying
    // `source: 'daemon'` (checkpoints-smoke asserts exactly that), so a 404 means session-not-found
    // or endpoint-not-found — both unreadable. Mapping it to "no workspace" would turn a MOVED
    // ENDPOINT into `none: 190`, which passes the zero-measurement guard below and reads as a
    // clean 0% coverage. That is the confident-no-build-from-a-transport-error failure again, one
    // layer deeper than the guard was written for.
    if (ws?.__status || ws?.__error) key = 'unreadable'
    else if (ws?.source === 'session' && (ws.workspace ?? ws.path ?? ws.cwd)) key = 'session'
    else if (ws?.source === 'daemon') key = 'daemon'
    else key = 'neither'

    all[key] += 1
    if (isRecent) recent[key] += 1
    if (isHarn) harness[key] += 1

    // Basenames ONLY, and only for a genuinely bound workspace.
    if (key === 'session') {
      const b = basename(ws.workspace ?? ws.path ?? ws.cwd)
      if (b) names.set(b, (names.get(b) ?? 0) + 1)
    }
    if (++n % 25 === 0) process.stderr.write(`  …${n}\n`)
    await sleep(40) // be kind to the daemon
  }

  // FAIL CLOSED ON A SHAPE ERROR, not just an empty list.
  //
  // An array of objects that carry no id parses fine, is non-empty, and skips every row — which
  // printed `session 0` and exited 0. That is a transport/shape error wearing the costume of a
  // measured absence, and a confident no-build decision made out of it is the exact failure this
  // whole line of work exists to prevent. Caught by scripts/../failclosed harness, case
  // "200 array of garbage".
  if (usable === 0) {
    console.error(`FATAL: ${sessions.length} row(s) came back but none carried an id — this is not a session list.`)
    console.error('  Refusing to report coverage off a response whose shape is wrong.')
    process.exit(5)
  }

  // FAIL CLOSED ON A ZERO-MEASUREMENT PASS.
  //
  // The session list can be perfect while every per-session /workspace call fails — a token
  // missing that scope, an endpoint that moved, aggressive rate limiting. That prints
  // `session 0` beside `unreadable 190`: the zero is honest, and it still reads as a measured
  // absence and trips the no-build threshold. A total outage must not produce a confident
  // decision NOT to build. Nothing was measured, so there is no number to print.
  const measured = all.session + all.daemon + all.neither
  if (measured === 0) {
    console.error(`FATAL: ${all.unreadable} session(s) probed, NONE readable — nothing was measured.`)
    console.error('  Every /workspace call failed (scope, moved endpoint, or rate limiting).')
    console.error('  Refusing to print coverage: a total outage must not look like 0% coverage.')
    process.exit(6)
  }

  const pct = (a, b) => (b ? `${Math.round((a * 100) / b)}%` : 'n/a')
  const row = (label, t) => {
    const tot = t.session + t.daemon + t.neither + t.unreadable
    console.log(
      `  ${label.padEnd(22)} total ${String(tot).padStart(4)}   ` +
        `session ${String(t.session).padStart(4)} (${pct(t.session, tot).padStart(4)})   ` +
        `daemon ${String(t.daemon).padStart(4)}   none ${String(t.neither).padStart(4)}   ` +
        `unreadable ${String(t.unreadable).padStart(3)}`
    )
  }

  console.log('\n=== workspace coverage — source==="session" is the real predicate ===\n')
  // Soft rail: a partial outage does not invalidate the run, but it must not be read past. Loud,
  // and ABOVE the table, because a warning printed underneath a number is a warning nobody reads.
  const totalAll = all.session + all.daemon + all.neither + all.unreadable
  if (all.unreadable * 2 > totalAll) {
    console.log(`  *** ${all.unreadable} of ${totalAll} sessions were UNREADABLE — over half. ***`)
    console.log('  *** The counts below describe the readable minority. Do NOT read a threshold  ***')
    console.log('  *** off them until the failures are explained.                                ***\n')
  }
  row('ALL', all)
  row('ACTIVE (last 30d)', recent)
  row('HARNESS', harness)

  console.log(`\n  distinct workspace basenames: ${names.size}`)
  const sorted = [...names.entries()].sort((a, b) => b[1] - a[1])
  for (const [b, k] of sorted) console.log(`     ${b.padEnd(30)} ${String(k).padStart(3)} session(s)`)

  // Candidate worktree fragmentation, measured rather than inferred. Reported as a QUESTION —
  // confirming it needs `git rev-parse --git-common-dir` where the paths actually live.
  const stems = new Map()
  for (const [b] of sorted) {
    const stem = b.replace(/[-_](wt|worktree)([-_].*)?$/i, '')
    if (stem !== b) stems.set(stem, (stems.get(stem) ?? 0) + 1)
  }
  if (stems.size > 0) {
    console.log('\n  possible worktree fragmentation (names that look like linked checkouts):')
    for (const [stem, k] of stems) console.log(`     ${stem}: ${k} sibling name(s)`)
    console.log('     → confirm with `git rev-parse --git-common-dir`; do NOT strip the suffix as a rule.')
  }

  if (all.unreadable > 0) {
    console.log(`\n  NOTE: ${all.unreadable} session(s) could not be read. They are counted separately and`)
    console.log('        are NOT folded into "none" — an unreadable session is not a measured absence.')
  }
  console.log('')
}

main()
