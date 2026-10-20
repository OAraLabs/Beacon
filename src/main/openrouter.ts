// Signing in with OpenRouter (O9, docs/ONBOARDING-v0.4.0-O9.md §4): the main-process half. A callback listener on this Mac's
// loopback only, the browser at OpenRouter's authorization page, and the code-for-key exchange. The verifier, the state and
// the key live in this object and nowhere else; the key goes to the caller (ModelSetup), never to the page, never to disk.
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { EXCHANGE_PATH, authorizeUrl, readCallback, readExchange, type ExchangeOutcome } from '@shared/openrouter'

/** base64url(SHA-256(verifier)), RFC 7636 S256. */
export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}
/** 32 random bytes, base64url without padding (43 characters). */
export function newVerifier(): string {
  return randomBytes(32).toString('base64url')
}
export function newState(): string {
  return randomBytes(32).toString('base64url')
}

export interface SignInDeps {
  base: string
  openExternal: (url: string) => Promise<void>
  fetch: typeof fetch
  waitMs: number
  label: string
}
export type SignInResult = ExchangeOutcome | { kind: 'declined' } | { kind: 'timed-out' } | { kind: 'canceled' }

const MAX_EXCHANGE_BYTES = 16_384
const EXCHANGE_TIMEOUT_MS = 10_000
const PAGE = (line: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Beacon</title><body style="font:16px -apple-system,system-ui,sans-serif;margin:3em;color:#222"><p>${line}</p></body>`

/** One sign-in: a loopback callback listener, the browser, the exchange. One at a time per object. */
export class OpenRouterSignIn {
  private servers: Server[] = []
  private listening: number | null = null
  private settle: ((r: SignInResult) => void) | null = null

  constructor(private readonly deps: SignInDeps) {}

  /** The callback listener's port while a sign-in waits (null otherwise). */
  get port(): number | null {
    return this.listening
  }

  start(): Promise<SignInResult> {
    this.cancel()
    const verifier = newVerifier()
    const state = newState()
    return new Promise<SignInResult>((resolve) => {
      let done = false
      const finish = (r: SignInResult): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.settle = null
        this.close()
        resolve(r)
      }
      this.settle = finish
      const timer = setTimeout(() => finish({ kind: 'timed-out' }), this.deps.waitMs)
      const answer = (res: import('node:http').ServerResponse, status: number, line: string): void => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'", 'cache-control': 'no-store', connection: 'close' })
        res.end(PAGE(line))
      }
      const onRequest = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
        if (done || req.method !== 'GET') return answer(res, 404, 'Not found.')
        const seen = readCallback(req.url ?? '', state)
        if (seen.kind === 'not-ours') return answer(res, 404, 'Not found.')
        if (seen.kind === 'declined') {
          answer(res, 200, "OpenRouter wasn't connected. You can close this tab and go back to Beacon.")
          return finish({ kind: 'declined' })
        }
        answer(res, 200, 'Signed in. You can close this tab and go back to Beacon.')
        // The listener has done its one job: close it before the exchange, so nothing else can arrive on it.
        this.close()
        void this.exchange(seen.code, verifier).then(finish)
      }
      const main = createServer(onRequest)
      main.on('error', () => finish({ kind: 'unreachable', detail: 'Beacon could not listen for OpenRouter on this Mac' }))
      main.listen(0, '127.0.0.1', () => {
        const port = (main.address() as import('node:net').AddressInfo).port
        this.servers.push(main)
        this.listening = port
        // `localhost` may resolve to ::1 first in the browser: listen there too, on the same port, when this Mac has it.
        const six = createServer(onRequest)
        six.on('error', () => undefined)
        six.listen(port, '::1', () => this.servers.push(six))
        const url = authorizeUrl({ base: this.deps.base, port, challenge: codeChallenge(verifier), state, label: this.deps.label })
        this.deps.openExternal(url).catch(() => finish({ kind: 'unreachable', detail: 'Beacon could not open the browser' }))
      })
    })
  }

  /** Back: stop waiting, and close the listener. */
  cancel(): void {
    const s = this.settle
    if (s) s({ kind: 'canceled' })
    else this.close()
  }

  private close(): void {
    for (const s of this.servers) {
      s.closeAllConnections()
      s.close()
    }
    this.servers = []
    this.listening = null
  }

  private async exchange(code: string, verifier: string): Promise<ExchangeOutcome> {
    let res: Response
    try {
      res = await this.deps.fetch(`${this.deps.base.replace(/\/+$/, '')}${EXCHANGE_PATH}`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)
      })
    } catch {
      return readExchange(null, null)
    }
    let text = ''
    try {
      const reader = res.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        if (!reader) break
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_EXCHANGE_BYTES) {
          await reader.cancel().catch(() => undefined)
          return { kind: 'failed', detail: 'OpenRouter answered with too much' }
        }
        chunks.push(value)
      }
      text = new TextDecoder().decode(Buffer.concat(chunks))
    } catch {
      return readExchange(null, null)
    }
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    return readExchange(res.status, json)
  }
}

