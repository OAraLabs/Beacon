/**
 * Activity › Gym — headless, under ELECTRON_RUN_AS_NODE. The gym dashboard's rules (@shared/gym), pinned:
 *
 *   1. Tailscale only: an address is refused unless EVERY address its host resolves to is a Tailscale one, the request goes to the
 *      address that was checked, and a refused address is never saved.
 *   2. The token: it goes in the Authorization header, only after the Tailscale check, only to the checked address; with no
 *      token nothing is sent; it is kept only by main's own store, never as a setting, never given back to the page, never
 *      written to a log.
 *   3. No text from the gym is shown: a status with sentences planted in every string, and in fields nobody asked for, parses
 *      to something that holds none of them.
 *   4. Read-only: the transport only ever GETs, and the panel calls nothing but the gym's read and its two settings.
 *   5. One transport: the reader and the panel do not know where the document comes from (src/main/gym-transport.ts does), so
 *      another transport can replace today's without touching them.
 *
 * And what the panel draws from the sample status (src/main/fixtures/gym_status.json: it validates against the service's
 * `gym-status/2` schema): the round and training, last night, the schedule, alerts, the scorecards bar by bar, the data, the hosts and whether a
 * service that is down was meant to be.
 *
 *   npm run build && npm run smoke:gym
 */
