/**
 * Headless smoke for the Usage tab. Pure model only.
 *
 * ONE assertion is the reason this file exists: a null cost must never render as a dollar figure.
 * `qwen3.8-max` carried 89M input tokens on a flat Token Plan and showed as $0.00 for months
 * because "on a plan" and "spent nothing" were the same value. Every check below defends that
 * distinction somewhere.
 *
 * Run: npm run smoke:usage
 */
import {
  BILLING_LABEL,
  DEFAULT_USAGE_WINDOW,
  EMPTY_USAGE,
  USAGE_WINDOWS,
  usagePath,
  windowNote,
  costCell,
  coverageSentence,
  fmtTokens,
  fmtUsd,
  parseUsage
} from '@shared/usage'
import { CONFIG_TABS, isAllowedDaemonPath } from '@shared/daemon-api'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

// ── FIXTURE ──────────────────────────────────────────────────────────────────────────────────
// SHAPE captured from the deployed GET /api/usage (Prometheus d644e92, 2026-08-27). Token counts
// are the real ones — they are the point of the test — while the local model path is generalised.
// What the live read confirmed rather than what I assumed:
//   cost_usd      null on every non-metered row (NOT 0.0, NOT absent)
//   billing       all four modes occur in one response
//   model         CAN be the empty string — 284,981 input tokens arrived with no attribution
//   coverage      keyed by mode, and the dollar figure covers only 4% of tokens
const WIRE = {
  tracking_since: '2026-06-12T21:14:27Z',
  window_days: null,
  totals: {
    runs: 8141,
    input_tokens: 155_550_516,
    output_tokens: 2_021_449,
    cost_usd: 19.59,
    cost_covers_input_tokens: 6_189_096,
    cost_covers_share: 0.0398
  },
  coverage: {
    subscription: { models: 1, input_tokens: 89_042_118, output_tokens: 1_197_108 },
    local: { models: 3, input_tokens: 50_214_309, output_tokens: 313_324 },
    unknown: { models: 3, input_tokens: 10_104_993, output_tokens: 442_816 },
    metered: { models: 3, input_tokens: 6_189_096, output_tokens: 68_201 }
  },
  models: [
    { model: 'qwen3.8-max', billing: 'subscription', billing_reason: 'flat plan (token-plan.ap-southeast-1.maas.aliyuncs.com)', runs: 2044, input_tokens: 89_042_118, output_tokens: 1_197_108, cached_input_tokens: 0, cost_usd: null, first_seen: '2026-08-13T22:17:23Z', last_seen: '2026-08-27T02:03:43Z' },
    { model: '/models/Qwen3.8-27B.gguf', billing: 'local', billing_reason: 'served from a local model file', runs: 1603, input_tokens: 32_351_937, output_tokens: 180_694, cached_input_tokens: 0, cost_usd: null, first_seen: null, last_seen: null },
    { model: 'gemma4-26b', billing: 'unknown', billing_reason: 'no pricing entry and no configured plan — classify it in PRICING or BILLING', runs: 2637, input_tokens: 8_936_391, output_tokens: 407_338, cached_input_tokens: 0, cost_usd: null, first_seen: null, last_seen: null },
    { model: 'grok-4.5', billing: 'metered', billing_reason: 'priced per token', runs: 194, input_tokens: 6_017_769, output_tokens: 65_930, cached_input_tokens: 0, cost_usd: 19.0423, first_seen: null, last_seen: null },
    { model: '', billing: 'unknown', billing_reason: 'no model recorded on the row', runs: 391, input_tokens: 284_981, output_tokens: 17_843, cached_input_tokens: 0, cost_usd: null, first_seen: null, last_seen: null }
  ],
  daily: [{ day: '2026-08-27', input_tokens: 18_785_713, output_tokens: 59_134, runs: 128 }]
}

