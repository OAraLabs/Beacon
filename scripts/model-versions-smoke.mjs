#!/usr/bin/env node
// Config → Models version-picker contract. Beacon has no DOM test framework (same
// approach as context-meter-smoke.mjs), so the LOGIC lives in @shared and is asserted here.
//
// THE INVARIANT: a provider's alternates are VISIBLE on the Models tab, and the
// default stays identifiable among them.
//
// Prometheus #542 turned one-model-per-provider into 1–5 versions each. The tab
// rendered `svc.default_model` — a single string — so every alternate was
// selectable from the composer and invisible here. Both directions are asserted: the
// alternates must come through, AND the default must still be marked, because a
// helper that returned every row undifferentiated would satisfy the first half alone.
//
// The fixture is the REAL body shape from the live daemon (bfa2701), including the
// colon-in-model-name case that a naive split() would corrupt.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'

const srcPath = join(process.cwd(), 'src/shared/model-versions.ts')
const js = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const out = join(mkdtempSync(join(tmpdir(), 'beacon-mv-')), 'model-versions.mjs')
writeFileSync(out, js)
const {
  splitCatalogKey, catalogVersions, versionsFor, hasVersionChoice, usageHint, catalogNoteSummary
} = await import(out)

let failures = 0
const check = (label, cond, detail) => {
  if (cond) return
  failures += 1
  console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
}

// Real shape, trimmed — daemon bfa2701.
const BODY = {
  default_key: 'local',
  catalog_note: {
    defaults_not_limits: true,
    summary: 'These are defaults, not limits. The model name in prometheus.yaml is free-form.'
  },
  models: [
    { key: 'local', model: '/models/Qwen3.8-27B.gguf', provider: 'llama_cpp', available: true },
    { key: 'gpu_ollama', model: 'qwen3.5:9b', provider: 'ollama', available: true },
    { key: 'gpu_ollama:qwen2.5:7b-instruct', model: 'qwen2.5:7b-instruct', provider: 'ollama', available: true },
    { key: 'qwen', model: 'qwen3.8-max', provider: 'qwen', available: true },
    { key: 'qwen:qwen3.8-flash', model: 'qwen3.8-flash', provider: 'qwen', available: true },
    { key: 'qwen:qwen3.7-plus', model: 'qwen3.7-plus', provider: 'qwen', available: true },
    { key: 'xai', model: 'grok-4.5', provider: 'xai', available: true },
    { key: 'glm', model: 'glm-5.3', provider: 'glm', available: false },
    { key: 'glm:glm-5.3-flash', model: 'glm-5.3-flash', provider: 'glm', available: false }
  ]
}

const idx = catalogVersions(BODY)

// --- the alternates are visible at all (the whole point) -------------------
const qwen = versionsFor(idx, 'qwen')
check('qwen exposes all three versions', qwen.length === 3, `got ${qwen.length}: ${qwen.map((v) => v.model).join(', ')}`)
check('qwen3.8-flash is present', qwen.some((v) => v.model === 'qwen3.8-flash'),
  'the model this whole release was asked about must appear in the picker')

// --- ...AND the default is still identifiable among them -------------------
check('default is first', qwen[0]?.model === 'qwen3.8-max', `first was ${qwen[0]?.model}`)
check('exactly one default', qwen.filter((v) => v.isDefault).length === 1)
check('alternates are not marked default', qwen.filter((v) => !v.isDefault).length === 2)

// --- a colon INSIDE a model name must round-trip ---------------------------
check('first-colon split only', splitCatalogKey('gpu_ollama:qwen2.5:7b-instruct').model === 'qwen2.5:7b-instruct',
  'a model name containing a colon was truncated — split on the FIRST separator only')
const oll = versionsFor(idx, 'gpu_ollama')
check('ollama variant keeps its full name', oll.some((v) => v.model === 'qwen2.5:7b-instruct'))

// --- one version is NOT a choice -------------------------------------------
check('xai is not a choice', !hasVersionChoice(versionsFor(idx, 'xai')),
  'xai is single-entry ON PURPOSE (aliases are silently served as grok-4.3); a one-item dropdown is worse than the plain string')
check('qwen IS a choice', hasVersionChoice(qwen))
check('unknown provider is not a choice', !hasVersionChoice(versionsFor(idx, 'wan-image')),
  'the media services have no catalog entries and must render as before')

// --- availability is the PRESET's, not the row's ---------------------------
check('an unavailable provider still lists versions', versionsFor(idx, 'glm').length === 2,
  'available:false means NO KEY, not unusable — the versions must still be visible')

// --- the payoff: how to actually use a pick --------------------------------
check('alternate hint names the model', usageHint('qwen', qwen[1]) === `/qwen ${qwen[1].model}`)
check('default hint is bare', usageHint('qwen', qwen[0]) === '/qwen',
  'a bare /qwen already means the default — repeating the model would teach the wrong thing')

// --- the daemon's own words -------------------------------------------------
check('catalog note is read', (catalogNoteSummary(BODY) ?? '').startsWith('These are defaults, not limits'))

// --- old daemon / junk degrades to no picker, never a crash ----------------
for (const [label, bad] of [['null', null], ['no models', {}], ['models not array', { models: 'x' }],
                            ['junk rows', { models: [null, 7, {}, { key: 'a' }] }]]) {
  let threw = null
  try { catalogVersions(bad) } catch (e) { threw = e }
  check(`degrades on ${label}`, threw === null, String(threw))
}
check('junk rows yield nothing', Object.keys(catalogVersions({ models: [null, 7, {}, { key: 'a' }] })).length === 0,
  'a row without a usable model must not become a phantom version')
check('old daemon has no note', catalogNoteSummary({}) === null)

if (failures > 0) {
  console.error(`\nmodel-versions smoke: ${failures} failure(s)`)
  process.exit(1)
}
console.log('model-versions smoke: OK — alternates visible, default marked, single-entry left alone')
