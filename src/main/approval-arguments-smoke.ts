/**
 * Approval arguments smoke (headless / ELECTRON_RUN_AS_NODE): the card shows what a request's arguments are, and says when the
 * person is NOT seeing all of them.
 *
 * The arguments are the agent's own words, chosen by a model that may have been steered by something it read. The daemon masks and
 * cuts them (`permissions/argument_view.py`); it does not make them honest. So this holds, against what a REAL Prometheus sends
 * (src/main/fixtures/approval_arguments.json, recorded by scripts/record-approval-arguments.py from the daemon's own approval queue
 * and /api/approvals route; nothing in it is written by hand):
 *
 *   * the daemon's text is shown as it wrote it, in its order, and only a character that does not draw is changed (written out);
 *   * a value the daemon cut, a value it masked, and arguments it left out are each recognised by the daemon's own markers, and any
 *     of them makes the card say, before the text, that the whole call is not shown;
 *   * the daemon's "left out" sentence counts only in its exact words: an argument the agent named like it is an argument;
 *   * a request that carries `arguments_cut` is believed, with or without arguments.
 */
import fixture from './fixtures/approval_arguments.json'
import { readFileSync } from 'node:fs'
import { INCOMPLETE_NOTICE, INVISIBLES_NOTICE, coerceArguments, describeArguments, writeOutInvisibles } from '@shared/approval-arguments'
import { rawToApproval, type RawApprovalPush } from '@shared/approval-push'

const EXPECTED = 45
let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: unknown): void {
  checks++
  console.log(`[approval-arguments-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
  if (!cond) failures++
}
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.log(`[approval-arguments-smoke] FAIL  ${checks} checks ran, expected ${EXPECTED}`)
    failures++
  }
  console.log(failures === 0 ? `[approval-arguments-smoke] PASS (${checks} checks)` : `[approval-arguments-smoke] ${failures} FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
})

type Listed = { description: string; arguments: Record<string, string> | null } & Record<string, unknown>
const listed = fixture.list as Listed[]
const named = fixture.calls as Record<string, string>
// The daemon lists requests in the order they were filed, which is the order of `calls` (several share a description).
const byCall = (call: string): Listed => listed[Object.keys(named).indexOf(call)]
const viewOf = (call: string) => {
  const a = rawToApproval(byCall(call) as unknown as RawApprovalPush)
  return { approval: a, view: a ? describeArguments(a.arguments, a.argumentsCut) : null }
}

assert(typeof fixture.made_from === 'string' && fixture.made_from !== 'unknown' && listed.length === 9, 'the fixture says which daemon it came from, and holds the nine calls', fixture.made_from)
assert(Object.keys(named).every((call) => byCall(call).description === named[call]), 'and each call is found at its place in the daemon\'s list')
assert(listed.every((r) => !('arguments_cut' in r)), "today's daemon sends no arguments_cut: what the card flags comes from the daemon's own markers in the text")

// ── a call that fits ───────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const { approval, view } = viewOf('short')
  assert(!!view && view.lines.map((l) => l.key).join() === Object.keys(byCall('short').arguments ?? {}).join(), "the daemon's order of arguments is kept")
  assert(!!view && view.lines.every((l, i) => l.value === Object.values(approval?.arguments ?? {})[i]), "each value is the daemon's text, unchanged")
  assert(!!view && !view.incomplete && !view.hasInvisibles && view.lines.every((l) => !l.cut && !l.masked && !l.leftOut && !l.invisibles), 'a call that fits says nothing is missing')
}

// ── a value the daemon cut ─────────────────────────────────────────────────────────────────────────────────────────────────
{
  const { approval, view } = viewOf('long')
  const text = view?.lines[0]
  assert(!!text && text.cut && !text.masked, 'a value the daemon cut ("… (+1050 more chars)") is marked cut')
  assert(!!view && view.incomplete && !view.leftOut, 'and the whole call is said to be incomplete')
  assert(text?.value === approval?.arguments?.text, 'its text is exactly as the daemon sent it: no second cut, nothing added')
}

// ── a value the daemon masked ──────────────────────────────────────────────────────────────────────────────────────────────
{
  const { view } = viewOf('masked')
  const cmd = view?.lines[0]
  assert(!!cmd && cmd.masked && !cmd.cut && cmd.value.includes('Bearer ***'), 'a value with the daemon\'s mask in it is marked, and the mask is still shown')
  assert(!!view && view.incomplete, 'and the whole call is said to be incomplete')
}

