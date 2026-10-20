// Headless adapter test (ELECTRON_RUN_AS_NODE electron out/main/parts-smoke.js).
// Proves the content_json → ContentPart[] adapter: each daemon block type maps correctly, the
// tool_result correlates to its tool_use via tool_use_id (history analog of the live call_id),
// and null/invalid/legacy content_json falls back to flat content. Pure — no React, no DOM.

import { partsFromContentJson, type ContentPart } from '@shared/parts'

let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}
const j = (v: unknown): string => JSON.stringify(v)

console.log('content_json → ContentPart[] adapter:')

// text {type:"text",text} → text {text}
{
  const p = partsFromContentJson(j([{ type: 'text', text: 'hello' }]), '')
  check('text → text part', p.length === 1 && p[0].type === 'text' && p[0].text === 'hello')
}

// tool_use {id,name,input} → toolCall {id,name,args:input}
{
  const p = partsFromContentJson(j([{ type: 'tool_use', id: 'toolu_1', name: 'sessions_list', input: { a: 1 } }]), '')
  const c = p[0]
  check(
    'tool_use → toolCall {id,name,args:input}',
    p.length === 1 && c.type === 'toolCall' && c.id === 'toolu_1' && c.name === 'sessions_list' && j(c.args) === j({ a: 1 })
  )
}

// tool_result {tool_use_id,content,is_error} → toolResult {toolUseId,output:content,error:is_error}
{
  const p = partsFromContentJson(j([{ type: 'tool_result', tool_use_id: 'toolu_1', content: '42 sessions', is_error: false }]), '')
  const c = p[0]
  check(
    'tool_result → toolResult {toolUseId,output,error}',
    p.length === 1 && c.type === 'toolResult' && c.toolUseId === 'toolu_1' && c.output === '42 sessions' && c.error === false
  )
}

// tool_use_id correlation: a result's toolUseId equals its call's id (history analog of call_id)
{
  const p = partsFromContentJson(
    j([
      { type: 'tool_use', id: 'toolu_X', name: 'grep', input: { q: 'x' } },
      { type: 'tool_result', tool_use_id: 'toolu_X', content: 'done', is_error: false }
    ]),
    ''
  )
  const call = p.find((x: ContentPart) => x.type === 'toolCall')
  const res = p.find((x: ContentPart) => x.type === 'toolResult')
  check('result correlates to call via tool_use_id', !!call && !!res && res!.toolUseId === call!.id && call!.id === 'toolu_X')
}

// is_error true → error true; non-string tool_result content is JSON-stringified
{
  const p = partsFromContentJson(j([{ type: 'tool_result', tool_use_id: 't', content: { rows: 3 }, is_error: true }]), '')
  check('is_error true + object content', p[0].type === 'toolResult' && p[0].error === true && p[0].output === j({ rows: 3 }))
}

// mixed multi-part turn preserves order: text then tool_use
{
  const p = partsFromContentJson(
    j([
      { type: 'text', text: 'let me check' },
      { type: 'tool_use', id: 'toolu_2', name: 'web_search', input: { q: 'x' } }
    ]),
    ''
  )
  check('mixed text+tool_use → 2 parts, in order', p.length === 2 && p[0].type === 'text' && p[1].type === 'toolCall')
}

// null content_json (legacy row) → fall back to flat content as a text part
{
  const p = partsFromContentJson(null, 'flat fallback')
  check('null content_json → flat-content text part', p.length === 1 && p[0].type === 'text' && p[0].text === 'flat fallback')
}

// invalid JSON → flat-content fallback (never throws)
{
  const p = partsFromContentJson('{not valid json', 'flat')
  check('invalid JSON → flat fallback', p.length === 1 && p[0].text === 'flat')
}

// legacy empty row (null json + empty content) → [] (caller hides it)
{
  const p = partsFromContentJson(null, '')
  check('null json + empty content → empty parts (hidden)', p.length === 0)
}

// ── PARITY-PLAN B2: thinking blocks are a RENDERED type now, no longer dropped ──
{
  const p = partsFromContentJson(j([{ type: 'thinking', thinking: 'hmm, let me see' }, { type: 'text', text: 'the answer' }]), 'flat')
  check('thinking + text → both parts, in order', p.length === 2 && p[0].type === 'thinking' && p[0].text === 'hmm, let me see' && p[1].type === 'text')
  const r = partsFromContentJson(j([{ type: 'redacted_thinking', data: 'opaque' }, { type: 'text', text: 'answer' }]), 'flat')
  check('redacted_thinking → a redacted thinking part, its opaque data NOT surfaced', r.length === 2 && r[0].type === 'thinking' && r[0].redacted === true && r[0].text === undefined)
  const only = partsFromContentJson(j([{ type: 'thinking', thinking: 'hmm' }]), 'the visible reply')
  check('a thinking-ONLY turn still shows its flat text beside the disclosure', only.length === 2 && only[0].type === 'thinking' && only[1].type === 'text' && only[1].text === 'the visible reply')
  const empty = partsFromContentJson(j([{ type: 'thinking', thinking: '' }]), 'flat')
  check('an EMPTY thinking body is absent, not an empty reveal → flat fallback', empty.length === 1 && empty[0].type === 'text' && empty[0].text === 'flat')
}

// ── PARITY-PLAN B3: stored image blocks (Prometheus#278 shape) ──
{
  const withBytes = partsFromContentJson(j([{ type: 'image', media_type: 'image/jpeg', data: 'QUJD', source_path: null, description: null }]), 'flat')
  check('an image block that KEPT its bytes renders inline (data url, right mime)', withBytes.length === 1 && withBytes[0].type === 'image' && withBytes[0].dataUrl === 'data:image/jpeg;base64,QUJD')
  const ref = partsFromContentJson(j([{ type: 'image', media_type: 'image/png', data: '', source_path: '/files/x.png', description: 'a red square' }, { type: 'text', text: 'see above' }]), 'flat')
  check('a stripped block (source_path, no bytes) becomes a REFERENCE part with the description', ref.length === 2 && ref[0].type === 'image' && ref[0].dataUrl === undefined && ref[0].sourcePath === '/files/x.png' && ref[0].description === 'a red square')
  const noMime = partsFromContentJson(j([{ type: 'image', data: 'QUJD' }]), 'flat')
  check('a missing media_type defaults to png rather than a broken data url', noMime[0].dataUrl === 'data:image/png;base64,QUJD')
}

// a TRULY unknown block type is still dropped → flat fallback if nothing else
{
  const p = partsFromContentJson(j([{ type: 'server_tool_use', name: 'x' }]), 'flat')
  check('truly unknown block dropped → flat fallback', p.length === 1 && p[0].text === 'flat')
}

if (failures > 0) {
  console.error(`\n${failures} adapter check(s) FAILED`)
  process.exit(1)
}
console.log('\nparts adapter: ALL CHECKS PASSED')
