/**
 * Models Config tab smoke (headless / ELECTRON_RUN_AS_NODE) — MODELS KEYS UI sprint.
 *
 * Proves the pure data layer the tab rides on, at src/shared/model-keys.ts where it
 * would actually break:
 *   1. CATALOG→CARDS — a realistic /api/providers/keys payload coerces to clean cards;
 *      wrong-shape/partial payloads degrade to []/dropped entries (never a .map crash).
 *   2. GROUPING — Chat models / Image generation / Video generation in that order,
 *      unknown kinds land honestly in "Other", empty groups are omitted.
 *   3. TWO-VAR SERVICE — Kling renders two labeled fields (Access key / Secret key)
 *      and is only 'set' when BOTH vars are set ('partial' at one).
 *   4. PAYLOADS — save sends ONLY what the user typed (trimmed; null when nothing),
 *      clear sends "" for EVERY var; PUT paths are bridge-allowlisted.
 *   5. NEVER-PREFILL — the DTO carries booleans only (no value-shaped field survives
 *      coercion), and untyped/blank inputs never enter a save payload.
 *
 * It does NOT (and cannot, headless) assert the rendered DOM — the visual pass is the
 * macOS eyes-on walk. FAIL-LOUD: `checks` must equal EXPECTED at exit, so a silently
 * skipped section fails instead of false-passing. A thrown error exits non-zero.
 */