// ── arguments left out ─────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const { view } = viewOf('many')
  const last = view?.lines[view.lines.length - 1]
  assert(!!view && view.leftOut && view.incomplete && last?.key === '…' && last.leftOut, "the daemon's \"(9 more argument(s) not shown)\" row is recognised, and kept in its place")
  assert(!!view && view.lines.slice(0, -1).every((l) => !l.leftOut && !l.cut && !l.masked), 'the rows before it are not marked')
}

// ── nothing to show ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const { approval, view } = viewOf('none')
  assert(approval?.arguments === undefined && view === null, 'a call with no arguments has nothing to show, and nothing to warn about')
  assert(describeArguments({}, undefined) === null, 'an empty map is the same')
}

// ── characters that do not draw ────────────────────────────────────────────────────────────────────────────────────────────
{
  const { view } = viewOf('odd')
  const path = view?.lines.find((l) => l.key === 'path')
  const content = view?.lines.find((l) => l.key === 'content')
  assert(path?.value === 'notes/⟨U+202E⟩txt.sh' && path.invisibles, 'a direction override in a path is written out, so the path cannot read as another')
  assert(content?.value === 'echo⟨U+200B⟩ hi' && content.invisibles, 'a zero-width space is written out and the visible text around it is untouched')
  assert(!!view && view.hasInvisibles && !view.incomplete, 'the card says so, and an unseen character alone does not claim that text was cut')
  const nl = viewOf('newline').view?.lines[0]
  assert(nl?.value === '[echo, one⟨U+A⟩two, three⟨U+D⟩four]' && nl.invisibles, 'a raw line break the daemon let through is written out, so one argument cannot pass for two lines')
}
assert(writeOutInvisibles('plain text, é, 漢字, emoji 🙂, and a ⏎ the daemon wrote') === 'plain text, é, 漢字, emoji 🙂, and a ⏎ the daemon wrote', 'visible text, accents, CJK, emoji and the daemon\'s own ⏎ are never touched')
assert(writeOutInvisibles('a b c﻿d‍e\u0000f\u007fg') === 'a⟨U+2028⟩b⟨U+2029⟩c⟨U+FEFF⟩d⟨U+200D⟩e⟨U+0⟩f⟨U+7F⟩g', 'line and paragraph separators, the byte-order mark, a joiner and control characters are written out')
assert(writeOutInvisibles('x⁦y⁩z؜w') === 'x⟨U+2066⟩y⟨U+2069⟩z⟨U+61C⟩w', 'direction isolates and the Arabic letter mark are written out')
{
  const view = describeArguments({ 'na‮me': 'v' }, undefined)
  assert(view?.lines[0].key === 'na⟨U+202E⟩me' && view.lines[0].invisibles, "an argument's NAME is written out too")
}

// ── the daemon's sentence counts only in its exact words ───────────────────────────────────────────────────────────────────
{
  const { view } = viewOf('impostor')
  const row = view?.lines.find((l) => l.key === '…')
  assert(!!row && !row.leftOut && !!view && !view.incomplete && !view.leftOut, 'an argument the agent named "…", in words of its own, is an argument: no warning')
  assert(view?.lines.map((l) => l.key).join() === 'command,…', 'and it is drawn in the daemon\'s order with the others')
  const form = (v: string): boolean => describeArguments({ '…': v }, undefined)?.leftOut === true
  assert(form('(12 more argument(s) not shown)') && form('(1 more argument(s) not shown)'), "the daemon's sentence, in its exact form, is believed")
  assert(!form('(12 more argument(s) not shown) and nothing else') && !form('(many more argument(s) not shown)') && !form(' (3 more argument(s) not shown)') && !form('(3 more arguments not shown)'), 'anything else, even close, is not')
  assert(describeArguments({ other: '(3 more argument(s) not shown)' }, undefined)?.leftOut === false, 'the sentence under another name is not the daemon speaking')
}

// ── a mask that took the cut marker's ellipsis is still a cut ────────────────────────────────────────────────────────────────
{
  const { view } = viewOf('maskcut')
  const url = view?.lines[0]
  assert(!!url && url.value.endsWith('?q=*** (+189 more chars)'), "the daemon's own output has no ellipsis left in front of the count here (mask first, cut after)", url?.value)
  assert(!!url && url.cut && url.masked && !!view && view.incomplete, 'so a value is cut when it ENDS with the count, and it is marked both cut and masked')
  const mid = describeArguments({ note: 'the phrase (+3 more chars) is in the middle of this' }, undefined)
  assert(mid?.lines[0].cut === false && mid.incomplete === false, 'the same words in the middle of a value are only words')
}

