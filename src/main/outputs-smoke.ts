// Headless smoke for what a conversation produced (@shared/outputs).
// ELECTRON_RUN_AS_NODE electron out/main/outputs-smoke.js — no daemon, no React.
//
// THE POINT OF THIS FILE: "Outputs" must never become a list of things this conversation did not
// produce. The tempting source — the artifacts outbox — is a flat directory with no producer field,
// and Beacon's existing association with a conversation is a SUBSTRING MATCH on message text. So
// the only rows here come from the agent's own tool calls in this session's transcript, and these
// assertions exist to keep it that way.
//
// The fixture is CAPTURED from the live daemon — the BC-7 dispatch that proved the Task-ID filename
// convention. One real write_file, in the daemon's actual shape.

import {
  FILE_WRITING_TOOLS,
  OUTPUTS_EMPTY,
  baseName,
  producedFiles,
  type OutputMessage
} from '@shared/outputs'
import { taskIdFromText } from '@shared/plan'
import capture from './fixtures/outputs-capture-beacon-plan-keyed-probe.json'

let failures = 0
let checks = 0
function check(name: string, cond: boolean): void {
  checks++
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}

const doc = capture as { _header: { captured: boolean; sha256: string }; payload: unknown }
const payload = doc.payload as { messages?: OutputMessage[] }
const MESSAGES: OutputMessage[] = payload.messages ?? []

console.log('[fixture] captured from the live daemon, not written')
check('the fixture declares its provenance', doc._header.captured === true && doc._header.sha256.length === 64)
check('it is a real conversation with several messages', MESSAGES.length >= 3)

console.log('\n[produced] the real capture')
{
  const out = producedFiles(MESSAGES)
  check('exactly one file was produced in this conversation', out.length === 1)
  check('and it is the plan the dispatch actually wrote',
    out[0]?.path === '/home/demo/.prometheus/documents/loops/BC-7-checklist-panel-rollout.md')
  check('the tool is recorded, so a row need not guess written-vs-edited', out[0]?.tool === 'write_file')
  check('baseName survives a daemon-absolute path', baseName(out[0]!.path) === 'BC-7-checklist-panel-rollout.md')
}

console.log('\n[scope] a READ is not an output')
{
  // The discipline that keeps this list honest: read_file and list_files also carry a `path`, so
  // "has a path" would report reads as things the conversation produced.
  const reads: OutputMessage[] = [{
    content_json: JSON.stringify([{ type: 'tool_use', id: 'a', name: 'read_file', input: { path: '/etc/hosts' } }]),
    ordinal: 1
  }]
  check('read_file produces nothing', producedFiles(reads).length === 0)
  check('the allow-list is small and explicit, not a pattern',
    FILE_WRITING_TOOLS.length === 2 && FILE_WRITING_TOOLS.includes('write_file') && FILE_WRITING_TOOLS.includes('edit_file'))
  // Prometheus#507: the MODULE is file_write, the TOOL is write_file. Matching the module name is
  // the transposition that made the documents tree unreachable for weeks.
  check('the module spelling file_write is NOT treated as a tool', !FILE_WRITING_TOOLS.includes('file_write'))
  const moduleNamed: OutputMessage[] = [{
    content_json: JSON.stringify([{ type: 'tool_use', id: 'b', name: 'file_write', input: { path: '/x.md' } }]),
    ordinal: 1
  }]
  check('and a call by that name produces nothing', producedFiles(moduleNamed).length === 0)
}

console.log('\n[fold] one row per path, newest tool wins')
{
  const twice: OutputMessage[] = [
    { content_json: JSON.stringify([{ type: 'tool_use', id: 'a', name: 'write_file', input: { path: '/p/a.md' } }]), ordinal: 1 },
    { content_json: JSON.stringify([{ type: 'tool_use', id: 'b', name: 'write_file', input: { path: '/p/b.md' } }]), ordinal: 2 },
    { content_json: JSON.stringify([{ type: 'tool_use', id: 'c', name: 'edit_file', input: { path: '/p/a.md' } }]), ordinal: 3 }
  ]
  const out = producedFiles(twice)
  check('writing the same file twice is ONE output', out.length === 2)
  check('and the last call decides the tool shown', out.find((f) => f.path === '/p/a.md')?.tool === 'edit_file')
  check('order is oldest first by the call that last touched it', out.map((f) => f.path).join(' ') === '/p/b.md /p/a.md')
}

console.log('\n[honest] nothing renders as a blank row')
{
  const noPath: OutputMessage[] = [{
    content_json: JSON.stringify([{ type: 'tool_use', id: 'a', name: 'write_file', input: {} }]),
    ordinal: 1
  }]
  check('a write with no readable path is dropped, not rendered empty', producedFiles(noPath).length === 0)
  check('a message with no content_json at all is survivable', producedFiles([{ content: 'hi', ordinal: 1 }]).length === 0)
  check('an empty conversation produces an empty list', producedFiles([]).length === 0)
}

console.log('\n[empty state] named after the REASON, not the absence')
{
  check('it does not say "no outputs yet"', !/no outputs yet/i.test(OUTPUTS_EMPTY.noneInThisConversation))
  check('it says where the agent\'s published files actually went',
    OUTPUTS_EMPTY.noneInThisConversation.includes('shared') &&
    OUTPUTS_EMPTY.noneInThisConversation.includes('Artifacts'))
  check('and why they are not listed here — no record of which conversation made them',
    OUTPUTS_EMPTY.noneInThisConversation.includes('no record of which one'))
  check('the no-conversation case is its own sentence', OUTPUTS_EMPTY.noConversation.includes('Open one'))
}

console.log('\n[task id] the story a conversation is about, from its own transcript')
{
  // Pinned against the CAPTURED dispatch, not a hand-written string: this pattern transcribes a
  // contract owned by Prometheus (_TASK_ID_LABEL), so the fixture is the only thing that would
  // notice the daemon rewording it.
  const dispatched = MESSAGES.map((m) => (m as { content?: string }).content ?? '').join('\n')
  check('the captured dispatch yields its story id', taskIdFromText(dispatched) === 'BC-7')
  check('a conversation nobody dispatched yields null', taskIdFromText('just some chat') === null)
  check('empty and missing input are survivable', taskIdFromText('') === null && taskIdFromText(null) === null)
  check('the line must be the WHOLE line — prose mentioning it does not count',
    taskIdFromText('we talked about _Task ID: BC-9_ earlier in passing and then said more') === null)
  check('dispatched twice → the LATER task wins',
    taskIdFromText('_Task ID: BC-1_\nmiddle\n_Task ID: BC-2_') === 'BC-2')
}

// A count guard: a smoke that only counts FAILURES cannot tell "all passed" from "that section
// never ran".
const EXPECTED = 26
check(`count guard: ${checks + 1} checks ran (expected ${EXPECTED})`, checks + 1 === EXPECTED)

console.log(failures === 0 ? '\n[outputs-smoke] PASS' : `\n[outputs-smoke] FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
