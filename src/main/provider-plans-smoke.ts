/**
 * Provider-plans smoke (.claude/private/handoff-provider-plans-contract.md): Config → Models offers a provider's subscription
 * plans (GLM Coding Plan, Kimi Code, Qwen's Token / Coding Plan) only when the daemon says it serves them, picks a plan by id, and
 * saves key + plan in one PUT that never carries a URL. Headless: @shared/provider-plans against a fixture in the contract's shape
 * (src/main/fixtures/provider_plans_assumed.json, ASSUMED until the Prometheus PR lands and a real answer is recorded).
 *
 *   npm run build && npm run smoke:provider-plans
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { coerceKeyServices, type ProviderKeyServiceDTO } from '@shared/model-keys'
import { buildPlanPayload, currentPlanId, isCustomConflict, planChipText, planPinned, plansSupported, planWarnings, servicePlans, workspaceRegions } from '@shared/provider-plans'
import { scrubWriteError } from '@shared/connectors'

let failures = 0
let checks = 0
const EXPECTED = 43
function assert(cond: boolean, label: string): void {
  checks++
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

const fixture = JSON.parse(readFileSync(join(__dirname.replace(/out\/main.*$/, ''), 'src/main/fixtures/provider_plans_assumed.json'), 'utf8')) as Record<string, unknown>
const services = coerceKeyServices(fixture)
const svc = (id: string): ProviderKeyServiceDTO => services.find((s) => s.id === id)!
const glm = svc('glm')
const qwen = svc('qwen')
const kimi = svc('kimi')
const deepseek = svc('deepseek')
const mimo = svc('mimo')
const regions = workspaceRegions(fixture)
// The answer recorded from the real route (Prometheus feat/subscription-plans, tests/fixtures/provider_plans/get_keys.json).
const recorded = JSON.parse(readFileSync(join(__dirname.replace(/out\/main.*$/, ''), 'src/main/fixtures/provider_plans_recorded.json'), 'utf8')) as Record<string, unknown>
const real = coerceKeyServices(recorded)

console.log('\n[smoke] === the gate ===')
assert(plansSupported(fixture), 'a daemon that says capabilities.plans 1 serves plans')
assert(!plansSupported({ services: fixture.services }), 'one that says nothing does not: today\'s key-only rows')
assert(!plansSupported({ ...fixture, capabilities: { plans: 0 } }) && !plansSupported({ ...fixture, capabilities: { plans: '1' } }) && !plansSupported(null), 'nor one that says 0, a string, or nothing at all')

console.log('\n[smoke] === a plan list, checked ===')
assert(servicePlans(glm)?.map((p) => p.id).join() === 'payg,coding-plan,cn', 'GLM\'s plans, in the daemon\'s order')
assert(servicePlans(qwen)?.find((p) => p.id === 'token-plan')?.terms?.startsWith('Alibaba') === true, 'a plan\'s terms come through, as a label')
assert(servicePlans(deepseek) === null, 'DeepSeek, a normal key: no plans, so the row is as today')
assert(servicePlans({ ...glm, plans: [{ ...((glm.plans as Record<string, unknown>[])[0]), default: false }] } as ProviderKeyServiceDTO) === null, 'no default plan: the list is not trusted (key-only row)')
const twoDefaults = (glm.plans as Record<string, unknown>[]).map((p) => ({ ...p, default: true }))
assert(servicePlans({ ...glm, plans: twoDefaults } as ProviderKeyServiceDTO) === null, 'two defaults: not trusted either')
const badId = [...(glm.plans as Record<string, unknown>[]), { id: 'https://evil.example', label: 'x', subscription: false, terms: null, default: false, custom: false }]
assert(servicePlans({ ...glm, plans: badId } as ProviderKeyServiceDTO)?.some((p) => p.id.includes('/')) === false, 'a plan whose id is not a plain slug is dropped')

console.log('\n[smoke] === which plan it is on ===')
assert(currentPlanId(glm) === 'coding-plan', 'GLM is on its Coding Plan')
assert(currentPlanId(kimi) === 'payg', 'Kimi, endpoint unset: its default')
assert(currentPlanId(mimo) === 'custom', 'a hand-set endpoint that matches no plan: custom')
assert(currentPlanId({ ...glm, plan: 'gone' } as ProviderKeyServiceDTO) === 'custom', 'a plan id the list does not have: custom, never guessed')

console.log('\n[smoke] === the row says how it is connected ===')
assert(planChipText(qwen) === 'Token Plan', 'Qwen: "via Token Plan", not "via API key"')
assert(planChipText(kimi) === null, 'Kimi on pay as you go, no key: nothing new to say')
assert(planChipText(mimo) === 'a custom endpoint', 'a custom endpoint says so')
assert(planChipText({ ...glm, env_vars: [{ name: 'ZAI_API_KEY', set: false }] } as ProviderKeyServiceDTO) === null, 'a plan with no key yet: no "via"')

console.log('\n[smoke] === saving ===')
const keys = (p: unknown): string => Object.keys((p as Record<string, unknown>) ?? {}).sort().join()
const both = buildPlanPayload({ svc: kimi, typed: { MOONSHOT_API_KEY: '  sk-kimi  ' }, plan: 'kimi-code' })
assert(both.ok && JSON.stringify(both.payload) === JSON.stringify({ values: { MOONSHOT_API_KEY: 'sk-kimi' }, plan: 'kimi-code' }), 'key and plan go together, in one PUT (the key trimmed)')
const planOnly = buildPlanPayload({ svc: glm, typed: {}, plan: 'payg' })
assert(!planOnly.ok && planOnly.reason === 'needs-key', 'a plan change without a key is refused: a plan takes only its own key (the daemon 400s a plan alone)')
assert(!buildPlanPayload({ svc: glm, typed: {}, plan: 'coding-plan' }).ok, 'nothing changed: nothing to save')
assert(!buildPlanPayload({ svc: glm, typed: {}, plan: 'not-a-plan' }).ok, 'a plan the daemon did not list is refused')
const ws = buildPlanPayload({ svc: qwen, typed: { QWEN_API_KEY: 'sk-ws' }, plan: 'workspace', workspace: { id: 'team-42', region: 'ap-southeast-1' }, regions })
assert(ws.ok && JSON.stringify((ws.payload as { workspace?: unknown }).workspace) === JSON.stringify({ id: 'team-42', region: 'ap-southeast-1' }), 'a workspace plan carries its id and region')
assert(!buildPlanPayload({ svc: qwen, typed: { QWEN_API_KEY: 'k' }, plan: 'workspace', workspace: { id: 'a.b/c', region: 'ap-southeast-1' }, regions }).ok && !buildPlanPayload({ svc: qwen, typed: { QWEN_API_KEY: 'k' }, plan: 'workspace', workspace: { id: 'ok', region: 'mars-1' }, regions }).ok, 'a workspace id that is not a slug, or a region not listed: refused')
const offCustom = buildPlanPayload({ svc: mimo, typed: { MIMO_API_KEY: 'sk-m' }, plan: 'payg' })
const offCustomOk = buildPlanPayload({ svc: mimo, typed: { MIMO_API_KEY: 'sk-m' }, plan: 'payg', replaceCustom: true })
assert(!offCustom.ok && offCustom.reason === 'custom' && offCustomOk.ok && (offCustomOk.payload as { replace_custom?: boolean }).replace_custom === true, 'leaving a custom endpoint needs the person to confirm, then says replace_custom')
const all = [both, ws, offCustomOk].map((r) => (r.ok ? JSON.stringify(r.payload) : ''))
assert(all.every((p) => !/https?:|base_url|url/i.test(p)), 'no payload ever carries a URL')
assert(isCustomConflict('HTTP 409: PUT /api/providers/keys/mimo — {"error":"custom endpoint"}') && !isCustomConflict('HTTP 400: PUT x'), 'the daemon\'s 409 is read as "confirm replacing a custom endpoint"')

console.log('\n[smoke] === what the reviews found ===')
assert(isCustomConflict("Error invoking remote method 'daemon:write': Error: HTTP 409: PUT /api/providers/keys/mimo — {\"error\":\"custom\"}"), 'the 409 is recognised as the renderer really gets it, inside Electron\'s wrapper')
const keyOnlyCustom = buildPlanPayload({ svc: mimo, typed: { MIMO_API_KEY: 'sk-new' }, plan: 'custom' })
assert(keyOnlyCustom.ok && keys(keyOnlyCustom.payload) === 'values', 'on a custom endpoint, a new key alone is saved as {values}, endpoint untouched')
const qwenWs = { ...qwen, plan: 'workspace' } as ProviderKeyServiceDTO
const keyOnlyWs = buildPlanPayload({ svc: qwenWs, typed: { QWEN_API_KEY: 'sk-new' }, plan: 'workspace', regions })
assert(keyOnlyWs.ok && keys(keyOnlyWs.payload) === 'values', 'on a workspace, a new key alone needs no workspace id again')
const moveWs = buildPlanPayload({ svc: qwenWs, typed: { QWEN_API_KEY: 'sk-new' }, plan: 'workspace', workspace: { id: 'other', region: 'us-east-1' }, regions })
assert(moveWs.ok && keys(moveWs.payload) === 'plan,values,workspace', 'on a workspace, a new id or region is a plan save with its key, never dropped')
assert(planChipText({ ...mimo, env_vars: [{ name: 'MIMO_API_KEY', set: false }] } as ProviderKeyServiceDTO) === null, 'a custom endpoint with no key saved keeps today\'s "no key" chip')
assert(currentPlanId({ ...glm, plan: undefined, endpoint_set: true } as ProviderKeyServiceDTO) === 'custom', 'no plan from the daemon but an endpoint set: custom, so nothing clears it unconfirmed')
assert(!buildPlanPayload({ svc: qwen, typed: { QWEN_API_KEY: 'k' }, plan: 'workspace', workspace: { id: '-bad', region: 'ap-southeast-1' }, regions }).ok && !buildPlanPayload({ svc: qwen, typed: { QWEN_API_KEY: 'k' }, plan: 'workspace', workspace: { id: 'a'.repeat(61), region: 'ap-southeast-1' }, regions }).ok, 'a workspace id that could not be a hostname label is refused')
const dup = [...(glm.plans as Record<string, unknown>[]), { id: 'payg', label: 'Again', subscription: false, terms: null, default: false, custom: false }]
assert(servicePlans({ ...glm, plans: dup } as ProviderKeyServiceDTO)?.filter((p) => p.id === 'payg').length === 1, 'a duplicate plan id: the first one stands')
const scrubbed = scrubWriteError('HTTP 400: PUT /api/providers/keys/qwen — {"error":"bad key sk-very-secret-value"}', { values: { QWEN_API_KEY: 'sk-very-secret-value' } })
assert(!scrubbed.includes('sk-very-secret-value'), 'a daemon error that quotes the key never shows it')
const wsErr = scrubWriteError('HTTP 400: PUT x — {"error":"workspace team-secret-42 in us-east-1"}', { workspace: { id: 'team-secret-42', region: 'us-east-1' } })
assert(!wsErr.includes('team-secret-42') && wsErr.includes('us-east-1'), "a workspace id is blanked from errors, its region is not")

console.log('\n[smoke] === the confirmed contract and the recorded answer ===')
assert(plansSupported(recorded) && workspaceRegions(recorded).length > 0, 'the real route says plans 1 and lists workspace regions')
const realQwen = real.find((s) => s.id === 'qwen')!
assert(servicePlans(realQwen)?.map((p) => p.id).join() === 'payg-intl,payg-us,token-plan,coding-plan,workspace' && currentPlanId(realQwen) === 'payg-intl', "the real Qwen plans, on its default")
assert(servicePlans(real.find((s) => s.id === 'deepseek')!) === null, 'the real DeepSeek: plans [] is a normal key row')
// The daemon refuses any PUT naming a plan without the key in the same body (separate_keys on every plan): Beacon never sends one.
const realOthers = (servicePlans(realQwen) ?? []).filter((p) => p.id !== 'payg-intl' && !p.custom)
assert(
  realOthers.length > 0 &&
    realOthers.every((p) => {
      const bare = buildPlanPayload({ svc: realQwen, typed: {}, plan: p.id, regions: workspaceRegions(recorded) })
      const keyed = buildPlanPayload({ svc: realQwen, typed: { QWEN_API_KEY: 'k' }, plan: p.id, regions: workspaceRegions(recorded) })
      return !bare.ok && keyed.ok && 'plan' in keyed.payload && 'values' in keyed.payload
    }),
  'every plan change against the real catalog carries the key in the same body'
)
const pinnedSvc = svc('glm2')
assert(planPinned(pinnedSvc) && !planPinned(glm), 'a plan pinned in prometheus.yaml is read as such')
assert(planWarnings(qwen).length === 1 && planWarnings(glm).length === 0, "the daemon's warnings come through, display only")
const pinnedWs = buildPlanPayload({ svc: pinnedSvc, typed: { ZAI2_API_KEY: 'k' }, plan: 'payg', workspace: { id: 'x', region: 'us-east-1' }, regions, pinned: true })
assert(pinnedWs.ok && keys(pinnedWs.payload) === 'values' && !buildPlanPayload({ svc: pinnedSvc, typed: {}, plan: 'payg', pinned: true }).ok, 'a pinned plan: a new key alone, never a plan or workspace change')

if (checks !== EXPECTED) {
  console.log(`[smoke] FAIL — ran ${checks}/${EXPECTED} checks`)
  process.exit(1)
}
console.log(`\n[smoke] ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
