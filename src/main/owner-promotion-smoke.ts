/**
 * Owner promotion smoke (headless / ELECTRON_RUN_AS_NODE): Settings → "Make this Beacon an owner" (Prometheus #748).
 *
 * A Beacon on another computer connected with the API token can't approve a worker's request (Prometheus #744: 401 not_a_person).
 * `oara pair --owner`, run on the computer Prometheus runs on, prints a one-time code; this Beacon trades it (POST /api/pair/owner)
 * for an owner device token of its own, keeps that in place of the API token, and reconnects with it.
 *
 *   * the readers in @shared/owner-promotion, against what a REAL Prometheus answered (src/main/fixtures/owner_promotion_748.json):
 *     only a 200 that says owner: true and carries a token is a promotion; every refusal is said in plain words;
 *   * OwnerPromotion in main, against a stubbed request: a code that is not 8 digits is never sent; the token goes to `keep` and
 *     never back to the page; a refusal or a failed keep leaves the old credential where it was.
 */
import fixture from './fixtures/owner_promotion_748.json'
import banned from '@shared/onboarding-banned-words.json'
import { OWNER_ROUTE, OWNER_SETTINGS_COPY, normaliseOwnerCode, readRedeem } from '@shared/owner-promotion'
import { OwnerPromotion } from './owner-promotion'
import type { HttpResult, RequestFn } from './pairing/http'

