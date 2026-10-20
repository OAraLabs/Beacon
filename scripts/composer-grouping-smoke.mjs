#!/usr/bin/env node
// Composer model-picker grouping contract. No DOM test framework here (same approach as
// context-meter-smoke.mjs), so the LOGIC lives in @shared and is asserted here.
//
// THE INVARIANT: the menu is organised BY VENDOR, and organising it does not reorder
// what the daemon put first.
//
// Prometheus PR 542 gave every preset its own versions. The picker grouped only
// local-vs-cloud, so the cloud half became a ~28-row flat scroll: each vendor's models
// were adjacent but unmarked, and finding "the Qwen ones" meant reading every line.
//
// Both directions are asserted: vendors must come out as groups, AND each group must
// still lead with the daemon's default — a grouper that sorted alphabetically would
// satisfy "grouped" while burying the row the bare /qwen actually gives you.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'

const srcPath = join(process.cwd(), 'src/shared/composer-controls.ts')
const js = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const out = join(mkdtempSync(join(tmpdir(), 'beacon-cg-')), 'composer-controls.mjs')
writeFileSync(out, js)
const { groupByVendor, vendorHeadingsHelp, splitOptionKey, groupOptions } = await import(out)

let failures = 0
const check = (label, cond, detail) => {
  if (cond) return
  failures += 1
  console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
}

// Real shape and real ORDER from the live daemon (bfa2701).
const MODELS = [
  { key: 'local', label: 'Local', model: '/models/Qwen3.8-27B.gguf', backend: 'local' },
  { key: 'mini', label: 'mini · qwen2.5:14b-inst', model: 'qwen2.5:14b-instruct', backend: 'mini' },
  { key: 'mini:qwen2.5:7b-instruct', label: 'mini · qwen2.5:7b-inst', model: 'qwen2.5:7b-instruct', backend: 'mini' },
  { key: 'claude', label: 'Claude · claude-sonnet-5', model: 'claude-sonnet-5', provider: 'anthropic' },
  { key: 'claude:claude-opus-5', label: 'Claude · claude-opus-5', model: 'claude-opus-5', provider: 'anthropic' },
  { key: 'xai', label: 'xAI', model: 'grok-4.5', provider: 'xai' },
  { key: 'qwen', label: 'Qwen · qwen3.8-max', model: 'qwen3.8-max', provider: 'qwen' },
  { key: 'qwen:qwen3.8-flash', label: 'Qwen · qwen3.8-flash', model: 'qwen3.8-flash', provider: 'qwen' }
]

const groups = groupByVendor(MODELS)
const byId = Object.fromEntries(groups.map((g) => [g.id, g]))

// --- it actually groups ----------------------------------------------------
check('one group per vendor/box', groups.length === 5, `got ${groups.length}: ${groups.map((g) => g.id).join(', ')}`)
check('qwen versions are together', byId.qwen?.options.length === 2)
check('claude versions are together', byId.claude?.options.length === 2)
check('backend variants group with their box', byId.mini?.options.length === 2,
  'mini and mini:<variant> are the same box and must not appear as two vendors')

// --- ...AND the daemon's order survives ------------------------------------
check('qwen leads with the default', byId.qwen?.options[0]?.model === 'qwen3.8-max',
  `led with ${byId.qwen?.options[0]?.model} — alphabetical sorting would bury what bare /qwen gives you`)
check('claude leads with the default', byId.claude?.options[0]?.model === 'claude-sonnet-5')
check('group order is first-appearance', groups.map((g) => g.id).join(',') === 'local,mini,claude,xai,qwen',
  `got ${groups.map((g) => g.id).join(',')} — the daemon decides what leads, not this function`)

// --- headings that read as the vendor, not the key -------------------------
check('vendor heading strips the model', byId.claude?.label === 'Claude', `got ${byId.claude?.label}`)
check('single-version vendor keeps its name', byId.xai?.label === 'xAI', `got ${byId.xai?.label}`)
check('backend heads with its box name', byId.mini?.label === 'mini', `got ${byId.mini?.label}`)

// --- a colon INSIDE a model name must not split a group --------------------
check('first-colon split only', splitOptionKey('gpu_ollama:qwen2.5:7b-instruct').model === 'qwen2.5:7b-instruct')

// --- one group is not an organisation --------------------------------------
check('headings help when there are several', vendorHeadingsHelp(groups))
check('headings do NOT help for one', !vendorHeadingsHelp(groupByVendor([MODELS[5]])),
  'a lone heading adds a line and distinguishes nothing')

// --- the existing local/cloud split is untouched ----------------------------
const split = groupOptions(MODELS, 'local')
check('local/cloud split still works', split.local.length === 3 && split.cloud.length === 5,
  `local=${split.local.length} cloud=${split.cloud.length}`)

// --- degrades, never crashes ------------------------------------------------
for (const [label, bad] of [['empty', []], ['no label', [{ key: 'x' }]], ['blank label', [{ key: 'y', label: '' }]]]) {
  let threw = null
  try { groupByVendor(bad) } catch (e) { threw = e }
  check(`degrades on ${label}`, threw === null, String(threw))
}
check('missing label falls back to the id', groupByVendor([{ key: 'zz' }])[0]?.label === 'zz',
  'a blank heading is worse than a technical one')

if (failures > 0) {
  console.error(`\ncomposer-grouping smoke: ${failures} failure(s)`)
  process.exit(1)
}
console.log('composer-grouping smoke: OK — grouped by vendor, daemon order preserved')