console.log('[smoke] === 1. a null cost is NEVER a dollar figure ===')
const u = parseUsage(WIRE)
const byModel = Object.fromEntries(u.models.map((m) => [m.model || '(unattributed)', m]))
assert(byModel['qwen3.8-max'].costUsd === null, 'the 89M-token plan row parses as null, not 0')
assert(costCell(byModel['qwen3.8-max']).isMoney === false, 'and its cost CELL is not money')
assert(costCell(byModel['qwen3.8-max']).text === 'on a plan', `it says why instead (${costCell(byModel['qwen3.8-max']).text})`)
assert(costCell(byModel['/models/Qwen3.8-27B.gguf']).text === 'no bill', 'a local model says "no bill", not $0.00')
assert(costCell(byModel['gemma4-26b']).text === 'unpriced', 'an unknown model says "unpriced" — an open question, not a zero')
assert(costCell(byModel['grok-4.5']).isMoney === true, 'a metered model DOES render money')
assert(costCell(byModel['grok-4.5']).text.startsWith('$'), `and it looks like money (${costCell(byModel['grok-4.5']).text})`)
// A genuinely-zero metered row is the one case $0.00 is CORRECT — the distinction must survive.
assert(costCell({ costUsd: 0, billing: 'metered' }).text === '$0.00', 'a metered row with real zero spend still shows $0.00')
assert(costCell({ costUsd: 0, billing: 'metered' }).isMoney === true, 'and it counts as money — that zero is a measurement')
assert(u.models.every((m) => (m.billing === 'metered') === (m.costUsd !== null)), 'cost and billing mode can never disagree')

console.log('[smoke] === 2. a missing cost stays missing ===')
// Coercing an absent number to 0 is the original defect; a parser must not reintroduce it.
const noCost = parseUsage({ models: [{ model: 'x', billing: 'metered' }] })
assert(noCost.models[0].costUsd === null, 'an ABSENT cost_usd parses to null, never 0')
const strCost = parseUsage({ models: [{ model: 'x', billing: 'metered', cost_usd: '5' }] })
assert(strCost.models[0].costUsd === null, 'a non-numeric cost_usd parses to null, never coerced')
const nanCost = parseUsage({ models: [{ model: 'x', billing: 'metered', cost_usd: Number.NaN }] })
assert(nanCost.models[0].costUsd === null, 'NaN parses to null rather than reaching the screen')

console.log('[smoke] === 3. the headline carries its own coverage ===')
const sentence = coverageSentence(u.totals)
assert(sentence.includes('$19.59'), 'the total appears')
assert(sentence.includes('4%'), `and so does the share it covers (${sentence})`)
assert(/only/.test(sentence), 'phrased so the number cannot be read as the whole bill')
const full = coverageSentence({ ...u.totals, costCoversShare: 1 })
assert(!/only/.test(full), 'when dollars DO cover everything, the hedge disappears')
assert(coverageSentence({ ...u.totals, inputTokens: 0 }) === 'No usage recorded yet.', 'no usage says so plainly')

console.log('[smoke] === 4. billing modes survive the parse ===')
assert(u.models.length === 5, `every row parses (${u.models.length})`)
assert(new Set(u.models.map((m) => m.billing)).size === 4, 'all four billing modes are present in one response')
assert(byModel['(unattributed)'].model === '', 'a row with NO model is kept — 284,981 tokens with no attribution is a real finding, not a parse error')
assert(byModel['(unattributed)'].billing === 'unknown', 'and it is unknown, not silently bucketed')
assert(Object.keys(u.coverage).length === 4, 'coverage keeps all four buckets')
assert((u.coverage.subscription?.inputTokens ?? 0) > (u.coverage.metered?.inputTokens ?? 0), 'the plan carries more tokens than the metered models — the reason the share matters')

