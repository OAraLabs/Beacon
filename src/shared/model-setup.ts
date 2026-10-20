// How the assistant thinks (O9, docs/ONBOARDING-v0.4.0-O9.md §2, §5, §6): the pure half. The Prometheus shapes live here and
// only here, held to answers recorded from a real daemon (Prometheus #732: src/main/fixtures/model_setup_732.json).
//
// No Node/Electron imports (same rule as the rest of src/shared).

/** POST, master token: {provider, api_key} → 200 {result, status?, detail?} (Prometheus #732). */
export const CHECK_KEY_ROUTE = '/api/setup/check-key'
export const CONFIGURE_ROUTE = '/api/setup/configure'
export const COMPLETE_ROUTE = '/api/setup/complete'
export type CloudChoice = 'openrouter' | 'anthropic' | 'openai'
export type KeyCheck = 'ok' | 'bad_key' | 'no_credit' | 'unreachable'
const RESULTS: readonly string[] = ['ok', 'bad_key', 'no_credit', 'unreachable']

/** The key check's answer. Only a 200 naming exactly one of the four is read as that; anything else (another word, an error
 *  status, a refusal, no body) is "unreachable" with what came back kept for Copy details, and never "ok". `detail` is
 *  Prometheus's own sentence (it never relays a provider's words, which can echo the key) and the provider's status. */
export function readKeyCheck(status: number, body: unknown): { result: KeyCheck; detail: string } {
  const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  if (status === 200 && b && typeof b.result === 'string' && RESULTS.includes(b.result)) {
    const said = typeof b.detail === 'string' ? b.detail.slice(0, 300) : ''
    const provider = typeof b.status === 'number' ? ` (the company answered ${b.status})` : ''
    return { result: b.result as KeyCheck, detail: `key check: ${b.result}${said ? `: ${said}` : ''}${provider}` }
  }
  const error = b && typeof b.error === 'string' ? ` ${b.error.slice(0, 80)}` : ''
  return { result: 'unreachable', detail: `key check: HTTP ${status}${error}${status === 200 ? ' with an answer Beacon does not understand' : ''}` }
}

/** The body of POST /api/setup/configure for a cloud choice and its key: no base_url (refused for a cloud provider) and no model
 *  (the daemon's default: anthropic/claude-sonnet-5 for OpenRouter, recorded). */
export function configureBody(choice: CloudChoice, key: string): Record<string, string> {
  return { provider: choice, api_key: key }
}

const PREFIX: Record<'anthropic' | 'openai', string> = { anthropic: 'sk-ant-', openai: 'sk-' }
/** A pasted key that has the company's shape (trimmed): Anthropic's start sk-ant-, OpenAI's sk- and are not Anthropic's, and a
 *  prefix alone is not a key. */
export function pastedKeyLooksRight(company: 'anthropic' | 'openai', key: string): boolean {
  const k = key.trim()
  if (!/^[\x21-\x7e]{8,512}$/.test(k)) return false
  if (company === 'anthropic') return k.startsWith(PREFIX.anthropic) && k.length > PREFIX.anthropic.length
  return k.startsWith(PREFIX.openai) && !k.startsWith(PREFIX.anthropic) && k.length > PREFIX.openai.length
}
export function keyPrefix(company: 'anthropic' | 'openai'): string {
  return PREFIX[company]
}

/** b.settings key: what the kept credential is, for a connection Beacon set up on this Mac: 'master' from A-inst's pairing with a
 *  setup-mode daemon, 'owner' once the trade is done (or when A-inst paired with a daemon that was already configured). Any other
 *  way of keeping a credential clears it. */
export const CREDENTIAL_KIND_KEY = 'onboarding:credential'
export type CredentialKind = 'master' | 'owner'
/** A relaunch part-way through: Prometheus on this Mac, no longer in setup mode (configured, or not answering yet), whose credential
 *  is still the master token resumes at the owner trade, instead of opening the app with the master key. In setup mode it resumes at
 *  A2, as before. */
export function resumeAtTrade(i: { credential: string | null; setupMode: boolean; thisMac: boolean }): boolean {
  return i.credential === 'master' && !i.setupMode && i.thisMac
}

/** What the page sees of the finish (A5): which row is running, and why it stopped. No key and no credential, ever. */
export interface ModelSetupView {
  phase: 'idle' | 'running' | 'done' | 'failed'
  step: 'check' | 'save' | 'start' | 'owner'
  failure?: { kind: 'no_credit' | 'bad_key' | 'unreachable' | 'not-started' | 'trade'; details: string }
}

/** What a step that takes a key (the OpenRouter sign-in, a pasted key) tells the page: on, or which card, with Copy details. */
export type KeyCard = 'no_credit' | 'bad_key' | 'unreachable' | 'shape' | 'not-finished' | 'declined'
export type KeyStep = { ok: true } | { ok: false; card: KeyCard; details: string }
/** A key check's verdict as a step. */
export function keyStepFrom(v: { result: KeyCheck; detail: string }): KeyStep {
  return v.result === 'ok' ? { ok: true } : { ok: false, card: v.result, details: v.detail }
}
