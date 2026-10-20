/**
 * Signing in with OpenRouter (O9) — headless, under ELECTRON_RUN_AS_NODE. Written before the code (docs/ONBOARDING-v0.4.0-O9.md
 * §4, §7), from OpenRouter's documentation (openrouter.ai/docs/guides/overview/auth/oauth, read 2026-10-10) and RFC 7636.
 *
 * Pins: the S256 challenge (RFC 7636's own vector), the verifier's shape, the authorization URL's exact parameters with a
 * localhost callback, what a request to the callback means (a code for THIS sign-in, a refusal, or not ours), the exchange's
 * answers, the release-build gate on the stub override, and one whole sign-in against a loopback listener and a fake exchange:
 * the browser is opened once, a request with the wrong state is ignored, the right one ends it, the exchange carries the
 * verifier, and the listener is gone afterwards. The key never leaves main (it is not in the page's updates: smoke:model-setup).
 */
import { request as httpRequest } from 'node:http'
import { AUTHORIZE_PATH, CALLBACK_PATH, EXCHANGE_PATH, OPENROUTER_BASE, authorizeUrl, openrouterEnv, readCallback, readExchange } from '@shared/openrouter'
import { OpenRouterSignIn, codeChallenge, newState, newVerifier, type SignInResult } from './openrouter'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[openrouter-signin-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 17
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.error(`[openrouter-signin-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`[openrouter-signin-smoke] FAIL — ${failures}/${checks} checks failed`)
    process.exitCode = 1
  } else console.log(`[openrouter-signin-smoke] OK — ${checks} checks passed`)
})

// ── PKCE ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
assert(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk') === 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', 'pkce: the S256 challenge is RFC 7636 Appendix B\'s, to the character (base64url, no padding)', codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))
const verifiers = Array.from({ length: 200 }, () => newVerifier())
const states = Array.from({ length: 200 }, () => newState())
assert(verifiers.every((v) => /^[A-Za-z0-9_-]{43}$/.test(v)) && new Set(verifiers).size === 200 && states.every((v) => /^[A-Za-z0-9_-]{43}$/.test(v)) && new Set(states).size === 200 && !states.some((s) => verifiers.includes(s)), 'pkce: verifiers and states are 43 base64url characters (32 random bytes) and never repeat', verifiers[0])

// ── the authorization URL ─────────────────────────────────────────────────────────────────────────────────────────────────
const u = new URL(authorizeUrl({ base: OPENROUTER_BASE, port: 51423, challenge: 'CH', state: 'ST', label: 'Prometheus on Alex’s Mac' }) || 'http://x/')
const params = Object.fromEntries(u.searchParams.entries())
assert(u.origin === 'https://openrouter.ai' && u.pathname === AUTHORIZE_PATH && JSON.stringify(Object.keys(params).sort()) === JSON.stringify(['callback_url', 'code_challenge', 'code_challenge_method', 'key_label', 'state']), 'authorize: https://openrouter.ai/auth with exactly callback_url, code_challenge, code_challenge_method, state and key_label', u.toString())
assert(params.callback_url === `http://localhost:51423${CALLBACK_PATH}` && params.code_challenge === 'CH' && params.code_challenge_method === 'S256' && params.state === 'ST' && params.key_label === 'Prometheus on Alex’s Mac', 'authorize: a localhost callback on the listener\'s port, the S256 challenge, the state and the key\'s label', JSON.stringify(params))
const stub = new URL(authorizeUrl({ base: 'http://127.0.0.1:5999/or', port: 1, challenge: 'C', state: 'S', label: 'L' }) || 'http://x/')
assert(stub.origin === 'http://127.0.0.1:5999' && stub.pathname === `/or${AUTHORIZE_PATH}`, 'authorize: a probe\'s base is used as given (its path kept)', stub.toString())

// ── the callback ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const cb = (q: string): ReturnType<typeof readCallback> => readCallback(`${CALLBACK_PATH}${q}`, 'S')
assert(JSON.stringify(cb('?code=abc&state=S')) === JSON.stringify({ kind: 'code', code: 'abc' }) && JSON.stringify(cb('?state=S&code=abc&extra=1')) === JSON.stringify({ kind: 'code', code: 'abc' }), 'callback: a code with this sign-in\'s state is the code (extra parameters ignored)')
assert(cb('?error=access_denied').kind === 'declined' && cb('').kind === 'declined' && cb('?state=S').kind === 'declined', 'callback: no code is the person declining (OpenRouter sends no state then)')
assert(cb('?code=abc&state=OTHER').kind === 'not-ours' && cb('?code=abc').kind === 'not-ours' && readCallback('/elsewhere?code=abc&state=S', 'S').kind === 'not-ours' && cb('?code=&state=S').kind !== 'code', 'callback: a code with another state, with none, on another path, or empty is not this sign-in\'s')

// ── the exchange ──────────────────────────────────────────────────────────────────────────────────────────────────────────
assert(JSON.stringify(readExchange(200, { key: 'sk-or-v1-abc123' })) === JSON.stringify({ kind: 'key', key: 'sk-or-v1-abc123' }), 'exchange: 200 with a key is the key')
assert(['', 'x\ny', 'a'.repeat(513)].every((k) => readExchange(200, { key: k }).kind === 'failed') && readExchange(200, {}).kind === 'failed' && readExchange(200, null).kind === 'failed', 'exchange: an empty, multi-line or oversized key, or none, is not a key')
assert(readExchange(403, { error: 'Authorization code expired' }).kind === 'failed' && readExchange(400, null).kind === 'failed' && readExchange(405, null).kind === 'failed' && readExchange(null, null).kind === 'unreachable', 'exchange: 400, 403 (expired or bad code) and 405 end the sign-in ("start again"); no answer is "we couldn\'t reach OpenRouter"')

// ── the gate ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const rel = openrouterEnv({ BEACON_OPENROUTER_BASE: 'http://127.0.0.1:5999/or' }, false)
const dev = openrouterEnv({ BEACON_OPENROUTER_BASE: 'http://127.0.0.1:5999/or' }, true)
const away = openrouterEnv({ BEACON_OPENROUTER_BASE: 'https://evil.example/or' }, true)
assert(rel.base === OPENROUTER_BASE && !rel.overridden && dev.base === 'http://127.0.0.1:5999/or' && dev.overridden && away.base === OPENROUTER_BASE && !away.overridden, 'gate: a release build always signs in at openrouter.ai; a dev or probe build may use a stub on this Mac, and nothing else')

// ── one whole sign-in ─────────────────────────────────────────────────────────────────────────────────────────────────────
function hit(port: number, path: string): Promise<{ status: number; body: string; csp: string } | 'refused'> {
  return new Promise((res) => {
    const r = httpRequest({ host: '127.0.0.1', port, path, timeout: 2000 }, (x) => {
      let b = ''
      x.on('data', (c) => (b += c))
      x.on('end', () => res({ status: x.statusCode ?? 0, body: b, csp: String(x.headers['content-security-policy'] ?? '') }))
    })
    r.on('error', () => res('refused'))
    r.on('timeout', () => r.destroy())
    r.end()
  })
}
const within = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))])

