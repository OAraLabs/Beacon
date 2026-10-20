#!/usr/bin/env node
/**
 * workspace-bind-probe — does Beacon's bind round trip actually work against a live daemon?
 *
 * WHY THIS EXISTS, AND WHY IT IS SEPARATE FROM THE SMOKE. `smoke:checkpoints` pins the model:
 * the candidate list, the boundary predicate, the confirmation copy, the refusal extraction. Not
 * one of those assertions can tell you whether the PUT fires, whether the daemon accepts the body
 * shape, or whether the five refusal sentences are the ones this client renders. Before this
 * script, Beacon had never issued a single write to this endpoint — 78 GETs, zero PUTs — so every
 * fixture describing a refusal was a fixture someone wrote from reading the daemon source.
 * This captures the WIRE instead.
 *
 * RUN (Will runs this; it is not part of `verify`):
 *   BEACON_API_TOKEN=… BEACON_GATEWAY_API=http://<host>:8005 \
 *   WORKSPACE_BIND_PROBE=i-understand-this-writes node scripts/workspace-bind-probe.mjs
 *
 * THIS SCRIPT MUTATES THE DAEMON. That is the whole point, and it is why it is gated:
 *   * it PUTs and DELETEs a session workspace, which the daemon logs at WARNING;
 *   * it uses its OWN scratch session id (below), never one of yours, so no real conversation's
 *     write boundary is touched;
 *   * it ends with a DELETE, so the row it creates is left cleared;
 *   * the refusal cases are refusals — they write nothing by construction.
 *
 * CONSTRAINTS, same as workspace-coverage.mjs:
 *   read-only-ish  the only writes are to the scratch session named here.
 *   no argv        the token comes from the environment; argv is visible in `ps` and lands in
 *                  shell history.
 *   safe output    counts, basenames and the daemon's own sentences. Never a full bound path,
 *                  never the host, never a user segment. This project has reproduced a MagicDNS
 *                  identity in a report six times; a probe's output is exactly where that happens
 *                  next.
 */

const GATEWAY = process.env.BEACON_GATEWAY_API || 'http://127.0.0.1:8005'
const TOKEN =
  process.env.BEACON_API_TOKEN || process.env.PROMETHEUS_API_TOKEN || process.env.BRIDGE_BACKEND_TOKEN || ''
const GATE = process.env.WORKSPACE_BIND_PROBE || ''

/** Ours, and obviously ours. Never a real conversation. */
const SCRATCH = 'desktop:workspace-bind-probe'

if (GATE !== 'i-understand-this-writes') {
  console.error('FATAL: this probe WRITES to the daemon (PUT + DELETE of a session workspace).')
  console.error('  It binds and then clears a scratch session id, and the daemon logs each at WARNING.')
  console.error('  Re-run with WORKSPACE_BIND_PROBE=i-understand-this-writes once you have read the header.')
  process.exit(2)
}
if (!TOKEN) {
  console.error('FATAL: no token in the environment.')
  console.error('  Set BEACON_API_TOKEN / PROMETHEUS_API_TOKEN / BRIDGE_BACKEND_TOKEN and re-run.')
  console.error('  Do NOT pass it as an argument — argv is visible in `ps` and saved to shell history.')
  process.exit(2)
}

const HEADERS = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' }
const WS_PATH = `/api/sessions/${encodeURIComponent(SCRATCH)}/workspace`

let failures = 0
function check(ok, what, detail) {
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures++
}
/** Basename only. The whole point of the output rule. */
const base = (p) => (typeof p === 'string' && p ? p.split('/').filter(Boolean).pop() || '/' : String(p))

