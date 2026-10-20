// One small request to a computer that is not trusted yet (joining a Prometheus, docs/PAIRING-APPROVAL-API.md).
//
// The same rules as discovery's `fetchSmall`, for a request that may carry a body:
//   * no redirect is followed (a redirect is somewhere else, and nobody asked to go there);
//   * no cookie is kept and no ORIGIN header is sent (Node's fetch adds neither): the routes refuse a request that carries
//     one, because they are for apps and never for a web page, which is also why this runs in the main process and never in
//     the page;
//   * at most MAX_REPLY_BYTES of the answer is read, and a wait ends after `timeoutMs`;
//   * what is returned is data: a status, the JSON if it parses, and the Retry-After header. Never a thrown error.
export const MAX_REPLY_BYTES = 16_384
const DEFAULT_TIMEOUT_MS = 8_000

export interface HttpReply {
  status: number
  /** The body, parsed; null when it was empty or not JSON. */
  json: unknown
  retryAfter: string | null
}
/** A reply, or why there is none. 'wrong-key': a pinned connection (src/main/tls-pin.ts) met a server presenting another key, and
 *  nothing was sent to it. Only a pinned fetch gives it. */
export type HttpResult = HttpReply | 'unreachable' | 'too-big' | 'wrong-key'

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  url: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}
export type RequestFn = (req: HttpRequest) => Promise<HttpResult>

/** Whether a failed fetch failed because the server presented another key than the pinned one (anywhere in its causes). */
function wrongKey(e: unknown): boolean {
  for (let c: unknown = e, i = 0; c && i < 5; c = (c as { cause?: unknown }).cause, i++) if ((c as Error).name === 'PinMismatch') return true
  return false
}

/** The same rules over a given fetch: a pinned one (src/main/tls-pin.ts, pinnedFetch) for a computer joined over TLS. */
export function requestWith(fetchImpl: typeof fetch): RequestFn {
  return async (req) => {
    let res: Response
    try {
      res = await fetchImpl(req.url, {
        method: req.method,
        redirect: 'error',
        headers: { accept: 'application/json', ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}), ...req.headers },
        ...(req.body !== undefined ? { body: req.body } : {}),
        signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      })
    } catch (e) {
      return wrongKey(e) ? 'wrong-key' : 'unreachable'
    }
    const retryAfter = res.headers.get('retry-after')
    if (!res.body) return { status: res.status, json: null, retryAfter }
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_REPLY_BYTES) {
          await reader.cancel().catch(() => undefined)
          return 'too-big'
        }
        chunks.push(value)
      }
    } catch {
      return 'unreachable'
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks))
    let json: unknown = null
    if (text.length > 0) {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
    return { status: res.status, json, retryAfter }
  }
}

export const requestSmall: RequestFn = requestWith((input, init) => fetch(input, init))
