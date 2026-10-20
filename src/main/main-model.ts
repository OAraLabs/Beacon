// Config → Models → "Main model", the main-process half: GET/PUT /api/model and POST /api/model/check-key on the connected Prometheus
// with the credential Beacon holds for it (Prometheus #737), and the OpenRouter sign-in (the O9 one, src/main/openrouter.ts). What each
// answer means is @shared/main-model's.
//
// A key is checked before it can be saved, and the key saved is the one that was checked: a check that passes holds {company, key}
// here, in main; Save sends that, once, and forgets it. A key from the sign-in never reaches the page (the page gets the verdict), and
// a typed one is sent to main once and never returned. Restarting is the network setting's (NetworkSetting.restart): one restart,
// whichever section asked.
import {
  MAIN_MODEL_COPY,
  MODEL_CHECK_ROUTE,
  MODEL_ROUTE,
  putBody,
  readCheck,
  readModel,
  readSave,
  verdictLine,
  type CheckOutcome,
  type MainModelRead,
  type MainModelSave,
  type Refused
} from '@shared/main-model'
import type { HttpResult, RequestFn } from './pairing/http'
import type { OpenRouterSignIn } from './openrouter'

export interface MainModelDeps {
  /** The connected Prometheus's REST base, and the credential Beacon holds for it. */
  base: () => string | null
  token: () => string | null
  request: RequestFn
  newSignIn: () => Promise<Pick<OpenRouterSignIn, 'start' | 'cancel'>>
}

const UNREAD: Record<Exclude<HttpResult, { status: number }>, string> = {
  unreachable: 'Prometheus did not answer',
  'too-big': 'the answer was too big',
  'wrong-key': 'the computer presented another key than the one Beacon connected to, so Beacon sent it nothing'
}
const refused = (message: string, detail: string): Refused => ({ kind: 'refused', message, detail })

export class MainModelSetting {
  /** The key the last check accepted, and the company it was checked for. Used by one Save, then forgotten. */
  private held: { provider: string; key: string } | null = null
  private active: Pick<OpenRouterSignIn, 'start' | 'cancel'> | null = null
  constructor(private readonly deps: MainModelDeps) {}

  private link(): { base: string; token: string } | null {
    const base = this.deps.base()
    const token = this.deps.token()
    return base && token ? { base, token } : null
  }
  private ask(method: 'GET' | 'PUT' | 'POST', l: { base: string; token: string }, path: string, body?: unknown): Promise<HttpResult> {
    // The key check calls the company, and Prometheus's check waits up to ~20 s on a slow one.
    return this.deps.request({ method, url: `${l.base}${path}`, headers: { authorization: `Bearer ${l.token}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), timeoutMs: method === 'GET' ? 8_000 : 45_000 })
  }

  async read(): Promise<MainModelRead> {
    const l = this.link()
    if (!l) return { kind: 'hidden' }
    const r = await this.ask('GET', l, MODEL_ROUTE)
    if (typeof r === 'string') return { kind: 'unreadable', detail: UNREAD[r] }
    return readModel(r.status, r.json)
  }

  /** Does this key work for this company? A key that may be saved (ok, no credit, unreachable) is held for Save. A company whose keys
   *  Prometheus can't check is not asked: the key is held and saved as it is (Prometheus says so in a note). */
  async check(provider: string, key: string, checkable = true): Promise<CheckOutcome> {
    this.held = null
    const k = key.trim()
    if (!k) return refused(MAIN_MODEL_COPY.refused.invalid_key, 'empty key')
    if (!checkable) {
      this.held = { provider, key: k }
      return { kind: 'verdict', verdict: 'unchecked', line: verdictLine('unchecked', provider) }
    }
    const l = this.link()
    if (!l) return refused(MAIN_MODEL_COPY.refused.other, 'not connected')
    const r = await this.ask('POST', l, MODEL_CHECK_ROUTE, { provider, api_key: k })
    if (typeof r === 'string') return refused(MAIN_MODEL_COPY.refused.other, UNREAD[r])
    const out = readCheck(r.status, r.json, provider)
    if (out.kind === 'verdict' && out.verdict !== 'bad') this.held = { provider, key: k }
    return out
  }

  /** Sign in with OpenRouter (the O9 sign-in), then check the key it gave, here in main. */
  async signIn(): Promise<CheckOutcome> {
    this.held = null
    this.active?.cancel()
    const mine = await this.deps.newSignIn()
    this.active = mine
    const r = await mine.start()
    if (this.active === mine) this.active = null
    switch (r.kind) {
      case 'key':
        return this.check('openrouter', r.key)
      case 'declined':
        return refused(MAIN_MODEL_COPY.signInFailed.declined, 'OpenRouter called back without a code')
      case 'unreachable':
        return refused(MAIN_MODEL_COPY.signInFailed.unreachable, `sign-in: ${r.detail}`)
      case 'failed':
        return refused(MAIN_MODEL_COPY.signInFailed['not-finished'], `sign-in: ${r.detail}`)
      case 'timed-out':
        return refused(MAIN_MODEL_COPY.signInFailed['not-finished'], 'sign-in: no answer from the browser in time')
      case 'canceled':
        return refused(MAIN_MODEL_COPY.signInFailed['not-finished'], 'sign-in: stopped')
    }
  }
  cancelSignIn(): void {
    this.active?.cancel()
    this.active = null
  }

  /** Save: the company, a version (blank: its default), and either the key the last check held for this company (useNewKey) or none
   *  (Prometheus checks the key it already holds). Then the setting is read back with GET. */
  async save(provider: string, version: string, useNewKey: boolean): Promise<MainModelSave> {
    const l = this.link()
    if (!l) return refused(MAIN_MODEL_COPY.refused.other, 'not connected')
    let key: string | null = null
    if (useNewKey) {
      if (!this.held || this.held.provider !== provider) return refused(MAIN_MODEL_COPY.needsCheck, 'no checked key for this company')
      key = this.held.key
    }
    const r = await this.ask('PUT', l, MODEL_ROUTE, putBody(provider, version, key))
    if (typeof r === 'string') return refused(MAIN_MODEL_COPY.refused.other, UNREAD[r])
    const out = readSave(r.status, r.json, provider)
    if (out.kind === 'refused') return out
    this.held = null
    return { kind: 'saved', notes: out.notes, read: await this.read() }
  }
}