// ── a daemon that says it cut ──────────────────────────────────────────────────────────────────────────────────────────────
{
  const raw = (extra: Record<string, unknown>): RawApprovalPush => ({ request_id: 'x1', tool_name: 'bash', description: 'd', created_at: 1, extents: {}, arguments: null, ...extra }) as RawApprovalPush
  const yes = rawToApproval(raw({ arguments_cut: true }))
  assert(yes?.argumentsCut === true, 'arguments_cut: true is carried through')
  const none = describeArguments(yes?.arguments, yes?.argumentsCut)
  assert(!!none && none.lines.length === 0 && none.daemonSaysCut && none.incomplete, 'and said on the card even when no arguments came with it')
  const withArgs = describeArguments({ command: 'ls' }, true)
  assert(!!withArgs && withArgs.incomplete && withArgs.lines.every((l) => !l.cut), 'and the whole call is said to be incomplete when the daemon says so, whatever the text shows')
  assert([false, 'true', 1, null, undefined, {}].every((v) => rawToApproval(raw({ arguments_cut: v }))?.argumentsCut === undefined), 'anything but a plain true is not a claim')
}

// ── an argument with a name that is special to JavaScript ───────────────────────────────────────────────────────────────────
{
  const wire = JSON.parse('{"__proto__":"rm -rf /","command":"ls","constructor":"x","toString":"y"}')
  const kept = coerceArguments(wire)
  assert(!!kept && Object.keys(kept).join() === '__proto__,command,constructor,toString' && kept['__proto__'] === 'rm -rf /', 'an argument named __proto__ (or constructor, toString) is kept like any other: dropping one would hide it from the person approving')
  const approval = rawToApproval({ request_id: 'p1', tool_name: 'bash', description: 'd', created_at: 1, extents: {}, arguments: wire } as unknown as RawApprovalPush)
  const view = describeArguments(approval?.arguments, undefined)
  assert(!!view && view.lines.map((l) => `${l.key}=${l.value}`).join('|') === '__proto__=rm -rf /|command=ls|constructor=x|toString=y', 'and it reaches the card with its name and value, in the order sent')
  assert(JSON.stringify(coerceArguments({ a: 5, b: null, c: ['x'] })) === '{"a":"5","b":"null","c":"[\\"x\\"]"}', 'a value that is not text is still shown, as the JSON it arrived as (unchanged behaviour)')
}

// ── the words, and what the card does with them ────────────────────────────────────────────────────────────────────────────
assert(!/secret|protect|safe|hidden for your/i.test(INCOMPLETE_NOTICE + INVISIBLES_NOTICE), 'the notices never say that something was kept safe: what is missing may be the part that matters')
assert(INCOMPLETE_NOTICE.startsWith('Prometheus cut or hid part of this.') && /not seeing the whole call/.test(INCOMPLETE_NOTICE), 'the incomplete notice says who cut it and that the whole call is not shown')
const card = readFileSync(new URL('../../src/renderer/src/components/ExecApprovalCard.tsx', import.meta.url), 'utf8')
assert(/describeArguments\(approval\.arguments, approval\.argumentsCut\)/.test(card) && !/Object\.entries\(approval\.arguments/.test(card), 'the card draws what describeArguments gives, not the raw map')
assert(/data-testid="approval-args-incomplete"/.test(card) && /data-testid="approval-args-invisibles"/.test(card) && /\{INCOMPLETE_NOTICE\}/.test(card) && /\{INVISIBLES_NOTICE\}/.test(card), 'the card has both notices')
assert(card.indexOf('approval-args-incomplete') < card.indexOf('style={argsInset}'), 'the notice comes BEFORE the arguments, outside the part that scrolls')
assert(/CUT/.test(card) && /PART HIDDEN/.test(card) && /LEFT OUT/.test(card) && /ODD CHARACTERS/.test(card), 'each kind of line is tagged in words')
assert(!/\.slice\(|\.substring\(|\.substr\(/.test(card.slice(card.indexOf('approval.arguments'))), 'the card never cuts a value itself')
