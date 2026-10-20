// Config → Models → "Main model": which AI the connected Prometheus thinks with, and changing it (Prometheus #737: GET/PUT /api/model,
// POST /api/model/check-key). What each answer means is decided here, against answers recorded from a real daemon
// (src/main/fixtures/main_model_737.json); src/main/main-model.ts only asks.
//
// Like the network setting (#700): the operator's only (an approved device gets 403 operator_only, and there is no section), a PUT
// SAVES and the change applies when Prometheus restarts (it builds its AI connection at start), so a saved change offers [Restart
// now]. The view always comes from GET.
//
// Plain words: Prometheus's own messages say "daemon" and "provider", so every code Beacon knows is said in Beacon's words, and an
// unknown one falls back to Prometheus's message (never nothing). Companies are named, not their ids ("Anthropic (Claude)").
//
// No Node/Electron imports (same rule as the rest of src/shared).

export const MODEL_ROUTE = '/api/model'
export const MODEL_CHECK_ROUTE = '/api/model/check-key'

export const MAIN_MODEL_COPY = {
  title: 'Main model',
  intro: 'Which AI your assistant thinks with. A change takes effect when Prometheus restarts.',
  now: 'Now: {choice}',
  next: 'After a restart: {choice}',
  keySaved: 'A key for {company} is saved on the computer running Prometheus.',
  noKey: 'No key for {company} is saved yet.',
  ownHardware: 'your own hardware',
  change: 'Change',
  cancel: 'Cancel',
  pick: 'Who runs it',
  chipKey: 'key saved',
  chipNoKey: 'no key',
  version: 'Version',
  versionHint: 'Leave blank for {default}.',
  signIn: 'Sign in with OpenRouter',
  signInBody: "We'll open OpenRouter in your browser. Sign in, or create an account, then choose Authorize.",
  waiting: 'Waiting for you to finish in the browser…',
  stop: 'Stop',
  orPaste: 'Or paste a key',
  keyLabel: 'Your {company} key',
  keepSaved: 'Leave the key empty to keep the one that is saved.',
  check: 'Check key',
  checking: 'Checking…',
  verdict: {
    ok: 'This key works.',
    bad: "{company} didn't accept this key. Make a new key and paste it here.",
    'no-credit': "This key works, but the account has no credit. Your assistant can't answer until you add some.",
    unreachable: "Beacon couldn't reach {company} to check this key. You can still save it.",
    unchecked: "Beacon can't check {company} keys, so it will be saved as it is."
  },
  signInFailed: {
    declined: "OpenRouter wasn't connected. Try again, or paste a key.",
    'not-finished': "The sign-in didn't finish. Try again.",
    unreachable: "Beacon couldn't reach OpenRouter. Check your internet connection, then try again."
  },
  save: 'Save',
  saving: 'Saving…',
  needsCheck: 'Check the key before saving it.',
  needsKey: 'Add a key for {company} first.',
  saved: 'Saved. Restart Prometheus to start using it.',
  notes: {
    key_no_credit: "The key works, but the account has no credit. Your assistant can't answer until you add some.",
    key_unchecked: 'The key was saved without being checked.',
    model_overridden: 'Part of this is set where Prometheus starts, and that wins over what is saved here.'
  },
  refused: {
    model_overridden: "This is set where Prometheus starts, so it can't be changed here.",
    no_config_file: "Prometheus wasn't started from a settings file, so this can't be saved here.",
    bad_model: "Prometheus didn't accept that version name. Use letters, numbers and . _ : / @ + - only.",
    unsupported_provider: "Prometheus can't switch to that from here.",
    invalid_key: "That doesn't look like a key. Copy the whole key and paste it again.",
    persist_failed: "Prometheus couldn't save this. Nothing changed.",
    other: "Beacon couldn't change this."
  },
  cantChange: "This can't be changed from here.",
  old: 'Update Prometheus to change this from Beacon.',
  unreadable: "Beacon couldn't read this from Prometheus.",
  tryAgain: 'Try again',
  copyDetails: 'Copy details',
  copied: 'Copied'
} as const

