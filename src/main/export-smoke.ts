/**
 * Headless smoke for conversation export. Pure model only — the two renderers and the filename.
 * Writing to disk is exercised hands-on; what this pins is that the OUTPUT says what happened.
 *
 * Run: npm run smoke:export
 */
import { EXPORT_SCHEMA, exportFilename, renderExport, toJson, toMarkdown, type ExportableMessage, type ExportMeta } from '@shared/session-export'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

const META: ExportMeta = {
  sessionId: 'telegram:5521',
  title: 'Beacon voice spec',
  gateway: 'telegram',
  exportedAt: Date.parse('2026-08-27T14:30:00Z'),
  appVersion: '0.2.0'
}

// Rows as the CACHE holds them: content_json is a JSON STRING of daemon blocks (not an object),
// which is the shape partsFromContentJson exists to read.
const ROWS: ExportableMessage[] = [
  { rowId: 8871, role: 'user', content: 'does voice work?', createdAt: Date.parse('2026-08-27T14:00:00Z') },
  {
    rowId: 8872,
    role: 'assistant',
    content: '',
    contentJson: JSON.stringify([
      { type: 'text', text: 'Checking the bridge.' },
      { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'systemctl status oara-middleware', timeout: 30 } }
    ]),
    createdAt: Date.parse('2026-08-27T14:01:00Z')
  },
  {
    rowId: 8873,
    role: 'user',
    content: '',
    contentJson: JSON.stringify([{ type: 'tool_result', tool_use_id: 'tu_1', content: 'active (running)' }]),
    createdAt: Date.parse('2026-08-27T14:01:02Z')
  },
  { rowId: 8874, role: 'assistant', content: 'Yes — the middleware is up.', createdAt: Date.parse('2026-08-27T14:01:05Z') },
  // The blank-bubble class: persisted plumbing with no text and no tool call.
  { rowId: 8875, role: 'assistant', content: '', contentJson: null, createdAt: Date.parse('2026-08-27T14:01:06Z') }
]

console.log('[smoke] === 1. markdown is for a person ===')
const md = toMarkdown(META, ROWS)
assert(md.startsWith('# Beacon voice spec'), 'titled with the conversation, not its id')
assert(md.includes('`telegram:5521`'), 'the session id is still recorded in the header')
assert(md.includes('2026-08-27T14:30:00Z'), 'the export timestamp is the moment it was TAKEN')
assert(md.includes('Beacon 0.2.0'), 'the app version that wrote it is recorded')
assert(md.includes('### You · 2026-08-27 14:00 UTC'), 'roles read as people, with a readable stamp')
// A bare stamp is read as local time by whoever opens the file later. The app shows no
// per-message time at all, so there is nothing to contradict — but silence about the zone is
// how an export ends up five hours wrong and no one can tell.
assert(!/\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?! UTC)/.test(md), 'no timestamp appears without its zone')
assert(md.includes('Times are UTC'), 'and the header says so once, up front')
assert(md.includes('### Prometheus'), 'the agent is named, not left as "assistant"')
assert(md.includes('does voice work?') && md.includes('Yes — the middleware is up.'), 'both sides of the conversation survive')
assert(md.includes('_tool: bash(command, timeout)_'), 'a tool call is ONE line naming its arguments')
assert(!md.includes('systemctl status oara-middleware'), 'argument VALUES stay out of the readable format')
assert(/export as JSON/i.test(md), 'and it says where the full fidelity lives')
// The empty row must not become an empty heading — the app hides it, so the export does too.
assert(md.split('###').length - 1 === 3, `only rows with something to show get a heading (got ${md.split('###').length - 1})`)
assert(!/###[^\n]*\n\s*\n\s*###/.test(md), 'no heading is immediately followed by another — no blank turns')

console.log('[smoke] === 2. json is for a machine ===')
const parsed = JSON.parse(toJson(META, ROWS))
assert(parsed.schema === EXPORT_SCHEMA, `the envelope is versioned (schema ${parsed.schema})`)
assert(parsed.messages.length === ROWS.length, 'EVERY row is present, including the empty one — fidelity, not readability')
assert(parsed.messages[0].rowId === 8871, 'the durable rowid rides along so an export correlates back to the daemon')
assert(parsed.messages[1].toolCalls[0].name === 'bash', 'tool calls are structured')
assert(parsed.messages[1].toolCalls[0].args.command === 'systemctl status oara-middleware', 'with their FULL arguments — the opposite choice from markdown')
assert(parsed.messages[2].toolResults[0].output === 'active (running)', 'tool results carry their output')
assert(parsed.messages[2].toolResults[0].toolUseId === 'tu_1', 'and correlate to the call that produced them')
assert(parsed.messages[0].at === '2026-08-27T14:00:00Z', 'timestamps are ISO, second precision')
assert(parsed.session.id === 'telegram:5521' && parsed.session.gateway === 'telegram', 'the session is identified')

console.log('[smoke] === 3. degenerate input ===')
assert(toMarkdown(META, []).includes('**Messages:** 0'), 'an empty conversation exports as an empty conversation, and says 0')
assert(JSON.parse(toJson(META, [])).messages.length === 0, 'empty JSON export is valid JSON with no messages')
const noMeta = toMarkdown({ sessionId: 'x:1', exportedAt: META.exportedAt }, ROWS)
assert(noMeta.startsWith('# x:1'), 'no title falls back to the session id')
assert(!noMeta.includes('Gateway'), 'an absent gateway is omitted, not printed as undefined')
assert(JSON.parse(toJson({ sessionId: 'x:1', exportedAt: 0 }, ROWS)).session.title === null, 'a missing title is null in JSON, never the string "undefined"')
assert(renderExport('json', META, ROWS) === toJson(META, ROWS) && renderExport('markdown', META, ROWS) === md, 'one entry point cannot diverge from the two renderers')

console.log('[smoke] === 4. filenames are safe ===')
const f = exportFilename('telegram:5521', 'markdown', META.exportedAt)
assert(f === 'beacon-telegram-5521-20260827-1430.md', `id is sanitized and stamped (${f})`)
assert(!exportFilename('a/b:c', 'json', META.exportedAt).includes('/'), 'a slash in a session id can never become a path separator')
assert(exportFilename('../../etc/passwd', 'json', META.exportedAt).indexOf('..') === -1, 'traversal cannot survive sanitization')
assert(exportFilename('', 'json', META.exportedAt).startsWith('beacon-session-'), 'an empty id still yields a usable name')
assert(exportFilename('x'.repeat(200), 'markdown', META.exportedAt).length < 100, 'an absurd id is truncated, not passed to the filesystem')
assert(exportFilename('a:1', 'json', META.exportedAt).endsWith('.json'), 'the extension follows the format')

console.log('')
console.log('[smoke] ===================== RESULT =====================')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (markdown, json, degenerate input, filenames)`)
console.log('[smoke] ===================================================')
process.exit(failures === 0 ? 0 : 1)
