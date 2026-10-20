/**
 * Main model smoke (headless / ELECTRON_RUN_AS_NODE): Config → Models → "Main model" (Prometheus #737, GET/PUT /api/model and
 * POST /api/model/check-key).
 *
 * Two halves:
 *   * the readers in @shared/main-model, against what a REAL Prometheus answered (src/main/fixtures/main_model_737.json, recorded
 *     by scripts/record-main-model-737.mjs from main 70a52f7): what the section says, when it offers [Restart now], which
 *     refusal says what, and that none of it is in jargon (Prometheus's own messages say "daemon"; Beacon words every code it
 *     knows itself);
 *   * MainModelSetting in main, against a stubbed request: a key is checked before it can be saved, the key that was checked is
 *     the one saved, a sign-in's key never reaches the page, and a key is bound to the company it was checked for.
 */
import fixture from './fixtures/main_model_737.json'
import banned from '@shared/onboarding-banned-words.json'
import { MAIN_MODEL_COPY, companyName, putBody, readCheck, readModel, readSave, type MainModelRead } from '@shared/main-model'
import { MainModelSetting } from './main-model'
import type { HttpResult, RequestFn } from './pairing/http'

const EXPECTED = 50
let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: unknown): void {
  checks++
  console.log(`[main-model-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
  if (!cond) failures++
}
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.log(`[main-model-smoke] FAIL  ${checks} checks ran, expected ${EXPECTED}`)
    failures++
  }
  console.log(`[main-model-smoke] ${failures === 0 ? 'PASS' : 'FAIL'} (${checks} checks, ${failures} failed)`)
  process.exitCode = failures === 0 ? 0 : 1
})

const WORDS: string[] = banned.words
const escape = (w: string): string => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const jargon = (text: string): string[] => WORDS.filter((w) => new RegExp(`\\b${escape(w)}\\b`, 'i').test(text))
const F = fixture as unknown as Record<string, { status: number; json: unknown }> & {
  check: Record<string, { status: number; json: unknown }>
  put: Record<string, { status: number; json: unknown }>
}
const shown = (r: MainModelRead) => (r.kind === 'shown' ? r.view : null)
/** Every string a read puts on screen. */
const words = (r: MainModelRead): string[] => {
  const v = shown(r)
  return v ? [v.now, v.next ?? '', v.keyLine, v.why ?? '', ...v.notes, ...v.choices.map((c) => c.label)] : []
}

async function main(): Promise<void> {
  // ── reading GET /api/model ─────────────────────────────────────────────────────────────────────────────────────────
  const conf = readModel(F.get_configured.status, F.get_configured.json)
  const v = shown(conf)
  assert(v !== null, 'GET as the owner: the section is shown', conf)
  assert(v?.now === 'Now: Anthropic (Claude) · claude-sonnet-5', 'it says what is running, in a company name and its version', v?.now)
  assert(v?.next === null && v?.restartNeeded === false, 'nothing waits for a restart', v)
  assert(v?.keyLine === 'A key for Anthropic (Claude) is saved on the computer running Prometheus.', 'it says a key is saved (never the key)', v?.keyLine)
  assert(v?.canChange === true && v?.why === null, 'the owner can change it', v)
  assert(v?.choices.length === 10 && v.choices.every((c) => c.label && c.id), `every company Prometheus offers is a row (${v?.choices.length})`, v?.choices)
  const or = v?.choices.find((c) => c.id === 'openrouter')
  assert(!!or && or.label === 'OpenRouter' && or.signIn && or.checkable && or.defaultVersion === 'anthropic/claude-sonnet-5', 'OpenRouter is a row with Sign in with OpenRouter', or)
  assert(v?.choices.filter((c) => c.signIn).length === 1, 'only OpenRouter offers a sign-in')
  const anth = v?.choices.find((c) => c.id === 'anthropic')
  assert(!!anth && anth.keySaved && !v?.choices.find((c) => c.id === 'openai')?.keySaved, "each row says whether its company's key is saved", v?.choices)
  assert(v?.saved.provider === 'anthropic' && v?.saved.model === 'claude-sonnet-5', 'the saved choice is carried for the editor', v?.saved)
  assert(readModel(F.get_as_device.status, F.get_as_device.json).kind === 'hidden', 'an approved device that is not the owner: no section (403 operator_only)')
  assert(readModel(404, { detail: 'Not Found' }).kind === 'old' && readModel(405, null).kind === 'old', 'a Prometheus without the route: "update Prometheus"')
  assert(readModel(200, { running: 'x' }).kind === 'unreadable' && readModel(500, null).kind === 'unreadable', 'an answer Beacon does not understand: unreadable, never a guess')

  const pend = shown(readModel(F.get_pending.status, F.get_pending.json))
  assert(pend?.now === 'Now: Anthropic (Claude) · claude-sonnet-5' && pend?.next === 'After a restart: OpenRouter · anthropic/claude-sonnet-5', 'a saved change: what runs now, and what comes back after a restart', pend)
  assert(pend?.restartNeeded === true, 'a saved change offers the restart')
  assert(pend?.notes.length === 0, "Prometheus's restart_required notice is said by the restart line, not repeated in its words", pend?.notes)
  const after = shown(readModel(F.get_after_restart.status, F.get_after_restart.json))
  assert(after?.now === 'Now: OpenRouter · anthropic/claude-sonnet-5' && after?.next === null && !after?.restartNeeded, 'after the restart: OpenRouter runs, nothing pending', after)
  const gem = shown(readModel(F.put.gemini_unchecked.status, F.put.gemini_unchecked.json))
  assert(gem?.next === 'After a restart: Google (Gemini) · gemini-2.5-flash' && gem.notes.includes(MAIN_MODEL_COPY.notes.key_unchecked), 'a change saved with an unchecked key says so', gem)
  const unknown = shown(readModel(200, { ...(F.get_configured.json as object), warnings: [{ code: 'something_new', message: 'A thing Beacon has no words for.' }] }))
  assert(!!unknown && unknown.notes.includes('A thing Beacon has no words for.'), "a warning code Beacon doesn't know: Prometheus's own message, never nothing", unknown?.notes)
  const local = shown(readModel(200, { ...(F.get_configured.json as object), running: { provider: 'llama_cpp', model: 'qwen3', api_key_env: null, kind: 'local' }, saved: { provider: 'llama_cpp', model: 'qwen3', api_key_env: null, kind: 'local' }, key: null }))
  assert(local?.now === 'Now: your own hardware · qwen3' && local.keyLine === '', 'running on your own hardware: said so, and no key line', local)
  const noFile = shown(readModel(200, { ...(F.get_configured.json as object), can_change: false }))
  assert(noFile?.canChange === false && noFile.why === MAIN_MODEL_COPY.cantChange, "can_change false: no editor, and why", noFile)

  // ── the key check and the save ─────────────────────────────────────────────────────────────────────────────────────
  const c = (k: string, company = 'anthropic') => readCheck(F.check[k].status, F.check[k].json, company)
  const ok = c('ok_openrouter', 'openrouter')
  assert(ok.kind === 'verdict' && ok.verdict === 'ok' && ok.line === MAIN_MODEL_COPY.verdict.ok, 'check: ok', ok)
  const bad = c('bad_anthropic')
  assert(bad.kind === 'verdict' && bad.verdict === 'bad' && bad.line === "Anthropic (Claude) didn't accept this key. Make a new key and paste it here.", 'check: a refused key says so, in the company\'s name', bad)
  const nc = c('no_credit_openrouter', 'openrouter')
  assert(nc.kind === 'verdict' && nc.verdict === 'no-credit', 'check: no credit', nc)
  const un = readCheck(200, { result: 'unreachable', detail: 'x' }, 'openai')
  assert(un.kind === 'verdict' && un.verdict === 'unreachable' && /OpenAI \(ChatGPT\)/.test(un.line), 'check: unreachable', un)
  const miss = c('missing_openai', 'openai')
  assert(miss.kind === 'refused' && miss.message === 'Add a key for OpenAI (ChatGPT) first.' && miss.detail.includes('cloud_key_missing'), 'check with no key: refused in plain words, the code in the details', miss)
  const s = (k: string, company = 'anthropic') => readSave(F.put[k].status, F.put[k].json, company)
  const rej = s('key_rejected')
  assert(rej.kind === 'refused' && rej.message === "Anthropic (Claude) didn't accept this key. Make a new key and paste it here.", 'save: key_rejected → the same words as the check', rej)
  assert(s('bad_model', 'openai').kind === 'refused' && (s('bad_model', 'openai') as { message: string }).message === MAIN_MODEL_COPY.refused.bad_model, 'save: bad_model')
  assert((s('unsupported') as { message: string }).message === MAIN_MODEL_COPY.refused.unsupported_provider, 'save: unsupported_provider')
  assert((readSave(409, { error: 'model_overridden', source: 'PROMETHEUS_PROVIDER' }, 'openai') as { message: string }).message === MAIN_MODEL_COPY.refused.model_overridden, 'save: model_overridden')
  assert((readSave(418, { error: 'teapot' }, 'openai') as { message: string }).message === MAIN_MODEL_COPY.refused.other, 'save: anything else → one plain line, the rest in the details')
  const noCredit = s('openrouter_no_credit', 'openrouter')
  assert(noCredit.kind === 'saved' && noCredit.notes.includes(MAIN_MODEL_COPY.notes.key_no_credit), 'save: no credit is saved, with the note', noCredit)
  assert(JSON.stringify(putBody('openai', '', null)) === '{"provider":"openai","check":true}' && JSON.stringify(putBody('openai', ' gpt-x ', 'K')) === '{"provider":"openai","check":true,"model":"gpt-x","api_key":"K"}', 'the PUT body: a blank version and no new key are left out; check is always asked; never base_url')

  // ── plain words ────────────────────────────────────────────────────────────────────────────────────────────────────
  const copy: string[] = []
  const walk = (o: unknown): void => {
    if (typeof o === 'string') copy.push(o)
    else if (o && typeof o === 'object') for (const [k, x] of Object.entries(o)) if (k !== 'title') walk(x)
  }
  walk(MAIN_MODEL_COPY)
  const copyHits = copy.filter((t) => jargon(t).length > 0)
  assert(copy.length >= 30 && copyHits.length === 0, `every string of the section but its title keeps to the plain-language list (${copy.length})`, copyHits)
  const said = [conf, readModel(F.get_pending.status, F.get_pending.json), readModel(F.put.gemini_unchecked.status, F.put.gemini_unchecked.json)].flatMap(words)
  const saidHits = said.filter((t) => jargon(t).length > 0)
  assert(saidHits.length === 0, 'and so is everything the section says over the real answers', saidHits)
  assert(companyName('openrouter') === 'OpenRouter' && companyName('something_new') === 'something_new', 'an id Beacon has no name for is shown as it is')

  // ── MainModelSetting ───────────────────────────────────────────────────────────────────────────────────────────────
  const KEY = 'sk-ant-api03-SMOKE' + 'k'.repeat(30)
  const SIGNED = 'sk-or-v1-SIGNED' + 's'.repeat(30)
  const sent: { method: string; url: string; body: unknown }[] = []
  let answers: ((method: string, url: string, body: unknown) => HttpResult)[] = []
  const request: RequestFn = async (o) => {
    const body = o.body ? JSON.parse(String(o.body)) : undefined
    sent.push({ method: o.method, url: o.url, body })
    const next = answers.shift()
    return next ? next(o.method, o.url, body) : 'unreachable'
  }
  const reply = (status: number, json: unknown) => (): HttpResult => ({ status, json, retryAfter: null })
  let signInResult: unknown = { kind: 'key', key: SIGNED }
  const setting = new MainModelSetting({
    base: () => 'http://p',
    token: () => 'T',
    request,
    newSignIn: async () => ({ start: async () => signInResult, cancel: () => undefined }) as never
  })
  const fresh = (): void => {
    sent.length = 0
    answers = []
  }

  fresh()
  const blocked = await setting.save('anthropic', '', true)
  assert(blocked.kind === 'refused' && blocked.message === MAIN_MODEL_COPY.needsCheck && sent.length === 0, 'save with a new key that was never checked: refused, nothing sent', { blocked, sent })

  fresh()
  answers = [reply(200, F.check.bad_anthropic.json)]
  const badCheck = await setting.check('anthropic', KEY)
  assert(badCheck.kind === 'verdict' && badCheck.verdict === 'bad' && sent[0]?.url === 'http://p/api/model/check-key' && (sent[0]?.body as { api_key?: string }).api_key === KEY, 'check: the typed key goes to check-key', sent)
  fresh()
  assert((await setting.save('anthropic', '', true)).kind === 'refused' && sent.length === 0, 'a key that failed its check cannot be saved')

  fresh()
  answers = [reply(200, F.check.held.json)]
  const good = await setting.check('anthropic', KEY)
  assert(good.kind === 'verdict' && good.verdict === 'ok' && !JSON.stringify(good).includes(KEY), 'check ok, and the answer to the page carries no key', good)
  fresh()
  assert((await setting.save('openai', '', true)).kind === 'refused' && sent.length === 0, "a key checked for Anthropic can't be saved as OpenAI's")
  fresh()
  answers = [reply(200, F.put.openrouter.json), reply(200, F.get_pending.json)]
  const saved = await setting.save('anthropic', ' claude-x ', true)
  const put = sent[0]
  assert(saved.kind === 'saved' && put?.method === 'PUT' && put.url === 'http://p/api/model' && JSON.stringify(put.body) === JSON.stringify({ provider: 'anthropic', check: true, model: 'claude-x', api_key: KEY }), 'save: PUT with the checked key, the version, and check on', sent)
  assert(sent[1]?.method === 'GET' && saved.kind === 'saved' && saved.read.kind === 'shown' && !JSON.stringify(saved).includes(KEY), 'then the setting is read back with GET; nothing returned holds the key', saved)
  fresh()
  assert((await setting.save('anthropic', '', true)).kind === 'refused' && sent.length === 0, 'the key is used once: after a save it is gone from main')

  fresh()
  answers = [reply(200, F.put.gemini_unchecked.json), reply(200, F.get_after_gemini.json)]
  const keep = await setting.save('anthropic', '', false)
  assert(keep.kind === 'saved' && JSON.stringify(sent[0]?.body) === '{"provider":"anthropic","check":true}', 'save without a new key: no api_key, Prometheus checks the key it holds', sent)

  fresh()
  const unchecked = await setting.check('gemini', 'AIza-SMOKE' + 'g'.repeat(30), false)
  assert(unchecked.kind === 'verdict' && unchecked.verdict === 'unchecked' && sent.length === 0, "a company whose keys can't be checked: nothing is asked, the key is held to save as it is", { unchecked, sent })

  fresh()
  answers = [reply(200, F.check.ok_openrouter.json)]
  const signed = await setting.signIn()
  assert(signed.kind === 'verdict' && signed.verdict === 'ok' && (sent[0]?.body as { provider?: string; api_key?: string }).api_key === SIGNED && !JSON.stringify(signed).includes(SIGNED), "sign-in: OpenRouter's key is checked in main and never returned to the page", { signed, sent })
  fresh()
  answers = [reply(200, F.put.openrouter.json), reply(200, F.get_pending.json)]
  await setting.save('openrouter', '', true)
  assert((sent[0]?.body as { api_key?: string; provider?: string }).api_key === SIGNED && (sent[0]?.body as { provider?: string }).provider === 'openrouter', 'and Save sends the signed-in key as OpenRouter\'s', sent)
  signInResult = { kind: 'declined' }
  fresh()
  const declined = await setting.signIn()
  assert(declined.kind === 'refused' && declined.message === MAIN_MODEL_COPY.signInFailed.declined && sent.length === 0, 'a declined sign-in: said so, nothing checked', declined)

  const offline = new MainModelSetting({ base: () => null, token: () => null, request, newSignIn: async () => ({}) as never })
  assert((await offline.read()).kind === 'hidden' && (await offline.save('openai', '', false)).kind === 'refused', 'not connected: no section, and nothing can be saved')
}

main().catch((e) => {
  console.error('[main-model-smoke] threw:', e)
  failures++
})