const COMPANY: Record<string, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (ChatGPT)',
  openrouter: 'OpenRouter',
  gemini: 'Google (Gemini)',
  xai: 'xAI (Grok)',
  deepseek: 'DeepSeek',
  kimi: 'Moonshot (Kimi)',
  glm: 'Z.ai (GLM)',
  mimo: 'Xiaomi (MiMo)',
  qwen: 'Alibaba (Qwen)'
}
/** The company's name for an id Prometheus sends; an id Beacon has no name for is shown as it is. */
export const companyName = (id: string): string => (Object.hasOwn(COMPANY, id) ? COMPANY[id] : id)
const fill = (s: string, vars: Record<string, string>): string => s.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m)

export interface ModelChoice {
  id: string
  label: string
  defaultVersion: string
  keySaved: boolean
  /** Prometheus can ask the company whether a key works (POST /api/model/check-key). */
  checkable: boolean
  /** The row offers Sign in with OpenRouter (the O9 sign-in) beside a pasted key. */
  signIn: boolean
}
export interface MainModelView {
  now: string
  /** What comes back after a restart, when a saved change differs from what runs; else null. */
  next: string | null
  restartNeeded: boolean
  /** Whether a key is saved for what is saved ('' when it runs on the owner's own hardware). */
  keyLine: string
  canChange: boolean
  why: string | null
  notes: string[]
  choices: ModelChoice[]
  saved: { provider: string; model: string }
}
export type MainModelRead = { kind: 'shown'; view: MainModelView } | { kind: 'hidden' } | { kind: 'old' } | { kind: 'unreadable'; detail: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
interface Side {
  provider: string
  model: string
  kind: 'cloud' | 'local'
}
const side = (v: unknown): Side | null =>
  isObj(v) && typeof v.provider === 'string' && typeof v.model === 'string' && (v.kind === 'cloud' || v.kind === 'local') ? { provider: v.provider, model: v.model, kind: v.kind } : null
const describe = (s: Side, defaults: Record<string, string>): string => {
  const who = s.kind === 'local' ? MAIN_MODEL_COPY.ownHardware : companyName(s.provider)
  const version = s.model || defaults[s.provider] || ''
  return version ? `${who} · ${version}` : who
}
const notice = (v: unknown): { code: string; message: string } | null => (isObj(v) && typeof v.code === 'string' && typeof v.message === 'string' ? { code: v.code, message: v.message } : null)
/** A warning in Beacon's words; restart_required is said by the restart line, so it adds none. */
function noteFor(n: { code: string; message: string }): string | null {
  if (n.code === 'restart_required') return null
  const words: Record<string, string> = MAIN_MODEL_COPY.notes
  return Object.hasOwn(words, n.code) ? words[n.code] : n.message.trim() || n.code
}

/** GET /api/model's answer. */
export function readModel(status: number, body: unknown): MainModelRead {
  if (status === 403 && isObj(body) && body.error === 'operator_only') return { kind: 'hidden' }
  // A Prometheus older than #737: its page catch-all owns the path (405) or nothing does (404).
  if (status === 404 || status === 405) return { kind: 'old' }
  if (status !== 200) return { kind: 'unreadable', detail: `HTTP ${status}` }
  if (!isObj(body)) return { kind: 'unreadable', detail: 'not a JSON object' }
  const running = side(body.running)
  const saved = side(body.saved)
  const warnings = Array.isArray(body.warnings) ? body.warnings.map(notice) : null
  const providers = Array.isArray(body.providers) ? body.providers : null
  const key = body.key === null ? null : isObj(body.key) && typeof body.key.present === 'boolean' ? { present: body.key.present } : undefined
  const ok =
    running !== null &&
    saved !== null &&
    typeof body.pending === 'boolean' &&
    (body.applied === 'live' || body.applied === 'on_restart') &&
    key !== undefined &&
    warnings !== null &&
    warnings.every((w) => w !== null) &&
    providers !== null &&
    providers.every((p) => isObj(p) && typeof p.provider === 'string' && typeof p.default_model === 'string' && typeof p.key_present === 'boolean' && typeof p.checkable === 'boolean') &&
    typeof body.can_change === 'boolean'
  if (!ok || !running || !saved) return { kind: 'unreadable', detail: 'an answer Beacon does not understand' }
  const rows = providers as { provider: string; default_model: string; key_present: boolean; checkable: boolean }[]
  const defaults = Object.fromEntries(rows.map((p) => [p.provider, p.default_model]))
  const restartNeeded = body.pending === true
  const differs = saved.provider !== running.provider || saved.model !== running.model || saved.kind !== running.kind
  const canChange = body.can_change as boolean
  const company = companyName(saved.provider)
  return {
    kind: 'shown',
    view: {
      now: fill(MAIN_MODEL_COPY.now, { choice: describe(running, defaults) }),
      next: restartNeeded && differs ? fill(MAIN_MODEL_COPY.next, { choice: describe(saved, defaults) }) : null,
      restartNeeded,
      keyLine: saved.kind === 'local' || key === null ? '' : fill(key.present ? MAIN_MODEL_COPY.keySaved : MAIN_MODEL_COPY.noKey, { company }),
      canChange,
      why: canChange ? null : MAIN_MODEL_COPY.cantChange,
      notes: (warnings as { code: string; message: string }[]).map(noteFor).filter((n): n is string => !!n),
      choices: rows.map((p) => ({ id: p.provider, label: companyName(p.provider), defaultVersion: p.default_model, keySaved: p.key_present, checkable: p.checkable, signIn: p.provider === 'openrouter' })),
      saved: { provider: saved.provider, model: saved.model }
    }
  }
}

export type KeyVerdict = 'ok' | 'bad' | 'no-credit' | 'unreachable' | 'unchecked'
export type Refused = { kind: 'refused'; message: string; detail: string }
export type CheckOutcome = { kind: 'verdict'; verdict: KeyVerdict; line: string } | Refused
const RESULT: Record<string, KeyVerdict> = { ok: 'ok', bad_key: 'bad', no_credit: 'no-credit', unreachable: 'unreachable' }
export const verdictLine = (verdict: KeyVerdict, provider: string): string => fill(MAIN_MODEL_COPY.verdict[verdict], { company: companyName(provider) })
const details = (status: number, body: unknown): string => `HTTP ${status}${body === null || body === undefined ? '' : ` ${JSON.stringify(body).slice(0, 400)}`}`

/** A refusal (check-key's or PUT's) in Beacon's words; the code and Prometheus's own words go to the details. */
function refusal(status: number, body: unknown, provider: string): Refused {
  const error = isObj(body) && typeof body.error === 'string' ? body.error : ''
  const words: Record<string, string> = MAIN_MODEL_COPY.refused
  let message: string
  if (error === 'key_rejected') message = verdictLine('bad', provider)
  else if (error === 'cloud_key_missing') message = fill(MAIN_MODEL_COPY.needsKey, { company: companyName(provider) })
  else message = Object.hasOwn(words, error) && error !== 'other' ? words[error] : MAIN_MODEL_COPY.refused.other
  return { kind: 'refused', message, detail: details(status, body) }
}

/** POST /api/model/check-key's answer: the verdict (Prometheus's check classifies the company's answer), or a refusal. */
export function readCheck(status: number, body: unknown, provider: string): CheckOutcome {
  if (status === 200 && isObj(body) && typeof body.result === 'string' && Object.hasOwn(RESULT, body.result)) {
    const verdict = RESULT[body.result]
    return { kind: 'verdict', verdict, line: verdictLine(verdict, provider) }
  }
  return refusal(status, body, provider)
}

export type SaveOutcome = { kind: 'saved'; notes: string[] } | Refused
/** PUT /api/model's answer: saved (with what to say about the key), or a refusal. What it means for the section is read back with GET. */
export function readSave(status: number, body: unknown, provider: string): SaveOutcome {
  if (status === 200 && isObj(body)) {
    const warnings = Array.isArray(body.warnings) ? body.warnings.map(notice).filter((n): n is { code: string; message: string } => n !== null) : []
    return { kind: 'saved', notes: warnings.map(noteFor).filter((n): n is string => !!n) }
  }
  return refusal(status, body, provider)
}

/** The PUT body. A blank version is left out (Prometheus picks the company's default), a key only when one is being saved, and
 *  Prometheus always checks the key first (a refused one is 400 key_rejected and nothing is written). There is never a base_url. */
export function putBody(provider: string, version: string, apiKey: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = { provider, check: true }
  const v = version.trim()
  if (v) out.model = v
  if (apiKey !== null) out.api_key = apiKey
  return out
}

export type MainModelSave = { kind: 'saved'; read: MainModelRead; notes: string[] } | Refused
