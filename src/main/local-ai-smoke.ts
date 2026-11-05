/**
 * An AI the person already runs (docs/ONBOARDING-LOCAL-FIRST.md), headless under ELECTRON_RUN_AS_NODE. Written before the code
 * (§7.1): red against the stubs in @shared/local-ai, the A2 machine events and ModelSetup.finishLocal.
 *
 * Pins:
 *   1. a typed computer is checked before any call (§4.1's forms; userinfo, paths, queries and other schemes refused);
 *   2. the look and probe answers (§4.1), read from src/main/fixtures/local_probe_assumed.json: ASSUMED SHAPES until the recording
 *      of §7.3 replaces them. Only usable AIs are rows; an unknown reason, a contradiction or a non-200 is never a row; the page
 *      is sent no address;
 *   3. the cards (§3): one per reason, in plain words, filled with the names they need;
 *   4. what A2 selects by itself (§2.4), and its tags;
 *   5. the configure body for a local choice, and what Prometheus says it can do (§5.3);
 *   6. the machine (§5.4): A2's Continue carries the choice; Choose again from A5;
 *   7. A2's strings (§5.5), exactly as decided on 2026-10-20;
 *   8. the finish with a local choice (§5.2), in a world of fakes: configure with no key and no key check, complete, then the trade;
 *      a configure refusal for a probe reason is local-gone, and nothing is kept.
 */
import wire from './fixtures/local_probe_assumed.json'
import banned from '@shared/onboarding-banned-words.json'
import {
  a2Tags,
  localCard,
  localConfigureBody,
  localFeatures,
  normalizeTarget,
  pageRows,
  pickInitial,
  readDetect,
  readProbe,
  type LocalCardId,
  type LocalRead,
  type LocalReason
} from '@shared/local-ai'
import { initialOnboardingState, onboardingReduce, type OnboardingEvent, type OnboardingState } from '@shared/onboarding'
import { COPY } from '@shared/onboarding-strings'
import { ModelSetup, type ModelSetupView } from './model-setup'
import type { HttpRequest, HttpResult } from './pairing/http'