async function whole(): Promise<void> {
  const opened: string[] = []
  const exchanges: { url: string; body: unknown; redirect: string | undefined; cookie: boolean }[] = []
  const signIn = new OpenRouterSignIn({
    base: OPENROUTER_BASE,
    openExternal: async (url) => {
      opened.push(url)
    },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      exchanges.push({ url: String(url), body: JSON.parse(String(init?.body ?? 'null')), redirect: init?.redirect, cookie: !!(init?.headers && JSON.stringify(init.headers).toLowerCase().includes('cookie')) })
      return new Response(JSON.stringify({ key: 'sk-or-v1-from-exchange' }), { status: 200 })
    }) as typeof fetch,
    waitMs: 10_000,
    label: 'Prometheus on this Mac'
  })
  const done = signIn.start()
  const deadline = Date.now() + 3000
  while (opened.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  const auth = opened[0] ? new URL(opened[0]) : null
  const port = auth ? Number(new URL(auth.searchParams.get('callback_url') ?? 'http://x').port) : 0
  const state = auth?.searchParams.get('state') ?? ''
  const challenge = auth?.searchParams.get('code_challenge') ?? ''
  assert(opened.length === 1 && port > 0 && port === signIn.port && /^[A-Za-z0-9_-]{43}$/.test(state), 'sign-in: the browser is opened once, at a URL whose callback is the listener Beacon is running', opened[0] ?? 'nothing opened')
  const other = port ? await hit(port, '/favicon.ico') : 'refused'
  const wrong = port ? await hit(port, `${CALLBACK_PATH}?code=nope&state=not-the-state`) : 'refused'
  const stillWaiting = (await within(done.then(() => 'ended'), 200, 'waiting')) === 'waiting'
  assert(typeof other === 'object' && other.status === 404 && typeof wrong === 'object' && stillWaiting, 'sign-in: another path is a 404, and a callback with another state is ignored: the sign-in keeps waiting', JSON.stringify({ other, wrong, stillWaiting }))
  const right = port ? await hit(port, `${CALLBACK_PATH}?code=the-code&state=${state}`) : 'refused'
  const result = await within<SignInResult | 'hung'>(done, 3000, 'hung')
  const ex = exchanges[0]
  const body = (ex?.body ?? {}) as Record<string, string>
  assert(typeof result === 'object' && result.kind === 'key' && result.key === 'sk-or-v1-from-exchange' && exchanges.length === 1 && ex.url === `${OPENROUTER_BASE}${EXCHANGE_PATH}` && body.code === 'the-code' && body.code_challenge_method === 'S256' && codeChallenge(body.code_verifier ?? '') === challenge && ex.redirect === 'error' && !ex.cookie, 'sign-in: the right callback ends it; the exchange posts the code with the verifier whose challenge the browser carried, follows no redirect, and answers the key', JSON.stringify({ result, ex }))
  assert(typeof right === 'object' && right.status === 200 && /close this tab/i.test(right.body) && !/<script/i.test(right.body) && /default-src 'none'/.test(right.csp) && (port ? await hit(port, CALLBACK_PATH) : 'refused') === 'refused' && signIn.port === null, 'sign-in: the browser is told it can close the tab (no script, nothing loaded), and the listener is gone afterwards', JSON.stringify(right))

  const cancelSignIn = new OpenRouterSignIn({ base: OPENROUTER_BASE, openExternal: async () => undefined, fetch: (async () => new Response('{}')) as typeof fetch, waitMs: 10_000, label: 'x' })
  const pending = cancelSignIn.start()
  await new Promise((r) => setTimeout(r, 100))
  const p2 = cancelSignIn.port
  cancelSignIn.cancel()
  const r2 = await within<SignInResult | 'hung'>(pending, 2000, 'hung')
  assert(p2 !== null && typeof r2 === 'object' && r2.kind === 'canceled' && (await hit(p2, CALLBACK_PATH)) === 'refused', 'sign-in: Back cancels it, and the listener is closed', JSON.stringify({ p2, r2 }))
}

whole()
  .catch((e) => assert(false, 'the smoke ran to the end', String((e as Error)?.stack ?? e)))
  // A listener left open must not keep the smoke alive: exit with the verdict (the exit handler prints it).
  .finally(() => setTimeout(() => process.exit(failures > 0 || checks !== EXPECTED ? 1 : 0), 50))