const EXPECTED = 23
let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: unknown): void {
  checks++
  console.log(`[owner-promotion-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
  if (!cond) failures++
}
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.log(`[owner-promotion-smoke] FAIL  ${checks} checks ran, expected ${EXPECTED}`)
    failures++
  }
  console.log(`[owner-promotion-smoke] ${failures === 0 ? 'PASS' : 'FAIL'} (${checks} checks, ${failures} failed)`)
  process.exitCode = failures === 0 ? 0 : 1
})

const F = fixture as unknown as { redeem: Record<string, { status: number; json: unknown }> }
const C = OWNER_SETTINGS_COPY

async function main(): Promise<void> {
  // ── the code as typed ──────────────────────────────────────────────────────────────────────────────────────────────
  assert(normaliseOwnerCode('1234-5678') === '12345678' && normaliseOwnerCode(' 1234 5678 ') === '12345678' && normaliseOwnerCode('12345678') === '12345678', 'a code: the eight digits, with the hyphen and spaces it was shown with ignored')
  assert([ '1234-567', '123456789', 'abcd-efgh', '', '１２３４５６７８', '1234_5678'].every((x) => normaliseOwnerCode(x) === null), 'anything else is not a code (full-width digits included, as Prometheus refuses them)')

  // ── POST /api/pair/owner's answers ─────────────────────────────────────────────────────────────────────────────────
  const ok = readRedeem(F.redeem.ok.status, F.redeem.ok.json)
  assert(ok.kind === 'owner' && ok.token === '<token>' && ok.name === 'Probe MacBook', 'the real 200: an owner token, and the name Prometheus listed it under', ok)
  const wrong = readRedeem(F.redeem.wrong.status, F.redeem.wrong.json)
  assert(wrong.kind === 'refused' && wrong.message === C.wrongCode && wrong.detail.includes('invalid_code'), 'a wrong code (401 invalid_code): plain words, the code in the details', wrong)
  assert((readRedeem(F.redeem.again.status, F.redeem.again.json) as { message: string }).message === C.wrongCode, 'a used code is the same answer (Prometheus makes every failure one answer)')
  for (const k of ['code_as_number', 'no_name', 'not_json', 'from_a_browser']) {
    const r = readRedeem(F.redeem[k].status, F.redeem[k].json)
    assert(r.kind === 'refused' && r.message === C.failed, `Beacon's own mistake (${k}): "${C.failed}", the answer in the details`, r)
  }
  assert((readRedeem(403, { error: 'pairing_unavailable' }) as { message: string }).message === C.noKeys, 'a Prometheus with keys turned off: there is no owner to become')
  assert((readRedeem(404, null) as { message: string }).message === C.old && (readRedeem(405, null) as { message: string }).message === C.old, 'a Prometheus without the route: update it')
  const notOwner = readRedeem(200, { ...(F.redeem.ok.json as object), owner: false })
  const noToken = readRedeem(200, { ...(F.redeem.ok.json as object), token: '' })
  assert(notOwner.kind === 'refused' && noToken.kind === 'refused', 'a 200 that is not owner: true, or carries no token, is never kept as an owner credential', { notOwner, noToken })

  // ── plain words ────────────────────────────────────────────────────────────────────────────────────────────────────
  const words = Object.entries(C).filter(([k]) => k !== 'command').map(([, v]) => v)
  const hits = words.filter((t) => banned.words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t)))
  assert(words.length >= 10 && hits.length === 0, `the section's words keep to the plain-language list, all but the command it names (${words.length})`, hits)
  assert(C.command === 'oara pair --owner' && C.body.includes('{command}'), 'it names the command Prometheus prints the code with')

  // ── OwnerPromotion ─────────────────────────────────────────────────────────────────────────────────────────────────
  const TOKEN = 'owner-token-SMOKE-' + 'x'.repeat(30)
  const sent: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = []
  let answer: () => HttpResult = () => 'unreachable'
  const request: RequestFn = async (o) => {
    sent.push({ method: o.method, url: o.url, headers: o.headers ?? {}, body: o.body ? JSON.parse(String(o.body)) : undefined })
    return answer()
  }
  const kept: string[] = []
  let keepThrows = false
  const promo = new OwnerPromotion({
    base: () => 'http://p',
    request,
    deviceName: async () => 'Probe MacBook',
    platform: 'macos',
    keep: (t) => {
      if (keepThrows) throw new Error('keychain says no')
      kept.push(t)
    }
  })
  const reset = (): void => {
    sent.length = 0
    kept.length = 0
  }

  reset()
  const badShape = await promo.redeem('1234')
  assert(badShape.kind === 'refused' && badShape.message === C.shape && sent.length === 0, 'a code that is not 8 digits: said so, and nothing is sent', { badShape, sent })

  reset()
  answer = () => ({ status: 200, json: { ...(F.redeem.ok.json as object), token: TOKEN }, retryAfter: null })
  const done = await promo.redeem('1234 5678')
  assert(sent.length === 1 && sent[0].method === 'POST' && sent[0].url === `http://p${OWNER_ROUTE}` && JSON.stringify(sent[0].body) === JSON.stringify({ code: '12345678', device_name: 'Probe MacBook', platform: 'macos' }), 'the code goes to POST /api/pair/owner, normalised, with this computer\'s name and platform', sent)
  assert(!('authorization' in sent[0].headers) && !('Authorization' in sent[0].headers), 'and no credential with it (the route is public; the API token is not sent where it is not needed)', sent[0].headers)
  assert(done.kind === 'owner' && JSON.stringify(kept) === JSON.stringify([TOKEN]), 'a promotion: the owner token is kept (in place of the API token)', { done, kept })
  assert(!JSON.stringify(done).includes(TOKEN), 'and what goes back to the page carries no token', done)

  reset()
  answer = () => ({ status: 401, json: F.redeem.wrong.json, retryAfter: null })
  const no = await promo.redeem('0000-0000')
  assert(no.kind === 'refused' && no.message === C.wrongCode && kept.length === 0, 'a wrong code: nothing is kept', { no, kept })

  reset()
  keepThrows = true
  answer = () => ({ status: 200, json: { ...(F.redeem.ok.json as object), token: TOKEN }, retryAfter: null })
  const unkept = await promo.redeem('1234-5678')
  keepThrows = false
  assert(unkept.kind === 'refused' && unkept.message === C.notKept && !JSON.stringify(unkept).includes(TOKEN), 'the token could not be kept: said so (the old credential stays), and still no token to the page', unkept)

  reset()
  answer = () => 'wrong-key'
  const pin = await promo.redeem('1234-5678')
  assert(pin.kind === 'refused' && pin.message === C.wrongComputer && kept.length === 0, 'a pinned computer that answered with another key: refused, nothing sent to it, nothing kept', pin)

  const offline = new OwnerPromotion({ base: () => null, request, deviceName: async () => 'x', platform: 'macos', keep: () => kept.push('!') })
  reset()
  const off = await offline.redeem('1234-5678')
  assert(off.kind === 'refused' && off.message === C.notConnected && sent.length === 0 && kept.length === 0, 'not connected: said so, nothing sent')
}

main().catch((e) => {
  console.error('[owner-promotion-smoke] threw:', e)
  failures++
})