const EXPECTED = 124
let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: unknown): void {
  checks++
  console.log(`[local-ai-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
  if (!cond) failures++
}
// The verdict is on 'exit', so an early return or a throw cannot skip the count guard.
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.log(`[local-ai-smoke] FAIL  ${checks} checks ran, expected ${EXPECTED}`)
    failures++
  }
  console.log(`[local-ai-smoke] ${failures === 0 ? 'PASS' : 'FAIL'} (${checks} checks, ${failures} failed)`)
  process.exitCode = failures === 0 ? 0 : 1
})

const WORDS: string[] = banned.words
const escape = (w: string): string => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const jargon = (text: string): string[] => WORDS.filter((w) => new RegExp(`\\b${escape(w)}\\b`, 'i').test(text))
type Answer = { status: number; json: unknown }
const W = wire as unknown as Record<string, Answer> & { probe_reasons: Record<string, Answer> }

// ── 1. a typed computer ──────────────────────────────────────────────────────────────────────────────────────────────────────
const accepted: [string, string][] = [
  ['my-computer', 'my-computer'],
  ['  my-computer.local  ', 'my-computer.local'],
  ['My-Computer.local', 'my-computer.local'],
  ['192.0.2.10', '192.0.2.10'],
  ['192.0.2.10:11434', '192.0.2.10:11434'],
  ['[fd00::20]', '[fd00::20]'],
  ['[fd00::20]:1234', '[fd00::20]:1234'],
  ['http://my-computer.local:1234', 'http://my-computer.local:1234'],
  ['https://gpu.example.com/', 'https://gpu.example.com']
]
for (const [input, want] of accepted) {
  const n = normalizeTarget(input)
  assert(n.ok && n.target === want, `a computer: ${JSON.stringify(input)} → ${want}`, n)
}
const refused = ['', '   ', 'studio mac', 'user:pass@my-computer', 'http://user@my-computer', 'my-computer/v1/models', 'my-computer?x=1', 'file:///etc/hosts', 'ftp://my-computer', 'my-computer:99999', 'my-computer:0', 'a'.repeat(254), 'studio\nmac', 'http://']
for (const input of refused) assert(!normalizeTarget(input).ok, `not a computer: ${JSON.stringify(input.length > 20 ? input.slice(0, 20) + '…' : input)}`)

// ── 2. the answers ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const found = readDetect(W.detect_found.status, W.detect_found.json)
assert(found.card === null && found.rows.length > 0, 'a look with usable AIs has rows and no card', found)
assert(
  JSON.stringify(found.rows.map((r) => [r.app, r.model, r.where])) === JSON.stringify([['ollama', 'gemma3:4b', null], ['ollama', 'qwen3:8b', null]]),
  'only usable AIs are rows (the embedding one and the short one are not), in the order the app listed them',
  found.rows
)
assert(found.rows.length > 0 && found.rows.every((r) => r.provider === 'ollama' && r.baseUrl === 'http://localhost:11434'), 'main keeps each row’s provider and address', found.rows)
assert(found.rows.length > 0 && new Set(found.rows.map((r) => r.id)).size === found.rows.length && found.rows.every((r) => r.id.length > 0), 'every row has its own id', found.rows)
assert(found.detail.includes('24,576') || found.detail.includes('24576'), 'Copy details carry Prometheus’s sentence', found.detail)
const page = pageRows(found.rows)
const pageText = JSON.stringify(page)
assert(page.length > 0 && !/https?:|localhost|:11434|:1234/.test(pageText), 'the page is sent no address, not even inside an id', pageText)
assert(page.length === 2 && page[0].app === 'Ollama' && page[0].where === 'this Mac' && page[1].model === 'qwen3:8b', 'the page gets the app’s name, the AI and where it is', page)
assert(page[1]?.loaded === true && page[0]?.loaded === false, 'and whether each is loaded', page)
assert(found.rows.length > 0 && !found.rows.some((r) => r.id.includes('localhost') || r.id.includes('http')), 'ids carry no address')

const nothing = readDetect(W.detect_nothing.status, W.detect_nothing.json)
assert(nothing.rows.length === 0 && nothing.card?.id === 'nothing-here', 'nothing answering on this Mac is "Nothing found on this Mac"', nothing)
const old = readDetect(W.detect_old.status, W.detect_old.json)
assert(old.rows.length === 0 && old.card?.id === 'old', 'a detect answer with no `local` is a Prometheus too old to look', old)
const failedLook = readDetect(503, null)
assert(failedLook.rows.length === 0 && failedLook.card?.id === 'look-failed', 'a look Prometheus did not answer is "We couldn’t look on this Mac"', failedLook)

const ok = readProbe(W.probe_ok.status, W.probe_ok.json, 'my-computer.local')
assert(ok.card === null && ok.rows.length === 1 && ok.rows[0].where === 'my-computer.local' && ok.rows[0].app === 'lm_studio', 'a passing Test is a row on the typed computer', ok)
assert(ok.rows[0]?.baseUrl === 'http://my-computer.local:1234' && ok.rows[0]?.provider === 'lm_studio', 'with the address Prometheus found, kept in main', ok.rows[0])
assert(pageRows(ok.rows)[0]?.where === 'my-computer.local', 'the page says where it is by the typed name', pageRows(ok.rows))
assert(found.rows.length > 0 && ok.rows.length > 0 && !found.rows.some((r) => ok.rows.some((t) => t.id === r.id)), 'a Test’s rows never share an id with the look’s', [found.rows.map((r) => r.id), ok.rows.map((r) => r.id)])

const REASONS: LocalReason[] = ['name_not_found', 'no_answer', 'refused', 'not_ai', 'needs_key', 'no_models', 'no_chat', 'none_loaded', 'short_context']
for (const reason of REASONS) {
  const a = W.probe_reasons[reason]
  const r = readProbe(a.status, a.json, 'my-computer.local')
  assert(r.rows.length === 0 && r.card?.id === reason, `probe reason ${reason} → its card, and no row`, r)
}
const short: LocalRead = readProbe(W.probe_reasons.short_context.status, W.probe_reasons.short_context.json, 'my-computer.local')
assert(short.card?.app === 'LM Studio' && short.card?.model === 'gemma-3-12b' && short.card?.min === 24576, 'the short-window card knows the app, the AI and the floor Prometheus set', short.card)
const unknown = readProbe(W.probe_unknown_reason.status, W.probe_unknown_reason.json, 'my-computer.local')
assert(unknown.rows.length === 0 && unknown.card?.id === 'unknown', 'a reason Beacon does not know is "couldn’t check", never found', unknown)
const contradiction = readProbe(W.probe_contradiction.status, W.probe_contradiction.json, 'my-computer.local')
assert(contradiction.rows.length === 0 && contradiction.card?.id === 'unknown', '`usable` that is not exactly true is not a row', contradiction)
const badTarget = readProbe(W.probe_bad_target.status, W.probe_bad_target.json, 'my-computer.local')
assert(badTarget.rows.length === 0 && badTarget.card?.id === 'bad_target', 'Prometheus refusing the target is the "doesn’t look like a name" card', badTarget)
for (const [status, body] of [[500, { error: 'boom' }], [200, null], [200, 'text'], [200, { found: 'no' }], [401, { error: 'unauthorized' }]] as [number, unknown][]) {
  const r = readProbe(status, body, 'my-computer.local')
  assert(r.rows.length === 0 && r.card?.id === 'unknown', `HTTP ${status} ${JSON.stringify(body)} is "couldn’t check"`, r)
}

// ── 3. the cards ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const CARDS: LocalCardId[] = [...REASONS, 'bad_target', 'nothing-here', 'unknown', 'old', 'look-failed']
for (const id of CARDS) {
  const c = localCard({ id, app: 'LM Studio', model: 'gemma-3-12b', min: 24576 }, 'my-computer.local')
  const text = `${c.title} ${c.body}`
  assert(c.title.length > 0 && jargon(text).length === 0 && !/\{\w+\}/.test(text), `card ${id}: said, in plain words, every blank filled`, { text, jargon: jargon(text) })
}
const named = localCard({ id: 'name_not_found' }, 'my-computer.local')
assert(named.title.includes('my-computer.local') || named.body.includes('my-computer.local'), 'a card about a computer names it', named)
const shortCard = localCard({ id: 'short_context', app: 'LM Studio', model: 'gemma-3-12b', min: 24576 }, 'my-computer.local')
assert(`${shortCard.title} ${shortCard.body}`.includes('24576') && shortCard.body.includes('LM Studio') && `${shortCard.title}`.includes('gemma-3-12b'), 'the short-window card says the AI, the app and the number to set', shortCard)
const refusedHere = localCard({ id: 'refused' }, null)
const refusedThere = localCard({ id: 'refused' }, 'my-computer.local')
assert(refusedHere.title !== refusedThere.title && !`${refusedHere.title} ${refusedHere.body}`.includes('open to other computers'), 'refused on this Mac is "nothing found", not "not open to other computers"', [refusedHere, refusedThere])
assert(refusedThere.body.includes('Serve on Local Network'), 'refused elsewhere says what to turn on in LM Studio', refusedThere)
const noAnswerHere = localCard({ id: 'no_answer' }, null).title
assert(noAnswerHere.length > 0 && !noAnswerHere.includes("this Mac didn't answer"), 'this Mac never "didn’t answer"', noAnswerHere)

// ── 4. what A2 selects by itself ─────────────────────────────────────────────────────────────────────────────────────────────
const rows = pageRows(found.rows)
assert(JSON.stringify(pickInitial({ looking: true, rows: [], touched: null })) === JSON.stringify({ card: null, row: null }), 'nothing is selected while looking')
const picked = pickInitial({ looking: false, rows, touched: null })
assert(picked.card === 'local' && picked.row === rows.find((r) => r.loaded === true)?.id, 'found: the local card, on the loaded row', picked)
assert(pickInitial({ looking: false, rows: rows.map((r) => ({ ...r, loaded: null })), touched: null }).row === rows[0]?.id, 'nothing known to be loaded: the first row')
assert(JSON.stringify(pickInitial({ looking: false, rows: [], touched: null })) === JSON.stringify({ card: 'cloud', row: null }), 'nothing found: the cloud card')
const mine = { card: 'cloud' as const, row: null }
assert(JSON.stringify(pickInitial({ looking: false, rows, touched: mine })) === JSON.stringify(mine), 'a choice the person made is never changed, even when the look finds something')
const mineRow = { card: 'local' as const, row: rows[0]?.id ?? 'x' }
assert(JSON.stringify(pickInitial({ looking: false, rows, touched: mineRow })) === JSON.stringify(mineRow), 'nor a row they picked')
assert(JSON.stringify(a2Tags({ looking: true, rows: [], testPassed: false })) === JSON.stringify({ ready: false, quickest: false }), 'no tag while looking')
assert(JSON.stringify(a2Tags({ looking: false, rows, testPassed: false })) === JSON.stringify({ ready: true, quickest: false }), 'found: Ready, and cloud is not Quickest')
assert(JSON.stringify(a2Tags({ looking: false, rows: [], testPassed: false })) === JSON.stringify({ ready: false, quickest: true }), 'nothing found: cloud is Quickest')
assert(JSON.stringify(a2Tags({ looking: false, rows: pageRows(ok.rows), testPassed: true })) === JSON.stringify({ ready: true, quickest: false }), 'a Test that passed: Ready, and cloud is not Quickest')

// ── 5. configure, and what Prometheus can do ─────────────────────────────────────────────────────────────────────────────────
const body = localConfigureBody({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3:8b' })
assert(JSON.stringify(body) === JSON.stringify({ provider: 'ollama', base_url: 'http://localhost:11434', model: 'qwen3:8b' }), 'configure: provider, address and AI, and nothing else (no key)', body)
assert(JSON.stringify(localFeatures(W.status_both.status, W.status_both.json)) === JSON.stringify({ probe: true, switch: true }), 'features: both')
assert(JSON.stringify(localFeatures(W.status_probe_only.status, W.status_probe_only.json)) === JSON.stringify({ probe: true, switch: false }), 'features: can look, cannot switch later')
assert(JSON.stringify(localFeatures(W.status_old.status, W.status_old.json)) === JSON.stringify({ probe: false, switch: false }), 'no features: neither')
assert(JSON.stringify(localFeatures(200, { features: 'local_probe,model_local' })) === JSON.stringify({ probe: false, switch: false }), 'features that are not a list: neither')
assert(JSON.stringify(localFeatures(401, { features: ['local_probe', 'model_local'] })) === JSON.stringify({ probe: false, switch: false }), 'a refused status: neither')

// ── 6. the machine ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const atA2 = initialOnboardingState('resumeModel')
const go = (s: OnboardingState, ...es: OnboardingEvent[]): OnboardingState => es.reduce(onboardingReduce, s)
assert(atA2.screen === 'A2', 'resumed at A2')
const local = go(atA2, { type: 'continue', choice: 'local' })
assert(local.screen === 'A5' && local.history.length === 0, 'Continue with a local choice: straight to A5, nothing behind it', local)
assert(go(atA2, { type: 'continue', choice: 'cloud' }).screen === 'A3c-1', 'Continue with cloud: A3c-1, as before')
assert(go(atA2, { type: 'continue' }).screen === 'A2', 'Continue with no choice does nothing on A2')
const again = go(local, { type: 'chooseAgain' })
assert(again.screen === 'A2' && JSON.stringify(again.history) === JSON.stringify(atA2.history), 'Choose again: A5 back to A2, with A2’s own Back', again)
assert(go(again, { type: 'back' }).screen === 'W2', 'and Back from there is the question, as before')
assert(go(atA2, { type: 'chooseAgain' }).screen === 'A2' && go(local, { type: 'setUp' }, { type: 'chooseAgain' }).screen === 'F1', 'Choose again only from A5')
assert(go(atA2, { type: 'continue', choice: 'cloud' }, { type: 'continue', choice: 'local' }).screen === 'A3c-or', 'a choice on another screen does not reroute it')

// ── 7. A2's strings ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const a2 = COPY.main.a2 as unknown as Record<string, unknown>
const at = (path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), a2)
const WANT: [string, string][] = [
  ['title', 'How should your assistant think?'],
  ['local.title', 'Use an AI you already run'],
  ['local.detail', 'Free. Your conversations go to your own AI, not a company.'],
  ['cloud.title', 'Quick start with a cloud AI'],
  ['cloud.detail', 'Ready in about a minute, with the largest AIs. Your messages go to the company you pick, and they charge for use.'],
  ['cloud.switch', 'You can switch to local any time.'],
  ['download.title', 'Download an AI to this Mac'],
  ['download.detail', 'Coming soon.'],
  ['tags.ready', 'Ready'],
  ['tags.quickest', 'Quickest']
]
for (const [path, want] of WANT) assert(at(path) === want, `a2.${path} is "${want}"`, at(path))
assert(at('private') === undefined, '"Privately on this Mac" is gone')
const strings: string[] = []
const walk = (v: unknown): void => {
  if (typeof v === 'string') strings.push(v)
  else if (v && typeof v === 'object') Object.values(v).forEach(walk)
}
walk(a2)
assert(strings.length >= 20 && strings.every((s) => jargon(s).length === 0), `every A2 string is plain (${strings.length})`, strings.filter((s) => jargon(s).length > 0))

// ── 8. the finish with a local choice ────────────────────────────────────────────────────────────────────────────────────────
const PORT = 55111
const MASTER = 'MASTER-local-ai-smoke'
interface World {
  log: string[]
  views: ModelSetupView[]
  saved: number
  setup: ModelSetup
}
function world(configure: Answer): World {
  const w: World = { log: [], views: [], saved: 0 } as unknown as World
  let state: 'setup' | 'configured' = 'setup'
  const request = async (r: HttpRequest): Promise<HttpResult> => {
    const path = new URL(r.url).pathname
    const bearer = (r.headers?.authorization ?? '').replace(/^Bearer /, '')
    w.log.push(`${r.method} ${path} ${bearer === MASTER ? 'master' : 'none'}${r.body ? ` ${r.body}` : ''}`)
    if (path === '/api/setup/status') return state === 'setup' ? { status: 200, json: W.status_both.json, retryAfter: null } : { status: 401, json: null, retryAfter: null }
    if (path === '/api/setup/configure') return { status: configure.status, json: configure.json, retryAfter: null }
    if (path === '/api/setup/complete') {
      state = 'configured'
      return { status: 200, json: { restarting: true }, retryAfter: null }
    }
    // The trade is O9's (smoke:model-setup pins it); here the configured daemon never comes up, so it stops at "start".
    return { status: 404, json: null, retryAfter: null }
  }
  w.setup = new ModelSetup({
    port: PORT,
    masterToken: () => MASTER,
    request,
    exec: async () => ({ exit: 2, stdout: '', stderr: 'not in this world' }),
    launcher: '/nonexistent',
    secretPath: '/nonexistent',
    now: (() => {
      let t = 0
      return () => (t += 30_000)
    })(),
    sleep: async () => undefined,
    save: () => {
      w.saved++
    },
    activate: () => undefined,
    publish: (v) => w.views.push(v)
  })
  return w
}

async function main(): Promise<void> {
  const row = { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3:8b' }
  const good = world({ status: 200, json: { configured: true, provider: 'ollama', base_url: 'http://localhost:11434', model: 'qwen3:8b' } })
  const v = await good.setup.finishLocal(row)
  const conf = good.log.find((l) => l.startsWith('POST /api/setup/configure'))
  assert(conf === `POST /api/setup/configure master ${JSON.stringify(localConfigureBody(row))}`, 'configure is sent with the master token and the local body', conf ?? good.log)
  assert(conf !== undefined && !/api_key/.test(conf), 'with no key in it', conf)
  assert(conf !== undefined && !good.log.some((l) => l.includes('/api/setup/check-key')), 'no key check for a local choice', good.log)
  const ci = good.log.findIndex((l) => l.startsWith('POST /api/setup/configure'))
  const di = good.log.findIndex((l) => l.startsWith('POST /api/setup/complete'))
  assert(ci >= 0 && di > ci, 'then complete', good.log)
  assert(good.log.some((l, i) => i > di && l.startsWith('GET /api/status')), 'then the trade begins: it waits for the configured daemon', good.log)
  assert(v.phase === 'failed' && v.step === 'start' && v.failure?.kind === 'not-started', 'in this world the daemon never comes up: "Prometheus didn’t start", as in O9', v)
  assert(good.views.some((x) => x.step === 'save' && x.phase === 'running'), 'the page saw "Saving your choices"', good.views)

  const gone = world(W.configure_gone)
  const g = await gone.setup.finishLocal(row)
  assert(g.phase === 'failed' && g.step === 'save' && g.failure?.kind === 'local-gone', 'configure refusing for a probe reason is local-gone, at "Saving your choices"', g)
  assert(g.failure?.details.includes('none_loaded') === true, 'and Copy details carry the reason', g.failure)
  assert(gone.log.some((l) => l.startsWith('POST /api/setup/configure')) && !gone.log.some((l) => l.startsWith('POST /api/setup/complete')) && gone.saved === 0, 'nothing after it: no complete, nothing kept', gone.log)
  const other = world({ status: 400, json: { error: 'bad_request', fields: ['model'] } })
  const o = await other.setup.finishLocal(row)
  assert(other.log.some((l) => l.startsWith('POST /api/setup/configure')) && o.phase === 'failed' && o.failure?.kind === 'not-started', 'any other configure refusal is "Prometheus didn’t start", not local-gone', o)
  assert(good.views.length > 0 && [...good.views, ...gone.views].every((x) => !JSON.stringify(x).includes(MASTER)), 'no view the page is sent carries the master token', good.views)
}

main().catch((err) => {
  assert(false, 'the smoke threw', String(err?.stack ?? err))
})
