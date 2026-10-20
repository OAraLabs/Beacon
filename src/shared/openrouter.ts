// Signing in with OpenRouter (O9, docs/ONBOARDING-v0.4.0-O9.md §4): the pure half. From OpenRouter's documentation
// (openrouter.ai/docs/guides/overview/auth/oauth, read 2026-10-10) and RFC 7636.
//
// No Node/Electron imports (same rule as the rest of src/shared).

export const OPENROUTER_BASE = 'https://openrouter.ai'
export const AUTHORIZE_PATH = '/auth'
export const EXCHANGE_PATH = '/api/v1/auth/keys'
export const CALLBACK_PATH = '/openrouter/callback'
export const CREDITS_URL = 'https://openrouter.ai/settings/credits'
/** How long Beacon waits for the browser (account creation and buying credit happen there). */
export const SIGN_IN_WAIT_MS = 30 * 60_000
/** At most this many characters of a key, and printable ones only: anything else is not a key. */
const MAX_KEY = 512

export interface AuthorizeInput {
  base: string
  port: number
  challenge: string
  state: string
  label: string
}
/** The URL the browser is sent to: the authorization page, with a localhost callback on the listener's port, the S256 challenge,
 *  this sign-in's state, and the name the key gets on the person's OpenRouter account. Nothing else. */
export function authorizeUrl(i: AuthorizeInput): string {
  const u = new URL(`${i.base.replace(/\/+$/, '')}${AUTHORIZE_PATH}`)
  u.searchParams.set('callback_url', `http://localhost:${i.port}${CALLBACK_PATH}`)
  u.searchParams.set('code_challenge', i.challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('state', i.state)
  u.searchParams.set('key_label', i.label)
  return u.toString()
}

/** Equal strings, compared without stopping at the first difference. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

export type CallbackOutcome = { kind: 'code'; code: string } | { kind: 'declined' } | { kind: 'not-ours' }
/** What a request to the callback listener means for the sign-in waiting on `expectedState`. A code counts only with this
 *  sign-in's state; no code at all is the person declining (OpenRouter sends no state then); anything else is not ours. */
export function readCallback(pathAndQuery: string, expectedState: string): CallbackOutcome {
  let u: URL
  try {
    u = new URL(pathAndQuery, 'http://localhost')
  } catch {
    return { kind: 'not-ours' }
  }
  if (u.pathname !== CALLBACK_PATH) return { kind: 'not-ours' }
  const code = u.searchParams.get('code')
  if (code === null) return { kind: 'declined' }
  const state = u.searchParams.get('state')
  if (!code || state === null || !expectedState || !sameText(state, expectedState)) return { kind: 'not-ours' }
  return { kind: 'code', code }
}

export type ExchangeOutcome = { kind: 'key'; key: string } | { kind: 'failed'; detail: string } | { kind: 'unreachable'; detail: string }
/** The answer of POST /api/v1/auth/keys (status null: no answer at all). 400, 403 (an expired or wrong code: codes last ten
 *  minutes and are single use) and 405 end the sign-in; only a 200 carrying one printable key of at most 512 characters is a key. */
export function readExchange(status: number | null, body: unknown): ExchangeOutcome {
  if (status === null) return { kind: 'unreachable', detail: 'no answer from OpenRouter' }
  if (status !== 200) return { kind: 'failed', detail: `OpenRouter answered ${status}` }
  const key = typeof body === 'object' && body !== null ? (body as { key?: unknown }).key : undefined
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY || !/^[\x21-\x7e]+$/.test(key)) return { kind: 'failed', detail: 'OpenRouter answered without a usable key' }
  return { kind: 'key', key }
}

/** BEACON_OPENROUTER_BASE (a loopback stub), honoured only when `allowed` (a dev or probe build), and only for this Mac. */
export function openrouterEnv(raw: Readonly<Record<string, string | undefined>>, allowed: boolean): { base: string; overridden: boolean } {
  const want = raw.BEACON_OPENROUTER_BASE
  if (!allowed || !want) return { base: OPENROUTER_BASE, overridden: false }
  let u: URL
  try {
    u = new URL(want)
  } catch {
    return { base: OPENROUTER_BASE, overridden: false }
  }
  const loopback = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
  return loopback ? { base: want.replace(/\/+$/, ''), overridden: true } : { base: OPENROUTER_BASE, overridden: false }
}