async function call(method, body) {
  const res = await fetch(`${GATEWAY}${WS_PATH}`, {
    method,
    headers: body === undefined ? HEADERS : { ...HEADERS, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000)
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON — that is itself a finding */ }
  return { status: res.status, json, text }
}

console.log(`[probe] gateway reachable check + scratch session ${SCRATCH}`)

/**
 * The header promises this probe leaves the scratch session unbound. A trailing DELETE only keeps
 * that promise on the happy path — any throw or a Ctrl-C between the bind and the end would have
 * left a live session bound, which is precisely the state this exists to avoid creating. So the
 * clear runs from an exit hook as well, and the promise holds however the script ends.
 */
let cleaned = false
const clearScratch = () => {
  if (cleaned) return
  cleaned = true
  // Fire-and-forget on the way out: an exit hook cannot await, and a best-effort clear is better
  // than none. The assertion at the end is what PROVES it on a normal run.
  try {
    fetch(`${GATEWAY}${WS_PATH}`, { method: 'DELETE', headers: HEADERS }).catch(() => {})
  } catch { /* nothing left to do on the way out */ }
}
process.on('uncaughtException', (e) => { console.error('probe threw:', e?.message ?? e); clearScratch(); process.exitCode = 1 })
process.on('unhandledRejection', (e) => { console.error('probe rejected:', e?.message ?? e); clearScratch(); process.exitCode = 1 })
process.on('SIGINT', () => { clearScratch(); process.exit(130) })

// ── 1. GET: the candidate list the UI depends on is actually on the wire ─────────────────────
const g0 = await call('GET')
check(g0.status === 200, 'GET /workspace answers 200', `status ${g0.status}`)
const roots = Array.isArray(g0.json?.daemon_workspace_roots) ? g0.json.daemon_workspace_roots : null
check(roots !== null, 'GET carries daemon_workspace_roots (the candidate list)', roots ? `${roots.length} root(s)` : 'ABSENT')
check(typeof g0.json?.daemon_cwd === 'string', 'GET carries daemon_cwd')
if (roots && typeof g0.json?.daemon_cwd === 'string') {
  const cwd = g0.json.daemon_cwd
  const inside = roots.some((r) => {
    const n = String(r).replace(/\/+$/, '') || '/'
    const c = cwd.replace(/\/+$/, '') || '/'
    return c === n || c.startsWith(n === '/' ? '/' : `${n}/`)
  })
  // The finding the UI labels. Recording the ANSWER for this box, not asserting either way.
  console.log(`[probe] NOTE  daemon_cwd is ${inside ? 'INSIDE' : 'OUTSIDE'} the configured roots — binding to it ${inside ? 'narrows' : 'WIDENS'} the boundary here`)
}
check(g0.json?.source === 'daemon' || g0.json?.source === 'session', 'GET reports a source', String(g0.json?.source))

// ── 2. the four REACHABLE refusals, checked against the sentences Beacon renders ──────────
// "a path is required" is deliberately absent — and that is FOUR, not five: the handler treats a
// blank path as a CLEAR before the validator runs, so REST can never produce it. A probe that
// "confirmed" it would be lying.
//
// Each case asserts the SHAPE of the sentence, not merely that one exists. Printing the wire and
// asserting only `Boolean(sentence)` would pass on any 400 the daemon ever invents, which is the
// opposite of pinning the four fixtures the client's copy was written from.
const denied = `${process.env.HOME ?? '/root'}/.ssh`
const REFUSALS = [
  ['relative/path', 'a relative path', /absolute path/i],
  ['/nonexistent-beacon-probe-dir', 'a path that is not a directory', /not an existing directory/i],
  ['/', 'the filesystem root', /filesystem root cannot be a workspace/i],
  // The denied-path case matters twice over: it is the only refusal long enough to exceed
  // `safeText`'s 200-char slice, which is the branch where daemonErrorSentence must return null
  // rather than half a sentence. Skipping it left that branch tested only against a hand-made
  // fixture. If .ssh is not denied on this host the assertion says so instead of quietly passing.
  [denied, 'a denied path', /under denied path/i]
]
for (const [path, what, shape] of REFUSALS) {
  const r = await call('PUT', { path })
  const sentence = typeof r.json?.error === 'string' ? r.json.error : null
  check(r.status === 400, `PUT ${what} is refused with 400`, `status ${r.status}`)
  check(Boolean(sentence) && shape.test(sentence), '…and the sentence is the expected one', sentence ?? r.text.slice(0, 120))
  if (sentence) {
    console.log(`[probe] WIRE  ${JSON.stringify(sentence)}  (${sentence.length} chars)`)
    if (sentence.length + 12 > 200) console.log('[probe] NOTE  that one exceeds safeText’s 200-char slice — the truncation branch is live on this host')
  }
}
const bad = await call('PUT', { path: 123 })
check(bad.status === 400 && bad.json?.error === 'path must be a string', 'a non-string path is refused', String(bad.json?.error))
// A refusal must write NOTHING. Asserting the four above returned 400 does not say the store was
// left alone; this does.
const afterRefusals = await call('GET')
check(!afterRefusals.json?.workspace, 'none of the refusals bound anything', String(afterRefusals.json?.workspace))

// ── 3. the round trip: bind → read back → clear → read back ──────────────────────────────────
// Bound to the daemon's OWN cwd: a directory the daemon has already proven exists, so the probe
// never has to invent a path on the host.
const target = typeof g0.json?.daemon_cwd === 'string' ? g0.json.daemon_cwd : null
if (!target) {
  check(false, 'a bindable target came back from the GET', 'no daemon_cwd — skipping the round trip')
} else {
  const put = await call('PUT', { path: target })
  check(put.status === 200, 'PUT binds', `status ${put.status}`)
  check(put.json?.ok === true, 'PUT answers ok:true')
  // THE ASYMMETRY. Request key `path`, response key `workspace`. If this ever flips, the panel's
  // outcome line goes blank and reports "nothing is bound" after a successful bind.
  check(typeof put.json?.workspace === 'string', 'the PUT RESPONSE names the field `workspace` (request named it `path`)', base(put.json?.workspace))
  check(put.json?.path === undefined, 'the response does NOT echo a `path` key — the asymmetry is real')

  const g1 = await call('GET')
  check(g1.json?.source === 'session', 'the read-back reports source:session', String(g1.json?.source))
  check(g1.json?.workspace === put.json?.workspace, 'the read-back returns the same RESOLVED path the PUT did')

  const del = await call('DELETE')
  check(del.status === 200, 'DELETE clears', `status ${del.status}`)
  check(del.json?.workspace === null, 'DELETE answers workspace:null')

  const g2 = await call('GET')
  check(g2.json?.source === 'daemon' && !g2.json?.workspace, 'the read-back after DELETE is unbound again', String(g2.json?.source))

  // {"path": ""} is documented as equivalent to DELETE. Proven, not assumed.
  // The re-bind this depends on is ASSERTED first, or "it cleared" would pass against a session
  // that was never bound in the first place.
  const reBind = await call('PUT', { path: target })
  check(reBind.status === 200 && Boolean(reBind.json?.workspace), 'the session is bound again before the blank-path test', `status ${reBind.status}`)
  const blank = await call('PUT', { path: '' })
  check(blank.status === 200 && blank.json?.workspace === null, 'PUT {"path": ""} is equivalent to DELETE', `status ${blank.status}`)
  const g3 = await call('GET')
  check(g3.json?.source === 'daemon', 'and the read-back agrees')
}

// ── 4. leave nothing bound ───────────────────────────────────────────────────────────────────
cleaned = true // the awaited clear below is the real one; keep the exit hook from racing it
await call('DELETE')
const final = await call('GET')
check(final.json?.source === 'daemon' && !final.json?.workspace, 'the scratch session is left UNBOUND', String(final.json?.source))

console.log(`\n[probe] ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