console.log('[smoke] === 5. formatting ===')
assert(fmtTokens(89_042_118) === '89.0M' && fmtTokens(284_981) === '285K' && fmtTokens(42) === '42', 'tokens read for magnitude')
assert(fmtTokens(-1) === '—' && fmtTokens(Number.NaN) === '—', 'a nonsense count is a dash, not "NaN"')
assert(fmtUsd(19.0423) === '$19.04' && fmtUsd(0.29) === '$0.290', 'dollars and sub-dollar amounts both readable')
assert(fmtUsd(0.0004) === '<$0.001', 'a sub-milli-dollar cost says so rather than rounding to $0.00')
assert(fmtUsd(0) === '$0.00', 'a true zero is still $0.00')
assert(BILLING_LABEL.subscription === 'plan' && BILLING_LABEL.metered === 'metered', 'badges are short and distinct')

console.log('[smoke] === 6. degenerate payloads ===')
assert(parseUsage(null).models.length === 0, 'null payload → empty report')
assert(parseUsage('nope' as unknown).totals.costUsd === 0, 'string payload → empty totals')
assert(parseUsage({ models: 'no' }).models.length === 0, 'wrong-typed models → empty, not a crash')
assert(parseUsage({ models: [null, 3, { model: 'ok', billing: 'metered', cost_usd: 1 }] }).models.length === 1, 'junk rows are dropped, good ones kept')
assert(parseUsage({ models: [{ model: 'x', billing: 'nonsense' }] }).models[0].billing === 'unknown', 'an unrecognised billing mode degrades to unknown, never to a money-bearing one')
assert(EMPTY_USAGE.models.length === 0 && EMPTY_USAGE.totals.costUsd === 0, 'the empty sentinel is empty')

console.log('[smoke] === 7. windows ===')
// "this month" was the original question; an all-time total answers a different one.
assert(usagePath(30) === '/api/usage?days=30', `a window becomes a query param (${usagePath(30)})`)
assert(usagePath(7) === '/api/usage?days=7', 'and so does a shorter one')
assert(usagePath(null) === '/api/usage', 'ALL TIME sends no parameter — not days=0, which the daemon would clamp to 1')
assert(usagePath(0) === '/api/usage' && usagePath(-5) === '/api/usage', 'a nonsense window degrades to all-time rather than to a 1-day window')
assert(usagePath(30.7) === '/api/usage?days=30', 'a fractional window is floored, never sent as a decimal')
assert(USAGE_WINDOWS.length === 3 && USAGE_WINDOWS.some((w) => w.days === null), 'three windows, one of them all-time')
assert(DEFAULT_USAGE_WINDOW === '30', 'the default answers the question that was actually asked')
assert(USAGE_WINDOWS.some((w) => w.id === DEFAULT_USAGE_WINDOW), 'and the default is a window that exists')
assert(USAGE_WINDOWS.every((w) => isAllowedDaemonPath(usagePath(w.days))), 'every window path stays inside the daemon bridge allowlist')

// A window LONGER than the data would imply history that does not exist.
const recent = new Date(Date.now() - 3 * 86_400_000).toISOString()
assert(
  /accounting only starts/.test(windowNote({ id: '30', label: '30 days', days: 30 }, recent)),
  'a 30-day window over 3 days of data SAYS the accounting is younger than the window'
)
assert(
  !/accounting only starts/.test(windowNote({ id: '7', label: '7 days', days: 7 }, '2026-06-12T21:14:27Z')),
  'a window well inside the data does not hedge'
)
assert(windowNote({ id: 'all', label: 'All time', days: null }, '2026-06-12T21:14:27Z').includes('2026-06-12'), 'all-time names the date accounting began')
assert(windowNote({ id: 'all', label: 'All time', days: null }, null) === 'All time', 'with no tracking date it just says all time')

console.log('[smoke] === 8. the tab is registered ===')
const tab = CONFIG_TABS.find((t) => t.id === 'usage')
assert(tab !== undefined, 'usage is a Config tab')
assert(tab?.path === '/api/usage', `pointed at the right endpoint (${tab?.path})`)
assert(CONFIG_TABS.filter((t) => t.id === 'usage').length === 1, 'registered exactly once')

console.log('')
console.log('[smoke] ===================== RESULT =====================')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (null-is-not-zero, coverage headline, modes, formatting, tab)`)
console.log('[smoke] ===================================================')
process.exit(failures === 0 ? 0 : 1)
