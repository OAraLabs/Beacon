/**
 * Headless smoke: a model server's row never says "stale" (owner decision, 2026-10-18, for 0.4.8). Prometheus checks a local model's server once at
 * boot and calls the reading stale 60 s later; the film read "Local · default STALE" at 61 s, and a server that was down read UP, then
 * STALE, never DOWN (the daemon hard-codes available: true on the Local row). @shared/backend-health decides, from the daemon's own
 * fields: DOWN on a failed check (health.ok false) with a plain one-line reason, UP otherwise, and stale only as "check again" for an
 * owner, at most every RECHECK_MIN_MS. And a cloud default is named by its model, not "Local".
 * scripts/models-health-app-probe.mjs paints it against a real Prometheus.
 *
 *   npm run build && npm run smoke:backend-health
 */
import { readFileSync } from 'node:fs'
import { backendReading, cloudTwin, defaultRowLabel, needsRecheck, plainCheckFailure, recheckDue, RECHECK_MIN_MS } from '@shared/backend-health'
import { backendHealthBadge } from '@shared/composer-controls'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[backend-health-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 8
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.error(`[backend-health-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`[backend-health-smoke] FAIL — ${failures}/${checks} checks failed`)
    process.exitCode = 1
  } else console.log(`[backend-health-smoke] OK — ${checks} checks passed`)
})
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
const src = (p: string): string => strip(readFileSync(p, 'utf8'))

// The daemon's own readings (Prometheus 0.9.13 providers/backends.py as_dict, trimmed by web/server.py _backend_health).
const fresh = { ok: true, probed: true, stale: false, error: null, probed_at: '2026-10-18T15:25:54Z' }
const staleOk = { ...fresh, stale: true }
const failed = { ok: false, probed: true, stale: false, error: 'ConnectError: All connection attempts failed', probed_at: '2026-10-18T15:27:00Z' }
const never = { ok: false, probed: false, stale: true, error: null, probed_at: null }

const up = [backendReading(true, fresh), backendReading(true, staleOk)]
assert(up.every((r) => r.state === 'up') && up[1].checkedAt === staleOk.probed_at, 'a good reading is UP, stale or not (stale is when it was checked, not how it is); the time is kept for a tooltip', JSON.stringify(up))
const down = [backendReading(true, failed), backendReading(false, fresh), backendReading(true, { ...failed, stale: true })]
assert(down.every((r) => r.state === 'down' && !!r.reason), 'a failed check is DOWN with a reason, though the daemon says available: true; so is available: false', JSON.stringify(down))
assert(backendReading(true, never).state === 'checking' && backendReading(true, null).state === 'up', 'never checked is "checking"; no health at all (no registry, or a cloud default) claims nothing bad', JSON.stringify([backendReading(true, never), backendReading(true, null)]))
const RAW = /ConnectError|Errno|Traceback|timed out after|httpx|attempts failed|\d+(\.\d+)?s\b/i
const errors = ['ConnectError: All connection attempts failed', 'probe timed out after 5s', 'HTTPStatusError: 500', null]
const reasons = errors.map(plainCheckFailure)
// Not the raw text in any shape (an error the RAW list does not name, HTTPStatusError, passed as the reason in the sweep's mutant), and a
// server that is not there is told apart from one that answered badly: that is the one a person can fix (start it).
assert(
  reasons.every((r, i) => r.length > 10 && !RAW.test(r) && !r.includes('\n') && !(errors[i] && r.includes(errors[i] as string))) &&
    /answering|running/i.test(reasons[0]) && reasons[0] !== reasons[2] && reasons[1] !== reasons[2],
  'the reason is one plain line, never the probe\'s raw error; "nothing is answering" for a server that is not there',
  JSON.stringify(reasons)
)
assert(
  needsRecheck(staleOk) && needsRecheck(never) && !needsRecheck(fresh) && !needsRecheck(null) && needsRecheck({ ...failed, stale: true }) && !needsRecheck(failed),
  'a check again is due when the reading is stale or was never taken; not when it is fresh, nor when there is nothing to check'
)
assert(recheckDue(undefined, 1000) && !recheckDue(1000, 1000 + RECHECK_MIN_MS - 1) && recheckDue(1000, 1000 + RECHECK_MIN_MS) && RECHECK_MIN_MS >= 30_000, `rate-limited: at most one check per server every ${RECHECK_MIN_MS / 1000} s`)
const catalog = [
  { key: 'local', label: 'Local', provider: 'anthropic', model: 'claude-sonnet-5', backend: 'local' },
  // Another model of the same provider first, as the daemon lists them: the match is on provider AND model.
  { key: 'claude:claude-haiku-4-5', label: 'Claude · claude-haiku-4-5', provider: 'anthropic', model: 'claude-haiku-4-5', backend: null },
  { key: 'claude', label: 'Claude · claude-sonnet-5', provider: 'anthropic', model: 'claude-sonnet-5', backend: null }
]
const ollama = { key: 'local', label: 'Local', provider: 'ollama', model: 'qwen2.5:7b-instruct', backend: 'local' }
const orphan = { key: 'local', label: 'Local', provider: 'openai', model: 'gpt-5-mini', backend: 'local' }
assert(
  defaultRowLabel(catalog[0], catalog) === 'Claude · claude-sonnet-5' && defaultRowLabel(ollama, [ollama]) === 'Local' && /gpt-5-mini/.test(defaultRowLabel(orphan, [orphan])) && !/^Local/.test(defaultRowLabel(orphan, [orphan])) &&
    cloudTwin(catalog[0], catalog)?.key === 'claude' && cloudTwin(ollama, [ollama, catalog[1]]) === undefined,
  'a cloud default is named by its model (the matching cloud row\'s own label, else the model); a local default stays "Local"',
  JSON.stringify([defaultRowLabel(catalog[0], catalog), defaultRowLabel(ollama, [ollama]), defaultRowLabel(orphan, [orphan])])
)
const badge = backendHealthBadge({ key: 'local', label: 'Local', backend: 'local', health: staleOk } as never)
const views = ['MissionControl.tsx', 'ModelKeysTab.tsx'].map((f) => src(`src/renderer/src/components/${f}`))
const mc = views.join('\n')
// The re-check is one hook both views call (one rate-limit table for the page): each view calls it, and it asks only when due.
const hook = src('src/renderer/src/backend-recheck.ts')
assert(
  !/stale/.test(badge ?? '') && !/'STALE'|>stale<|backends? stale|up and fresh/.test(mc) && views.every((v) => /backendReading\(/.test(v) && /useBackendRecheck\(/.test(v)) && /needsRecheck\(/.test(hook) && /recheckDue\(/.test(hook) && views.every((v) => /defaultRowLabel\(/.test(v)),
  'the chat menu badge, Mission and Config › Models say no "stale", read through backendReading, ask for a check when due, and name a cloud default',
  `badge "${badge}"`
)