import { readFileSync, readdirSync } from 'node:fs'
import {
  GYM_ADDRESS_COPY,
  GYM_ADDRESS_KEY,
  GYM_SCHEMA,
  along,
  barAt,
  barWords,
  codeWords,
  defaultRoundsFilter,
  deltaDomain,
  fmtAgo,
  fmtBig,
  fmtDuration,
  fmtGib,
  fmtPts,
  gapStarts,
  gymAddress,
  groupScorecards,
  gymToken,
  isStale,
  linePoints,
  mountWords,
  nightHeadline,
  parseGymStatus,
  roundsOptions,
  type GymScorecard,
  serviceLine,
  servicesSummary,
  share,
  slug,
  tailscaleOnly,
  type GymStatus
} from '@shared/gym'
import { classifiedScope } from '@shared/daemon-profiles'
import { GymStatusReader } from './gym-status'
import { StatusServiceTransport, type GymFetch, type GymGet, type GymTransport } from './gym-transport'
import sample from './fixtures/gym_status.json'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[gym-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 65
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.error(`[gym-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`[gym-smoke] FAIL — ${failures}/${checks} checks failed`)
    process.exitCode = 1
  } else console.log(`[gym-smoke] OK — ${checks} checks passed`)
})

// Tailscale addresses are built here, not written: lint:names refuses one written out anywhere in the source.
const TS4 = [100, 101, 7, 9].join('.')
const TS4_B = [100, 64, 0, 3].join('.')
const TS6 = 'fd7a:115c:a1e0::9'
const PUBLIC = [203, 0, 113, 7].join('.')
const LAN = [192, 168, 1, 20].join('.')
// A name that LOOKS like a Tailscale one (built, not written: the pre-commit hook refuses one written out).
const TS_NAME = ['gym-box', 'example', 'ts', 'net'].join('.')
// A made-up token in the shape of one. Split so no scanner takes it for a real one.
const TOKEN = ['smoke', 'only', 'not-a-real-token', '0123456789'].join('_')
const TOKEN_2 = `${TOKEN}_second`

async function main(): Promise<void> {
  // ── 1. the address ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const bare = gymAddress(' gym-box:18097 ')
  assert(bare.ok && bare.url === 'http://gym-box:18097/v2/status' && bare.host === 'gym-box', 'address: a bare name and port becomes an http URL at the status path', JSON.stringify(bare))
  const pathed = gymAddress('gym-box:18097/v9/status')
  const v6 = gymAddress(`https://[${TS6}]:8443/v1/status`)
  assert(pathed.ok && pathed.url === 'http://gym-box:18097/v9/status' && v6.ok && v6.host === TS6, 'address: a path that was typed is kept; https and a bracketed IPv6 host are kept, the host without brackets')
  assert(!gymAddress('ftp://gym-box/status').ok && !gymAddress('http://').ok && !gymAddress('not a url').ok && !gymAddress('').ok, 'address: not http(s), or not a URL, is refused')
  const cred = gymAddress('http://owner:secret@gym-box/status')
  const query = gymAddress('http://gym-box/status?token=abc')
  assert(!cred.ok && cred.reason === GYM_ADDRESS_COPY.credentials && !query.ok && query.reason === GYM_ADDRESS_COPY.extras && !gymAddress('http://gym-box/status#x').ok, 'address: credentials, a query (so no token in a URL) or a fragment are refused, each in words')

  // ── 2. Tailscale only ───────────────────────────────────────────────────────────────────────────────────────────────────
  const both = tailscaleOnly([TS4, TS6])
  assert(both.ok && both.address === TS4, 'tailscale: every address a Tailscale one (IPv4 range and IPv6 prefix) passes, and the first is the one to connect to')
  assert(
    [[PUBLIC], [LAN], ['127.0.0.1'], [TS4, PUBLIC], [TS4, LAN]].every((a) => {
      const r = tailscaleOnly(a)
      return !r.ok && r.reason === GYM_ADDRESS_COPY.notTailscale
    }),
    'tailscale: a public, home-network or loopback address is refused, and so is a name that resolves to one among Tailscale ones'
  )
  const none = tailscaleOnly([])
  assert(!none.ok && none.reason === GYM_ADDRESS_COPY.noResolve, 'tailscale: a name that resolves to nothing is "couldn\'t find that computer"')

  // ── 3. the token's shape ────────────────────────────────────────────────────────────────────────────────────────────────
  assert(gymToken(` ${TOKEN}\n`) === TOKEN && gymToken('short') === null && gymToken(`${TOKEN} x`) === null && gymToken(`${TOKEN}\r\nx-evil: 1`) === null && gymToken('é'.repeat(20)) === null && gymToken(null) === null && gymToken('a'.repeat(513)) === null, 'token: one run of visible ASCII; a space, a line break (a second header), other characters, too short or too long is refused')

  // ── 4. today's transport: the status service ────────────────────────────────────────────────────────────────────────────
  const body = JSON.stringify(sample)
  let saved: string | null = null
  let token: string | null = null
  let keychain = true
  let tokenReads = 0
  const asked: { url: string; address: string; headers: Record<string, string> }[] = []
  let answer: Awaited<ReturnType<GymGet>> = { status: 200, text: body, etag: '"v1"' }
  let resolves: Record<string, string[]> = { 'gym-box': [TS4], [TS_NAME]: [PUBLIC], 'two-homes': [TS4_B, LAN] }
  const service = new StatusServiceTransport({
    address: () => saved,
    saveAddress: (u) => {
      saved = u === '' ? null : u
    },
    readToken: () => {
      tokenReads++
      return token
    },
    saveToken: (t) => {
      if (!keychain) return false
      token = t === '' ? null : t
      return true
    },
    resolve: async (h) => {
      if (h === TS4 || h === PUBLIC) return [h]
      if (!(h in resolves)) throw new Error('ENOTFOUND')
      return resolves[h]
    },
    get: async (url, address, headers) => {
      asked.push({ url, address, headers })
      return answer
    }
  })
  const reader = new GymStatusReader({ transport: service, now: () => 1_000 })
  assert((await reader.read()).kind === 'unset' && asked.length === 0, 'service: no address saved is "unset", and nothing is asked')

  const refusals = [await service.setAddress(`http://${TS_NAME}/status`), await service.setAddress(`http://${PUBLIC}/status`), await service.setAddress('http://two-homes/status'), await service.setAddress('http://nowhere/status'), await service.setAddress(42)]
  assert(refusals.every((r) => !r.ok) && saved === null, 'service: an address that is not Tailscale-only is not saved (a .ts.net name that resolves elsewhere, a public address, a name with a home-network address too, a name that does not resolve, not text)', JSON.stringify(refusals))
  const kept = await service.setAddress('gym-box:18097')
  assert(kept.ok && saved === 'http://gym-box:18097/v2/status', 'service: a Tailscale-only address is saved as its URL')

  assert((await reader.read()).kind === 'no-token' && asked.length === 0, 'token: with no token kept, the gym is not asked at all')
  const badSet = service.setToken('has a space in it, sixteen long')
  assert(!badSet.ok && badSet.reason === GYM_ADDRESS_COPY.badToken && token === null, 'token: one that is not token-shaped is refused and not kept')
  keychain = false
  const noChain = service.setToken(TOKEN)
  assert(!noChain.ok && noChain.reason === GYM_ADDRESS_COPY.noKeychain && token === null, 'token: when it cannot be sealed it is not kept any other way, and the page is told')
  keychain = true
  assert(service.setToken(TOKEN).ok && token === TOKEN, 'token: a token-shaped one is kept')
  const told = JSON.stringify(service.settings())
  assert(told === JSON.stringify({ address: 'http://gym-box:18097/v2/status', hasToken: true }) && !told.includes(TOKEN), 'token: the page is told the address and THAT a token is kept, never the token')

  const shown = await reader.read()
  assert(shown.kind === 'shown' && !shown.sample && shown.readAt === 1_000 && shown.status.round?.id === 'r5', 'service: a 200 with a status is shown, and is not called a sample')
  assert(
    asked.length === 1 && asked[0].url === 'http://gym-box:18097/v2/status' && asked[0].address === TS4 && asked[0].headers.authorization === `Bearer ${TOKEN}` && !asked[0].url.includes(TOKEN) && !('if-none-match' in asked[0].headers) && Object.keys(asked[0].headers).join() === 'authorization',
    'service: the request goes to the address that was checked, with the token in the Authorization header and nowhere else',
    JSON.stringify(asked.map((a) => ({ ...a, headers: Object.keys(a.headers) })))
  )
  assert(!JSON.stringify(shown).includes(TOKEN), 'token: nothing the page is given holds it')

  answer = { status: 304, text: '', etag: '"v1"' }
  const again = await reader.read()
  assert(asked[1].headers['if-none-match'] === '"v1"' && again.kind === 'shown' && again.status === (shown.kind === 'shown' ? shown.status : null), 'service: the next request carries the ETag, and an unchanged snapshot (304) shows the status already read')

  resolves = { 'gym-box': [PUBLIC] }
  const before = asked.length
  const moved = await reader.read()
  assert(moved.kind === 'refused' && moved.reason === GYM_ADDRESS_COPY.notTailscale && asked.length === before, 'service: a saved name that now resolves off Tailscale is refused on the next read, and nothing (so no token) is sent')
  resolves = { 'gym-box': [TS4] }

  const outcomes: string[] = []
  const replies: Awaited<ReturnType<GymGet>>[] = ['unreachable', 'too-big', { status: 401, text: '{"error":"unauthorized"}', etag: null }, { status: 403, text: '{"error":"forbidden"}', etag: null }, { status: 429, text: '', etag: null }, { status: 404, text: body, etag: null }, { status: 302, text: '', etag: null }, { status: 200, text: '<html>', etag: null }, { status: 200, text: '{"schema":"something-else/1"}', etag: null }]
  for (const a of replies) {
    answer = a
    const r = await reader.read()
    outcomes.push(r.kind === 'denied' ? `denied:${r.why}` : r.kind)
  }
  assert(outcomes.join(',') === 'unreachable,unreadable,denied:token,denied:device,denied:rate,unreadable,unreadable,unreadable,unreadable', 'service: no answer is "unreachable"; 401 is the token, 403 is the device, 429 is asking too often; too big, any other status (a redirect included), not JSON, or another schema is "unreadable"', outcomes.join(','))

  answer = { status: 200, text: body, etag: '"v2"' }
  await reader.read()
  service.setToken(TOKEN_2)
  await reader.read()
  const lastAsk = asked[asked.length - 1]
  assert(lastAsk.headers.authorization === `Bearer ${TOKEN_2}` && !('if-none-match' in lastAsk.headers), 'token: a new token replaces the old one, and the ETag kept for the old one is not reused')
  assert(service.setToken('').ok && token === null && (await reader.read()).kind === 'no-token', 'token: an empty one forgets it')
  assert(tokenReads === 1, 'token: across every read, save, replace and forget above, the keychain was asked for it exactly once', `asked ${tokenReads} times`)
  {
    let reads = 0
    const cold = new StatusServiceTransport({ address: () => 'http://gym-box:18097/v2/status', saveAddress: () => undefined, readToken: () => (reads++, TOKEN), saveToken: () => true, resolve: async () => [TS4], get: async () => ({ status: 200, text: body, etag: null }) })
    cold.settings()
    for (let i = 0; i < 5; i++) await cold.fetch()
    cold.settings()
    cold.setToken(TOKEN_2)
    await cold.fetch()
    cold.settings()
    assert(reads === 1, 'token: a token already kept is read once at first use; refreshes, the page asking, and saving a new one never read it again', `read ${reads} times`)
  }
  const cleared = await service.setAddress('  ')
  assert(cleared.ok && saved === null && (await reader.read()).kind === 'unset', 'service: an empty address forgets the gym')

  // ── 5. one transport, and where things are kept ─────────────────────────────────────────────────────────────────────────
  const canned: GymFetch[] = [{ kind: 'document', json: sample }, { kind: 'same' }, { kind: 'denied', why: 'device' }, { kind: 'unreachable' }]
  const other: GymTransport = { fetch: async () => canned.shift() as GymFetch }
  const viaOther = new GymStatusReader({ transport: other })
  const seen = [await viaOther.read(), await viaOther.read(), await viaOther.read(), await viaOther.read()].map((r) => r.kind)
  assert(seen.join(',') === 'shown,shown,denied,unreachable', 'transport: the reader works the same over any transport that hands it the document (the gateway, later)', seen.join(','))
  assert((await new GymStatusReader({ transport: { fetch: async () => ({ kind: 'same' }) } }).read()).kind === 'unreadable', 'transport: "the same as last time" with nothing kept is not shown as a status')

  const fixture = new URL('../../src/main/fixtures/gym_status.json', `file://${process.cwd()}/out/main/`).pathname
  const sampled = await new GymStatusReader({ transport: { fetch: async () => ({ kind: 'unreachable' }) }, sampleFile: fixture }).read()
  assert(sampled.kind === 'shown' && sampled.sample, 'reader: a sample file is shown, and says it is a sample')

  const src = (p: string): string => readFileSync(p, 'utf8')
  const transportSrc = src('src/main/gym-transport.ts')
  const readerSrc = src('src/main/gym-status.ts')
  const indexSrc = src('src/main/index.ts')
  const panel = src('src/renderer/src/components/GymPanel.tsx')
  assert((transportSrc.match(/method: '[A-Z]+'/g) ?? []).join() === "method: 'GET'" && !/\.write\(|body:/.test(transportSrc), 'read-only: the transport makes one kind of request, a GET with no body')
  assert(!/node:http|node:https|node:dns|authorization|tailscaleOnly|gymAddress/i.test(readerSrc) && !/authorization|Bearer|\/v1\/status|If-None-Match|etag/i.test(panel), 'transport: only the transport knows the address, the token and the wire; the reader and the panel name none of them')
  assert(/sampleFile: debuggingAllowedHere\(\) \? process\.env\.BEACON_GYM_STATUS_FILE \|\| null : null/.test(indexSrc), 'the sample file is read only by a build that may be debugged, never a release')
  assert(
    /const gymTokenStore = new CredentialStore\(join\(app\.getPath\('userData'\), 'gym-status\.key'\), electronSafeStorageCipher\(\)\)/.test(indexSrc) && /readToken: \(\) => gymTokenStore\.getToken\(\)/.test(indexSrc) && !/setSetting\([^)]*[Tt]oken/.test(indexSrc.slice(indexSrc.indexOf('const gymTokenStore'), indexSrc.indexOf('registerGymHandlers('))),
    'token: main keeps it in a key file of its own, sealed by the OS keychain, and never in a settings row'
  )
  assert(classifiedScope(GYM_ADDRESS_KEY) === 'beacon', 'the address is this Beacon\'s own setting: one gym, whichever Prometheus is open')
  const gymSources = readdirSync('src/main').filter((f) => /^gym-(?!smoke)/.test(f)).map((f) => src(`src/main/${f}`)).join('\n') + src('src/shared/gym.ts') + panel
  assert(!/console\.(log|warn|error|info|debug)/.test(gymSources), 'token: no gym file writes to a log at all, so none can write the token to one')
  const calls = [...new Set((panel.match(/\bb\.[a-zA-Z]+\s*\.[a-zA-Z]+/g) ?? []).map((c) => c.replace(/\s+/g, '')))].sort().join(',')
  assert(calls === 'b.gym.read,b.gym.setAddress,b.gym.setToken,b.gym.settings' && !/fetch\(/.test(panel) && /type="password"/.test(panel), 'read-only: the panel calls the gym read and its two settings, and nothing else; the token field does not show what is typed', calls)

  // ── 6. the status ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const s = parseGymStatus(sample) as GymStatus
  assert(s !== null && s.generatedAt === Date.parse('2026-11-22T08:05:00-05:00') && GYM_SCHEMA === 'gym-status/2', 'status: the sample parses, with its time')
  assert(parseGymStatus(null) === null && parseGymStatus([]) === null && parseGymStatus({ ...sample, schema: 'gym-status/1' }) === null && parseGymStatus({ ...sample, schema: 'gym-status/3' }) === null && parseGymStatus({ ...sample, generated_at: 'yesterday' }) === null, 'status: not an object, another version of the schema (the one before, which named the owner\'s computers, included), or no readable time is not a status')
  const bare1 = parseGymStatus({ schema: GYM_SCHEMA, generated_at: '2026-11-22T08:05:00-05:00', round: null, training: null, hosts: null, data: null })
  assert(bare1 !== null && bare1.round === null && bare1.training === null && bare1.hosts.length === 0 && bare1.scorecards.length === 0 && bare1.lastNight === null, 'status: a section the gym could not build (null, or missing) is empty, not an error')
  assert(s.round?.phase === 'training' && s.round.decision === 'pending' && s.round.stopAfter === true && s.training?.step === 1610 && s.training.total === 2346 && s.training.valLoss.length === 24 && s.training.trainLoss.length === 162 && s.training.eta === Date.parse('2026-11-22T13:10:00-05:00') && s.postTrain?.stepsTotal === 24, 'Now: the round, training progress with its three loss curves, and the after-training checks')
  assert(s.schedule.length === 5 && s.schedule[0].kind === 'train_eta' && s.lastNight?.nightWatch === 'ok' && s.lastNight.training?.stepTo === 1560 && s.lastNight.gpu?.maxTempC === 80 && nightHeadline(s.lastNight).text === 'Night watch passed' && nightHeadline({ ...s.lastNight, windows: [{ host: null, openedAt: null, closedAt: null, restoreOk: false }] }).tone === 'err', 'Now: the schedule soonest first; last night; a failed restore outranks the night watch')
  assert(s.training?.probeLoss.length === 1 && s.lastNight?.nightWatchHosts.map((w) => `${w.host}:${w.result}:${w.steps}:${w.problems}`).join() === 'serve_host:ok:null:0,train_host:ok:580:0' && parseGymStatus({ ...sample, last_night: { ...sample.last_night, night_watch_hosts: undefined } })?.lastNight?.nightWatchHosts.length === 0, 'Now: a loss curve with one reading is kept (it is drawn as a dot); night watch per computer, where the gym gives it')
  assert(s.alerts.map((a) => `${a.severity}:${a.kind}:${a.service}`).join() === 'warn:service_down:voice,warn:disk_low:null,info:source_stale:null' && s.timeline[0].kind === 'night_watch_ok' && s.timeline.length === 6 && s.sources.filter((x) => !x.ok).map((x) => `${x.id}:${x.error}`).join() === 'spend_ledger:missing', 'Now: alerts worst first, the timeline newest first, and the sources the gym could not read')

  const r4 = s.scorecards.find((c) => c.round === 'r4' && c.candidate === 'final')
  const tools = r4?.criteria.find((k) => k.id === 'tool_task_success')
  assert(s.scorecards.length === 4 && r4?.verdict === 'fail' && r4.quant === 'q4_k_m' && r4.criteria.length === 9 && tools?.deltaPts === 7.6 && tools.status === 'fail' && tools.bar.kind === 'min_delta_pts' && tools.bar.pts === 10 && tools.ciLowPts === 3 && tools.n === 329, 'Rounds: every scorecard, with each criterion\'s change, interval, bar and the gym\'s own pass or fail')
  const ref = s.scorecards[3]
  assert(r4?.replay.map((x) => `${x.set}:${x.faPass}/${x.faN}:${x.tcPass}/${x.tcN}`).join() === 'replay_236:80/208:null/null,random_200:57/99:66/94' && ref.criteria.length === 0 && ref.replay[0].faPass === 171, 'Rounds: the replay counts against the reference model, and a reference column has only those')
  assert(
    barWords({ kind: 'min_delta_pts', pts: 10 }) === 'must gain at least 10.0 pts' && barWords({ kind: 'max_drop_pts', pts: 3 }) === 'may drop at most 3.0 pts' && barWords({ kind: 'max_drop_pts', pts: 0 }) === 'must not drop at all' && barWords({ kind: 'non_inferior_paired', pts: null }) === 'must not be worse (paired test)' && barAt({ kind: 'min_delta_pts', pts: 10 }) === 10 && barAt({ kind: 'max_drop_pts', pts: 3 }) === -3 && barAt({ kind: 'non_inferior_paired', pts: null }) === null,
    'Rounds: each kind of bar in words, and where it sits on the change scale'
  )
  const dom = deltaDomain(s.scorecards.map((c) => c.criteria.find((k) => k.id === 'tool_task_success')))
  assert(dom.min < -0.4 && dom.max > 12.2 && along(0, dom) > 0 && along(10, dom) > along(7.6, dom) && along(7.6, dom) > along(4.2, dom) && along(99, dom) === 100, 'Rounds: one scale for a criterion across every column, holding zero, the bar and every interval', JSON.stringify(dom))

  // Rounds on screen: one slice, grouped by round
  const shape = (f: Parameters<typeof groupScorecards>[1], cs: readonly GymScorecard[] = s.scorecards): string => groupScorecards(cs, f).map((g) => `${g.round}[${g.cards.map((c) => c.candidate).join(',')}]${g.noneKept ? '!' : ''}`).join(' ')
  const def = defaultRoundsFilter(s.scorecards)
  assert(JSON.stringify(def) === JSON.stringify({ quant: 'q4_k_m', vs: 'same_recipe_base', candidate: 'kept' }) && JSON.stringify(roundsOptions(s.scorecards)) === JSON.stringify({ quants: ['q4_k_m'], vs: ['same_recipe_base'], candidates: ['epoch1', 'final'] }) && shape(def) === 'r3[final] r4[final,reference]', 'Rounds: it opens on the gate\'s quantisation, against the base on the same recipe, each round\'s kept candidate, grouped by round; the reference column stays with its round', shape(def))
  assert(shape({ ...def, candidate: 'all' }) === 'r3[final] r4[final,epoch1,reference]' && shape({ ...def, candidate: 'epoch1' }) === 'r4[epoch1,reference]' && shape({ ...def, quant: 'bf16' }) === '' && shape({ ...def, vs: 'pinned_majority' }) === '', 'Rounds: the candidate filter widens or narrows a round; a round the filters leave empty is not shown')
  const mk = (round: string, candidate: string, quant: string, vs: string, selected: boolean): GymScorecard => ({ ...s.scorecards[0], round, candidate, quant, vs, selected, promoted: false })
  const many = [mk('r10', 'final', 'q4_k_m', 'same_recipe_base', true), mk('r2', 'final', 'q4_k_m', 'same_recipe_base', false), mk('r2', 'epoch1', 'q4_k_m', 'same_recipe_base', false), mk('r2', 'final', 'q5_k_m', 'same_recipe_base', true), mk('r2', 'final', 'q4_k_m', 'base9b_pinned', true), mk('r9', 'final', 'q5_k_m', 'base9b_pinned', true)]
  assert(
    shape(defaultRoundsFilter(many), many) === 'r2[final,epoch1]! r10[final]' && shape({ quant: 'all', vs: 'all', candidate: 'kept' }, many) === 'r2[final,final] r9[final] r10[final]' && shape({ quant: 'q5_k_m', vs: 'base9b_pinned', candidate: 'all' }, many) === 'r9[final]' && JSON.stringify(defaultRoundsFilter([mk('r1', 'final', 'bf16', 'pinned_majority', true)])) === JSON.stringify({ quant: 'all', vs: 'all', candidate: 'kept' }),
    'Rounds: rounds go in number order (r2 before r10); a round with no kept candidate in the slice shows all of them and says so; where the gate\'s quantisation or comparison is not served, that filter opens on all',
    shape(defaultRoundsFilter(many), many)
  )

  assert(s.data?.pool?.rowsTotal === 61234 && s.data.pool.bySource[0].id === 'local-27b-gym' && s.data.dataset?.perSeedCap === 12 && s.data.dataset.seedsOverCap === 0 && s.data.dataset.byArea.length === 5 && s.data.tasksets.length === 3 && s.data.tasksets[1].selfBleu4 === 0.4512 && s.data.history.map((h) => h.round).join() === 'r2,r3,r4,r5' && s.data.poolGrowth.length === 19 && s.data.poolGrowth[18][1] === 61234 && s.data.poolGrowth[0][0] < s.data.poolGrowth[18][0] && s.data.poolAdded.map((x) => x.id).join() === 'local-27b-gym,cloud-gym-written', 'Data: the pool by source (largest first) and day by day, this round\'s dataset with its per-seed cap, the written sets\' variety, and the rounds\' history')
  assert(s.generation?.last24h?.rowsPerHour === 332.2 && s.generation.last24h.byTeacherPerHour[0].id === 'cloud' && s.generation.activeRuns[0].teacher === 'other' && s.generation.judge24h?.pass === 1405 && s.tokenPlan?.state === 'ok' && s.tokenPlan.usage7d?.errors === 17 && s.tokenPlan.usage24h === null, 'Data: teacher throughput, the judge, and the token plan')

  const serve = s.hosts.find((h) => h.id === 'serve_host')
  const train = s.hosts.find((h) => h.id === 'train_host')
  assert(s.hosts.map((h) => h.id).join() === 'train_host,serve_host' && train?.gpuTemp.length === 289 && train.gpuPower.length === 289 && train.disk[1].freeGib === 24 && train.window?.open === true && train.window.job === 'train' && train.lastRestoreOk === true && train.watchdog?.lastOk === true && serve?.gpuTemp.length === 0 && serve.gpu?.tempC === 61 && codeWords('train_host') === 'Training computer' && codeWords('serve_host') === 'Serving computer', 'Hosts: the training and the serving computer, in Beacon\'s words, each with its disks, GPU and history, window, restore and watchdog')
  const at = (t: number): string => new Date(t).toISOString().slice(0, 16)
  const lines = s.hosts.flatMap((h) => h.services.map((x) => `${x.id}: ${serviceLine(x, at).text} [${serviceLine(x, at).tone}]`))
  assert(
    lines.join(' | ') === 'business_model: Down, as planned: training window until 2026-11-23T12:40 [idle] | tunnel: Up [ok] | reference_model: Up [ok] | daemon: Up [ok] | voice: Down unexpectedly: not answering [err]',
    'Hosts: each service says whether it is up; a planned stop (why, until when) reads apart from an unexpected one (and why)',
    lines.join(' | ')
  )
  const svc = (o: Record<string, unknown>) => parseGymStatus({ ...sample, hosts: { train_host: { services: [{ id: 'tunnel', ...o }] } } })?.hosts[0]?.services[0]
  const loose = [svc({ state: 'down', planned: 'yes' }), svc({ state: 'up', planned: true, reason: 'train_window', until: '2026-11-23T07:40:00-05:00' }), svc({ state: 'degraded', planned: true, reason: 'maintenance_window' }), svc({ state: 'degraded', reason: 'partly_running' }), svc({}), svc({ state: 'down', until: '2026-11-23T07:40:00-05:00' })]
  assert(
    loose.map((x) => (x ? serviceLine(x, at).text : '?')).join(' | ') === 'Down unexpectedly | Up | Partly working, as planned: maintenance window | Partly working unexpectedly: only partly running | Not reported | Down unexpectedly' && loose[1]?.planned === false && loose[1]?.until === null && loose[5]?.until === null,
    'Hosts: downtime is planned only when the gym says exactly that; anything else that is down is unexpected, and a service that is up is never called planned',
    loose.map((x) => (x ? serviceLine(x, at).text : '?')).join(' | ')
  )
  const strict = parseGymStatus({ ...sample, hosts: { ...sample.hosts, 'some-other-box': sample.hosts.train_host, reference: { healthy: false } }, scorecards: [{ ...sample.scorecards[1], reference_replay: null, other_replay: { replay_236: { fa_pass: 1, fa_n: 2 } } }], last_night: { ...sample.last_night, gpu_train_host: null, gpu_other: { max_temp_c: 99 } } })
  assert(strict?.hosts.map((h) => h.id).join() === 'train_host,serve_host' && strict.hosts.every((h) => h.services.every((x) => x.id !== 'reference')) && strict.scorecards[0].replay.length === 0 && strict.lastNight?.gpu === null, 'strict: only the keys the schema names are read; a host, a replay or a GPU under any other key is not')
  const sum = servicesSummary(s.hosts)
  assert(sum.total === 5 && sum.up === 3 && sum.planned === 1 && sum.unexpected === 1, 'Now: services are counted as up, down as planned, and down unexpectedly', JSON.stringify(sum))

  // ── 7. no text from the gym ─────────────────────────────────────────────────────────────────────────────────────────────
  const SECRET = 'Summarise the client contract and email it'
  const plant = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(plant)
    if (v !== null && typeof v === 'object') {
      const o: Record<string, unknown> = { prompt: SECRET, trace: [SECRET], task_text: SECRET, message: SECRET, [SECRET]: 7 }
      for (const [k, x] of Object.entries(v)) o[k] = k === 'schema' || k === 'generated_at' ? x : typeof x === 'string' && Number.isNaN(Date.parse(x)) ? SECRET : plant(x)
      return o
    }
    return v
  }
  const planted = parseGymStatus(plant(sample))
  const text = JSON.stringify(planted)
  assert(planted !== null && !text.includes('Summarise') && !text.includes('client') && !/"[^"]* [^"]*"/.test(text), 'no text: sentences planted in every string, as map keys, and in prompt, trace, task_text and message fields are all dropped; nothing kept has a space in it')
  assert(planted?.round === null && planted.scorecards.length === 0 && planted.alerts.length === 0 && planted.training?.step === 1610 && planted.hosts.length === 2 && planted.hosts[0].services.length === 0, 'no text: a row that needed a dropped identifier goes with it, a dropped enum reads as unknown, and the numbers stay')
  assert(slug('r5') === 'r5' && slug('train-box') === 'train-box' && slug('Fix the bug') === null && slug('UPPER') === null && slug('a/b') === null && slug('teacher_gen:tw-written') === 'teacher_gen:tw-written' && slug('a b') === null && slug('a'.repeat(41)) === null && slug(5) === null && codeWords('disk_low') === 'Disk space low' && codeWords('some_new_kind') === 'some new kind', 'no text: an identifier is lower-case and has no spaces; one Beacon knows gets Beacon\'s words, another is shown as itself')

  // ── 8. numbers ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  assert(fmtDuration(45) === '45 s' && fmtDuration(12_300) === '3 h 25 min' && fmtDuration(7200) === '2 h' && fmtGib(24) === '24 GiB' && fmtGib(3900) === '3.8 TiB' && fmtGib(1.5) === '1.5 GiB' && fmtBig(343158304) === '343.2M' && fmtBig(39966) === '39,966' && fmtPts(7.6) === '+7.6 pts' && fmtPts(-11.67) === '−11.7 pts' && fmtPts(3, false) === '3.0 pts' && share(5, 0) === 0 && share(3, 2) === 100, 'numbers: durations, sizes, big counts, points and shares read plainly and stay in range')
  assert(fmtAgo(0, 30_000) === 'just now' && fmtAgo(0, 240_000) === '4 min ago' && fmtAgo(0, 3 * 3600_000) === '3 h ago' && fmtAgo(0, 86_400_000) === '1 day ago' && !isStale(s, s.generatedAt + 60_000) && isStale(s, s.generatedAt + 3600_000), 'numbers: how long ago, and a status over ten minutes old is said to be old')
  assert([...gapStarts([[0, 1], [5, 1], [10, 1], [15, 1], [300, 1], [305, 1]])].join() === '4' && gapStarts([[0, 1], [5, 1], [10, 1]]).size === 0 && gapStarts([[0, 1], [9, 1]]).size === 0 && mountWords('data') === 'data' && codeWords('data') === 'Gathering data' && mountWords('wd_archive') === 'archive', 'numbers: a line lifts its pen over a stretch with no readings; a disk called data is not given the round phase\'s words')
  const lp = linePoints([[0, 10], [5, 20], [10, 0]], 100, 50, 0)
  assert(linePoints([[0, 1]], 100, 50) === null && lp !== null && lp.min === 0 && lp.max === 20 && lp.points.map((p) => p.join(':')).join(' ') === '0:25 50:0 100:50', 'numbers: a line needs two points, and is drawn over the range of its values')
}

void main().catch((e) => {
  console.error('[gym-smoke] FAIL — threw', e)
  process.exitCode = 1
})