import {
  KEY_KIND_GROUPS,
  KEYS_CATALOG_PATH,
  buildClearPayload,
  buildSavePayload,
  coerceKeyServices,
  envVarFieldLabel,
  groupKeyServices,
  keysPutPath,
  serviceKeyState,
  type ProviderKeyServiceDTO
} from '@shared/model-keys'
import { CONFIG_TABS, isAllowedDaemonPath } from '@shared/daemon-api'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string): void {
  checks++
  console.log(`[model-keys-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

// Required-dependency guard: refuse to vacuously pass if the module isn't wired.
if (
  typeof coerceKeyServices !== 'function' ||
  typeof groupKeyServices !== 'function' ||
  typeof serviceKeyState !== 'function' ||
  typeof envVarFieldLabel !== 'function' ||
  typeof buildSavePayload !== 'function' ||
  typeof buildClearPayload !== 'function' ||
  typeof keysPutPath !== 'function' ||
  !Array.isArray(KEY_KIND_GROUPS) ||
  !Array.isArray(CONFIG_TABS)
) {
  console.error('[model-keys-smoke] FAIL — required model-keys.ts exports missing. Refusing to vacuously pass.')
  process.exit(1)
}

const EXPECTED = 42

// A realistic daemon payload: 2 llm + 1 image + the two-var video service.
const CATALOG = {
  services: [
    { id: 'claude', label: 'Claude', kind: 'llm', env_vars: [{ name: 'ANTHROPIC_API_KEY', set: false }], docs_url: 'https://console.anthropic.com/settings/keys', default_model: 'claude-haiku-4-5-20251001' },
    { id: 'deepseek', label: 'DeepSeek', kind: 'llm', env_vars: [{ name: 'DEEPSEEK_API_KEY', set: true }], docs_url: 'https://platform.deepseek.com/api_keys', default_model: 'deepseek-v4-flash' },
    { id: 'wan-image', label: 'WAN Image', kind: 'image', env_vars: [{ name: 'DASHSCOPE_API_KEY', set: false }], docs_url: 'https://modelstudio.console.alibabacloud.com/', default_model: 'wan2.5-t2i-preview' },
    {
      id: 'kling-video',
      label: 'Kling Video',
      kind: 'video',
      env_vars: [
        { name: 'KLING_ACCESS_KEY', set: true },
        { name: 'KLING_SECRET_KEY', set: false }
      ],
      docs_url: 'https://app.klingai.com/global/dev',
      default_model: 'kling-v3'
    }
  ]
}

function main(): void {
  // ── 1. catalog → cards ──
  const services = coerceKeyServices(CATALOG)
  assert(services.length === 4, `realistic catalog coerces fully (${services.length}/4 services)`)
  assert(coerceKeyServices(null).length === 0, 'null payload → [] (daemon unreachable state)')
  assert(coerceKeyServices({}).length === 0, 'missing services → []')
  assert(coerceKeyServices({ services: 'nope' }).length === 0, 'non-array services → []')
  assert(coerceKeyServices({ services: [{ id: 'x' }] }).length === 0, 'service without env_vars dropped')
  assert(coerceKeyServices({ services: [{ id: 'x', label: 'X', kind: 'llm', env_vars: [] }] }).length === 0, 'service with EMPTY env_vars dropped (nothing to configure)')
  assert(
    coerceKeyServices({ services: [...CATALOG.services, { id: '', label: '', kind: 'llm', env_vars: [{ name: 'A', set: false }] }] }).length === 4,
    'broken entry dropped, good entries kept'
  )

  // ── 2. grouping ──
  const groups = groupKeyServices(services)
  assert(groups.length === 3, `three populated groups (${groups.length})`)
  assert(groups[0].label === 'Chat models' && groups[0].services.length === 2, 'group 1 = Chat models (llm ×2)')
  assert(groups[1].label === 'Image generation' && groups[1].services.length === 1, 'group 2 = Image generation')
  assert(groups[2].label === 'Video generation' && groups[2].services.length === 1, 'group 3 = Video generation')
  assert(
    KEY_KIND_GROUPS.map((g) => g.kind).join(',') === 'llm,image,video',
    'KEY_KIND_GROUPS order is llm,image,video (chat first — the friendly one)'
  )
  const withUnknown = groupKeyServices([...services, { id: 'mystery', label: 'Mystery', kind: 'audio', env_vars: [{ name: 'M_KEY', set: false }] }])
  assert(withUnknown.length === 4 && withUnknown[3].label === 'Other', 'unknown kind → trailing "Other" group (honest, not dropped)')
  assert(groupKeyServices(services.filter((s) => s.kind === 'llm')).length === 1, 'empty groups omitted (llm-only catalog → 1 group)')

  // ── 3. the two-var service (Kling) ──
  const kling = services.find((s) => s.id === 'kling-video') as ProviderKeyServiceDTO
  const claude = services.find((s) => s.id === 'claude') as ProviderKeyServiceDTO
  const deepseek = services.find((s) => s.id === 'deepseek') as ProviderKeyServiceDTO
  assert(kling.env_vars.length === 2, 'kling renders two fields')
  assert(envVarFieldLabel(kling, 'KLING_ACCESS_KEY') === 'Access key', 'field label: KLING_ACCESS_KEY → "Access key"')
  assert(envVarFieldLabel(kling, 'KLING_SECRET_KEY') === 'Secret key', 'field label: KLING_SECRET_KEY → "Secret key"')
  assert(envVarFieldLabel(claude, 'ANTHROPIC_API_KEY') === 'API key', 'single-var services label plainly as "API key"')
  assert(serviceKeyState(kling) === 'partial', 'one-of-two set → partial (never reads as done)')
  assert(serviceKeyState({ ...kling, env_vars: kling.env_vars.map((v) => ({ ...v, set: true })) }) === 'set', 'both set → set')
  assert(serviceKeyState(claude) === 'unset', 'none set → unset')
  assert(serviceKeyState(deepseek) === 'set', 'single var set → set')

  // ── 4. payload building ──
  const save = buildSavePayload(kling, { KLING_ACCESS_KEY: '  ak-123  ', KLING_SECRET_KEY: 'sk-456' })
  assert(!!save && save.values.KLING_ACCESS_KEY === 'ak-123', 'save payload trims pasted whitespace')
  assert(!!save && Object.keys(save.values).length === 2, 'save payload carries both typed kling vars')
  const partial = buildSavePayload(kling, { KLING_SECRET_KEY: 'sk-789' })
  assert(!!partial && Object.keys(partial.values).join(',') === 'KLING_SECRET_KEY', 'untyped fields are NOT sent (no clobbering an existing key with blank)')
  assert(buildSavePayload(kling, {}) === null, 'nothing typed → null (Save stays disabled)')
  assert(buildSavePayload(kling, { KLING_ACCESS_KEY: '   ' }) === null, 'whitespace-only → null')
  assert(buildSavePayload(kling, { NOT_A_KLING_VAR: 'x' } as Record<string, string>) === null, 'unknown var names never enter a payload (daemon would 400 anyway)')
  const clear = buildClearPayload(kling)
  assert(Object.keys(clear.values).length === 2 && clear.values.KLING_ACCESS_KEY === '' && clear.values.KLING_SECRET_KEY === '', 'clear payload = "" for EVERY var (explicit-clear semantics)')
  assert(buildClearPayload(claude).values.ANTHROPIC_API_KEY === '', 'single-var clear payload')

  // ── 5. never-prefill: booleans only, no value-shaped fields ──
  const blob = JSON.stringify(services)
  assert(!/"value"/.test(blob) && !/"key_value"/.test(blob) && !/"prefix"/.test(blob), 'coerced DTOs carry no value/prefix fields — nothing to prefill FROM')
  for (const svc of services) {
    assert(
      svc.env_vars.every((v) => typeof v.set === 'boolean'),
      `${svc.id}: env-var state is a boolean, never a secret`
    )
  }

  // ── 6. paths + Config-tab registry wiring ──
  assert(keysPutPath('kling-video') === '/api/providers/keys/kling-video', 'PUT path shape')
  assert(keysPutPath('a/b') === '/api/providers/keys/a%2Fb', 'PUT path encodes the service id')
  assert(isAllowedDaemonPath(KEYS_CATALOG_PATH), 'catalog path is bridge-allowlisted')
  assert(isAllowedDaemonPath(keysPutPath('deepseek')), 'PUT path is bridge-allowlisted')
  const modelsTab = CONFIG_TABS.find((t) => t.id === 'models')
  assert(!!modelsTab && modelsTab.path === KEYS_CATALOG_PATH, 'Config tab "models" registered over the catalog path')
  assert(CONFIG_TABS[0]?.id === 'models', 'Models is the FIRST Config tab (the friendly one)')
  assert(
    // A tab is daemon-backed (path must be allowlisted) or LOCAL-ONLY (path ''). Skin is the
    // second kind — the plate is a renderer setting, so there is nothing to fetch and a path
    // would only invent a way to fail. A non-empty path that is not allowlisted still fails.
    CONFIG_TABS.every((t) => t.path === '' || isAllowedDaemonPath(t.path)),
    'every daemon-backed Config tab path stays bridge-allowlisted; a local-only tab declares none'
  )

  // ── count guard ──
  if (checks !== EXPECTED) {
    console.error(`[model-keys-smoke] FAIL — ran ${checks} checks, expected ${EXPECTED} (a section silently skipped?)`)
    process.exit(1)
  }
  if (failures > 0) {
    console.error(`[model-keys-smoke] ${failures}/${checks} checks FAILED`)
    process.exit(1)
  }
  console.log(`[model-keys-smoke] all ${checks} checks passed`)
}

main()
