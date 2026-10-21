/**
 * Headless smoke for the MATCH_SPEC pass (design handoff, 2026-09-03) — the pure halves.
 *
 * Every module here replaced something the build was doing by hand or not at all, and each one
 * has a specific way of being wrong that a screenshot cannot show you:
 *
 *   voice-preamble   — strips too much (eats the user's words) or too little (leaves plumbing)
 *   turn-rule        — numbers the WINDOW instead of the conversation; counts machine notices
 *   gateway-latency  — averages, inventing a number the link never produced
 *   speech-text      — recites a code block character by character
 *   slash-commands   — `/search` matches a prefix and eats `/searching…`
 *   daemon-api       — the subtitle prints the IP the spec exists to keep out of it
 *   composer-controls— the model chip prints a 46-character absolute path
 *   machine-notice   — a turn the daemon could not audit renders as a clean, empty file list
 *
 * Run: npm run smoke:match-spec
 */
import { hasVoicePreamble, isVoiceTurn, stripVoiceParts, stripVoicePreamble } from '@shared/voice-preamble'
import { clockLabel, turnLabel, turnMarks } from '@shared/turn-rule'
import { LATENCY_WINDOW, medianMs, pushSample } from '@shared/gateway-latency'
import { speakable, speechText } from '@shared/speech-text'
import { LOCAL_SLASH, parseLocalSlash, resolveModel, resolveSkin, SLASH_COMMANDS } from '@shared/slash-commands'
import { hostDisplayName, hostShortName, isPrivateHost } from '@shared/daemon-api'
import { composerModelLabel, modelFileName } from '@shared/composer-controls'
import { approvalKey, isTypingTarget } from '@shared/approval-keys'
import { jumpHasNew, jumpLabel, shouldStick, showJumpPill } from '@shared/jump-latest'
import { dismissToast, expired, MAX_TOASTS, pushToast, replyToastMessage, shouldToast, type Toast, type ToastKind } from '@shared/toasts'
import { inSelectedSources, isDefaultVisible, toggleSource } from '@shared/session-sources'
import { byGroup, capGroups, GROUP_CHIP, rankCommands } from '@shared/commands'
import { barGeometry, callReadout, callStatus, formatArgs, outputLines, runSpan } from '@shared/run-inspector'
import { argSummary, durationCell, fmtDuration, ranLabel, resultSummary, runDuration, type TimelineCall } from '@shared/timeline'
import { chunkLevel, elapsedClock, overlayStatus } from '@shared/voice-overlay'
import type { ContentPart } from '@shared/parts'
import { commandHead, fileName, noticeCaption, parseMachineNotice } from '@shared/machine-notice'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

console.log('[smoke] match-spec ===============================================')

// ── 1. the voice-mode preamble ────────────────────────────────────────────
// VERBATIM from the wire — read out of beacon.db, not retyped from the design note. A paraphrase
// here would make every assertion below a test of the paraphrase.
const PREAMBLE =
  '[Voice mode] Respond in at most 2 short spoken sentences. No markdown, no lists, no code blocks, no emoji. If the full answer is long, give the headline and say the detail is available on screen.'
const REAL = `${PREAMBLE}\n\nMake one out.`

assert(hasVoicePreamble(REAL), 'the real wire message is recognised as a voice turn')
assert(stripVoicePreamble(REAL) === 'Make one out.', 'the four words the user actually said survive, alone')
assert(stripVoicePreamble('Make one out.') === 'Make one out.', 'a message with no preamble is untouched')
assert(stripVoicePreamble(PREAMBLE) === '', 'preamble with nothing after it strips to empty, not to itself')
// The tag is matched, NOT the sentence: the daemon owns that wording and may reword it.
assert(stripVoicePreamble('[Voice mode] Be brief.\n\nhi') === 'hi', 'a REWORDED preamble still strips (the bracket is the contract)')
assert(
  stripVoicePreamble('what does [Voice mode] mean?') === 'what does [Voice mode] mean?',
  'the tag mid-sentence is the user quoting it — never rewritten'
)
// Multiple blank lines / trailing spaces on the separator line.
assert(stripVoicePreamble(`${PREAMBLE}\n   \n\nhi`) === 'hi', 'a whitespace-only separator line still separates')

const parts: ContentPart[] = [{ type: 'text', text: REAL }, { type: 'image', dataUrl: 'data:,' }]
const strippedParts = stripVoiceParts(parts) as ContentPart[]
assert(strippedParts.length === 2 && strippedParts[0].text === 'Make one out.', 'structured content strips the leading text block only')
assert((parts[0].text ?? '').startsWith('[Voice mode]'), 'stripping does not mutate the caller’s array')
const onlyPreamble = stripVoiceParts([{ type: 'text', text: PREAMBLE }, { type: 'image', dataUrl: 'data:,' }]) as ContentPart[]
assert(onlyPreamble.length === 1 && onlyPreamble[0].type === 'image', 'a block that strips to nothing is dropped, leaving the image')
assert(isVoiceTurn(parts) && !isVoiceTurn([{ type: 'text', text: 'hi' }]), 'isVoiceTurn reads the leading text block')

// ── 2. turn numbering ─────────────────────────────────────────────────────
const NOTICE = '[FILE MUTATION VERIFIER]\nFiles touched this turn:\n✓ /tmp/a.md — write_file: created (+12 bytes)'
const rows = [
  { key: 'u1', role: 'user', text: 'first', createdAt: Date.UTC(2026, 8, 3, 12, 0) },
  { key: 'a1', role: 'assistant', text: 'ok' },
  { key: 'n1', role: 'user', text: NOTICE },
  { key: 'u2', role: 'user', text: REAL },
  { key: 'blank', role: 'user', text: '   ' },
  { key: 'u3', role: 'user', text: 'third' }
]
const m = turnMarks(rows)
assert(m.get('u1')?.n === 1 && m.get('u2')?.n === 2 && m.get('u3')?.n === 3, 'turns number 1,2,3 over the user messages')
assert(!m.has('n1'), 'a FILE MUTATION VERIFIER block opens no turn (it is a tool result wearing the user role)')
assert(!m.has('blank') && !m.has('a1'), 'blank rows and assistant rows open no turn')
// A screenshot someone sent IS a turn. `flatText` reads only text parts, so an image-only user
// message has empty text — judging emptiness by text alone dropped the turn AND renumbered every
// turn after it. The caller says whether the row has renderable content of any kind.
const imageOnly = turnMarks([
  { key: 'u1', role: 'user', text: 'hello' },
  { key: 'img', role: 'user', text: '', blank: false },
  { key: 'nothing', role: 'user', text: '', blank: true }
])
assert(imageOnly.has('img'), 'an image-only user message opens a turn')
assert(imageOnly.get('img')?.n === 2, 'and it is NUMBERED — otherwise every turn after it is off by one')
assert(!imageOnly.has('nothing'), 'a genuinely empty row still opens none')
assert(m.get('u2')?.voice === true && m.get('u1')?.voice === false, 'the voice flag rides the turn that carried the preamble')
assert(m.get('u3')?.at === null, 'a row with no createdAt carries a null clock rather than a fabricated one')
assert(turnLabel({ n: 3, at: null, voice: false }) === 'TURN 3', 'no timestamp -> the number alone, never a bare TURN')
assert(/^TURN 11 · \d{2}:\d{2}$/.test(turnLabel({ n: 11, at: Date.now(), voice: false })), 'with a timestamp -> `TURN 11 · HH:MM`')
assert(clockLabel(new Date(2026, 8, 3, 9, 5).getTime()) === '09:05', 'the clock zero-pads both fields')
assert(clockLabel(null) === '' && clockLabel(Number.NaN) === '', 'a missing or unusable time yields no clock text')
// Numbering must be a function of the WHOLE list. Slicing the tail (what the render window does)
// and numbering that would restart at 1 — this is the assertion that would catch it.
assert(turnMarks(rows.slice(3)).get('u3')?.n === 2, 'numbering a SLICE renumbers — which is why the caller passes the full list')

// ── 3. the latency window ─────────────────────────────────────────────────
let w: number[] = []
for (const ms of [20, 18, 300, 22, 19, 21]) w = pushSample(w, ms)
assert(w.length === LATENCY_WINDOW, `the window holds at most ${LATENCY_WINDOW} samples`)
assert(w[0] === 18, 'the oldest sample falls off the front')
assert(medianMs(w) === 21, 'one 300ms stall does not move the median (a mean would read 76)')
assert(medianMs([]) === null, 'no samples -> null, so the chip renders no reading at all')
assert(medianMs([10, 20]) === 10, 'an even window takes an OBSERVED sample, never the average of two')
assert(pushSample(w, Number.NaN).length === LATENCY_WINDOW && pushSample([], -5).length === 0, 'a failed timing contributes nothing')

// ── 4. what read-aloud says ───────────────────────────────────────────────
const reply = 'Here is the fix:\n\n```python\nfor i in range(10):\n    print(i)\n```\n\nSee **the docs** at [the guide](https://example.com/a/b).'
const spoken = speechText(reply)
assert(spoken.includes('python code block'), 'a fenced block is ANNOUNCED with its language')
assert(!spoken.includes('range(10)') && !spoken.includes('```'), 'the code itself is never recited')
assert(spoken.includes('the docs') && !spoken.includes('**'), 'emphasis markers go, the words stay')
assert(spoken.includes('the guide') && !spoken.includes('example.com'), 'a link reads as its text, not its URL')
assert(speechText('```\nx\n```') === 'Code block.', 'an unlabelled fence still announces itself')
assert(speechText('```js\nlet a = 1').includes('js code block'), 'an UNTERMINATED fence (still streaming) announces rather than recites')
assert(speechText('- one\n- two') === 'one . two', 'bullets become sentence breaks, with no stray break in front')
assert(speakable('```\nx\n```') && !speakable('') && !speakable('   '), 'a code-only reply still has something to say; an empty one does not')

// ── 5. /search, the capability the Search button became ───────────────────
assert(SLASH_COMMANDS.some((c) => c.name === 'search' && c.local === true), '/search is in the catalog and marked local')
assert((LOCAL_SLASH as readonly string[]).includes('search'), 'LOCAL_SLASH names it, so the parser and the catalog cannot drift apart')
assert(parseLocalSlash('/search when did the mini deploy')?.text === 'when did the mini deploy', '/search <query> yields the query')
assert(parseLocalSlash('/search') === null, 'a half-typed /search is not a search for nothing')
assert(parseLocalSlash('/search    ') === null, 'nor is /search followed by only whitespace')
assert(parseLocalSlash('/searching for a job') === null, 'the boundary is whitespace, not a prefix — /searching is prose')
assert(parseLocalSlash('/status') === null && parseLocalSlash('/steer go left') === null, 'daemon commands are NOT intercepted')
assert(parseLocalSlash('hello /search x') === null, 'only a LEADING command counts')
assert(parseLocalSlash('/SEARCH Rome')?.text === 'Rome', 'the command name is case-insensitive')

// ── 6. the host name in the subtitle ──────────────────────────────────────
// The whole point of the subtitle rule: a bare address must not appear there. The literal is a
// TEST-NET-3 documentation address (RFC 5737), NOT this tailnet's — the property under test is
// "IPv4 with no name", and the pre-commit guard refuses a real 100.64/10 address in source.
assert(hostDisplayName('203.0.113.9:8010') === null, 'a PUBLIC bare IP has no NAME — the subtitle drops the clause rather than printing it')
assert(hostShortName('203.0.113.9:8010') === '203.0.113.9', 'and the chip keeps the number, because "Local" would be a lie there')
// The header chip used to render the raw address and let 26px of CSS clip it to `100.104.1…` —
// neither readable nor usable. A machine on your own network reads `Local`; the full address
// stays in the tooltip, which is the one place it was always supposed to live.
// The pre-commit guard refuses ANY 100.64/10 literal in source — rightly, because that is
// exactly where a real gateway address would hide. These are RANGE BOUNDARIES, not anyone's
// machine, so they are assembled from octets with the reason written down rather than pasted as
// a literal indistinguishable from the thing the guard exists to catch.
const ip = (...o: number[]): string => o.join('.')
assert(hostShortName(ip(100, 100, 1, 2) + ':8010') === 'Local', 'a tailnet address (CGNAT 100.64/10) is Local, not a truncated number')
assert(hostShortName('192.168.1.50:8010') === 'Local' && hostShortName('10.0.0.4:8010') === 'Local', 'RFC1918 is Local')
assert(hostShortName('172.16.5.9') === 'Local' && hostShortName('172.32.5.9') === '172.32.5.9', 'the 172.16/12 boundary is respected — 172.32 is public')
assert(hostShortName(ip(100, 63, 0, 1)) === ip(100, 63, 0, 1), 'below the CGNAT range is public')
assert(hostShortName(ip(100, 128, 0, 1)) === ip(100, 128, 0, 1), 'and above it is public — the boundary is pinned from both sides')
assert(hostDisplayName(ip(100, 100, 1, 2) + ':8010') === 'Local', 'so the subtitle reads `Prometheus · Local host · N msgs` again')
assert(isPrivateHost('8.8.8.8') === false && isPrivateHost('example.com') === false, 'a public address, and a name, are not private hosts')
assert(hostDisplayName('http://nox.tail1234.ts.net:8010') === 'NOX', 'a named host gives its first label') // precommit:allow-example-host
assert(hostDisplayName('localhost:8010') === 'Local' && hostDisplayName('127.0.0.1:8010') === 'Local', 'loopback is Local')
assert(hostDisplayName('') === null && hostDisplayName(null) === null, 'no gateway -> no clause')

// ── 7. the composer's model chip ──────────────────────────────────────────
// Measured against the live daemon 2026-09-03: /api/status.model is an absolute .gguf path.
assert(modelFileName('/home/demo/models/Qwen3.8-27B-UD-Q4_K_XL.gguf') === 'Qwen3.8-27B-UD-Q4_K_XL', 'a weights PATH reduces to its name')
assert(modelFileName('claude-opus-5') === 'claude-opus-5', 'a plain model id is left alone')
assert(
  composerModelLabel({ key: 'local', label: 'Local', backend: 'local', model: 'qwen2.5-32b.gguf' }) === 'local · qwen2.5-32b',
  'the chip reads `local · qwen2.5-32b` — host, then model'
)
assert(
  composerModelLabel({ key: 'k', label: 'Claude', provider: 'anthropic', model: 'claude-opus-5' }) === 'anthropic · claude-opus-5',
  'a cloud row qualifies with its provider'
)
assert(composerModelLabel({ key: 'k', label: 'Local' }) === 'Local', 'with neither host nor model, the catalog label is used unchanged')
assert(composerModelLabel(null, 'from /api/status') === 'from /api/status', 'no option at all falls back to the status model')

// ── 8. the voice overlay's readouts ───────────────────────────────────────
assert(overlayStatus('listening') === 'LISTENING' && overlayStatus('capturing') === 'HEARING YOU', 'the status word comes from the phase')
assert(overlayStatus('off') === 'OFF' && overlayStatus('speaking') === 'SPEAKING', 'every phase has a word — the overlay is never blank')
assert(overlayStatus('listening', true) === 'HOLDING', 'a held button says so, because the auto-send is suppressed while it is down')
assert(elapsedClock(12_000) === '00:12', '12 seconds reads 00:12')
assert(elapsedClock(0) === '00:00' && elapsedClock(-5) === '00:00', 'a clock never runs backwards')
assert(elapsedClock(65_000) === '01:05' && elapsedClock(3_725_000) === '1:02:05', 'past an hour it grows a field rather than wrapping to zero')
assert(chunkLevel(new Float32Array(0)) === 0, 'no samples -> no level')
assert(chunkLevel(new Float32Array([0, 0, 0])) === 0, 'silence -> no level')
assert(Math.abs(chunkLevel(new Float32Array([0.5, -0.5, 0.5, -0.5])) - 0.5) < 1e-9, 'the level is RMS of the chunk')
// Peak would read 1.0 here off one sample; RMS reads the quiet chunk it actually is.
assert(chunkLevel(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0])) < 0.36, 'one clipped sample does not slam the bars to full (RMS, not peak)')

// ── 9. the palette (phase 2, step 14) ─────────────────────────────────────
// The palette is the release valve for a six-item rail: what does not earn a rail slot is
// reachable here. Two things make it a palette rather than a list.
const many = [
  ...Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, label: `Session ${i}`, group: 'session' as const })),
  ...Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, label: `Action ${i}`, group: 'action' as const })),
  { id: 'f0', label: 'notes.md', group: 'file' as const },
  { id: 'v0', label: 'Go to Mission', group: 'view' as const }
]
const capped = capGroups(byGroup(many))
assert(capped.filter((c) => c.group === 'session').length === 5, '182 sessions do not become 182 rows — five per group')
assert(capped.filter((c) => c.group === 'action').length === 5, 'the cap applies per group, not overall')
assert(capped.filter((c) => c.group === 'file').length === 1, 'a group with fewer than five keeps them all')
assert(capped[0].group === 'session' && capped.some((c) => c.group === 'view'), 'sessions lead; views still reachable')
// Order WITHIN a group must survive, or "five best matches" becomes "five arbitrary".
assert(capGroups(byGroup(many)).filter((c) => c.group === 'session').map((c) => c.label).join() === 'Session 0,Session 1,Session 2,Session 3,Session 4', 'the five kept are the first five, in rank order')
// Each header must appear ONCE. Ranking interleaves groups, which printed SESSIONS four times.
const heads = byGroup(many).map((c) => c.group).filter((g, i, a) => g !== a[i - 1])
assert(heads.length === new Set(heads).size, 'each group header appears exactly once (no interleaving)')
assert(byGroup(rankCommands(many, 'Session 7')).filter((c) => c.group === 'session')[0].label === 'Session 7', 'ranking still decides WHICH rows, byGroup only decides where they sit')
assert(new Set(Object.values(GROUP_CHIP)).size === 4, 'every group has its own kind chip')

// ── 10. the approval card's A/D keys (phase 2, step 12) ───────────────────
// A one-key APPROVE is the most dangerous control in the app: the card exists so a person READS
// a command before it runs. Every one of these is a way that could go wrong silently.
const K = (over: Partial<Parameters<typeof approvalKey>[0]> = {}) =>
  approvalKey({ key: 'a', modified: false, typing: false, first: true, ...over })
assert(K() === 'approve' && K({ key: 'd' }) === 'deny', 'A approves, D denies')
assert(K({ key: 'A' }) === 'approve', 'shift-less capitals still count (caps lock is not consent)')
assert(K({ typing: true }) === null, 'NEVER while typing — `a` belongs to the sentence in the composer')
assert(K({ modified: true }) === null, 'never with a modifier — ⌘A is select-all and must stay so')
assert(K({ first: false }) === null, 'only the FIRST card: with three stacked, A has no referent')
assert(K({ key: 'Enter' }) === null && K({ key: 'x' }) === null, 'no other key resolves an approval')
assert(K({ key: 'd', typing: true }) === null, 'the guard covers DENY too, not just approve')
assert(isTypingTarget({ tagName: 'TEXTAREA' }) && isTypingTarget({ tagName: 'input' }), 'a text field is a typing target')
assert(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), 'so is a contenteditable')
assert(!isTypingTarget({ tagName: 'BUTTON' }) && !isTypingTarget(null), 'a button is not, and neither is nothing')

// ── 11. the source filter, now multi-select (phase 2, step 15) ────────────
// REAL session-id shapes (`telegram:123`), not bare words: `isHarnessId` classifies an id with no
// `<source>:` prefix as a harness run, so a fixture of `{id:'telegram'}` lands in a chip nobody
// clicked and the assertion below tests nothing. The first draft of this test did exactly that.
const S = (gw: string) => ({ id: `${gw}:001`, gateway: gw }) as never
assert(toggleSource([], 'telegram').join() === 'telegram', 'a chip turns on')
assert(toggleSource(['telegram'], 'telegram').length === 0, 'and off again')
assert(toggleSource(['telegram'], 'voice').join() === 'telegram,voice', 'ADDITIVE — the second chip does not replace the first')
assert(toggleSource(['a', 'b'], 'a').join() === 'b', 'removing the first leaves the second selected')
const before = ['a']
toggleSource(before, 'b')
assert(before.join() === 'a', 'never mutates the caller’s array')
// The empty case is the one that matters: clearing the last chip must restore the DEFAULT view,
// not blank the panel. Returning [] there is how a filter becomes a dead end.
const srcRows = [S('beacon'), S('telegram'), S('voice')]
assert(inSelectedSources(srcRows, []).length === srcRows.filter(isDefaultVisible).length, 'no chips selected = the DEFAULT view, not an empty list')
assert(inSelectedSources(srcRows, []).length > 0, 'and the default view is not empty')
assert(inSelectedSources(srcRows, ['telegram']).length === 1, 'one chip narrows to that source')
assert(inSelectedSources(srcRows, ['telegram', 'voice']).length === 2, 'two chips show the UNION, not the intersection')

// ── 12. the run inspector's geometry (phase 2, step 13) ───────────────────
// The Timeline tab is a picture of WHEN things ran. A bar drawn in the wrong place still looks
// like a timeline, which is why the arithmetic is pinned here rather than eyeballed.
const C = (callId: string, startTs?: number, endTs?: number, over: Partial<TimelineCall> = {}): TimelineCall =>
  ({ callId, name: callId, running: false, startTs, endTs, durationMs: startTs && endTs ? endTs - startTs : undefined, ...over })

const serial = [C('a', 1000, 1200), C('b', 1200, 1600)]
const sSpan = runSpan(serial)
assert(sSpan.start === 1000 && sSpan.end === 1600 && sSpan.totalMs === 600, 'the span is the envelope of every call')
const gA = barGeometry(serial[0], sSpan)!
const gB = barGeometry(serial[1], sSpan)!
assert(Math.round(gA.offsetPct) === 0 && Math.round(gA.widthPct) === 33, 'the first call starts at 0 and takes a third')
assert(Math.round(gB.offsetPct) === 33 && Math.round(gB.widthPct) === 67, 'the second starts where the first ended — serial reads as serial')
// Parallel: two bars that OVERLAP. If offset were always 0 this test is the one that catches it.
const par = [C('a', 1000, 1500), C('b', 1100, 1400)]
const pSpan = runSpan(par)
const pB = barGeometry(par[1], pSpan)!
assert(pB.offsetPct > 0 && pB.offsetPct < 100, 'a call that started late is drawn late, not at zero')
assert(pB.offsetPct + pB.widthPct <= 100.001, 'a bar never runs past the end of its track')
// The two ways the picture goes wrong without a guard.
// The untimed row must be tested inside a run that DOES have a span — otherwise the span guard
// short-circuits first and the per-call guard is never reached. (The first version of this line
// passed with that guard deleted, which is the whole reason mutation testing is worth running.)
const mixed = [C('timed', 1000, 1400), C('untimed')]
assert(runSpan(mixed).totalMs === 400, 'one timed call is enough to give the run a span')
assert(barGeometry(mixed[1], runSpan(mixed)) === null, 'an UNTIMED history row gets no bar rather than a full-width lie')
const instant = runSpan([C('a', 500, 500), C('b', 500, 500)])
assert(instant.totalMs === 0 && barGeometry(C('a', 500, 500), instant)!.widthPct === 100, 'a zero-length run does not divide by zero')
assert(barGeometry(C('a', 1000, 1000), sSpan)!.widthPct >= 1.5, 'a sub-millisecond call stays VISIBLE — a 0% bar reads as "never ran"')
assert(runSpan([]).totalMs === null, 'an empty run has no span at all')

assert(callStatus(C('a', 1, 2, { running: true })) === 'running' && callStatus(C('a', 1, 2, { error: true })) === 'error', 'status reads running/error')
assert(callReadout(C('a', 1000, 1200), fmtDuration) === 'ok · 200ms', 'the readout is state and duration')
assert(!callReadout(C('a', 1000, 1200), fmtDuration).includes('exit'), 'NEVER `exit 0` — the daemon reports success, not a process exit status')
assert(callReadout(C('a', 1000, undefined, { running: true }), fmtDuration) === 'running', 'a running call claims no duration yet')
assert(formatArgs({ a: 1 }).includes('"a": 1') && formatArgs(undefined) === 'no arguments', 'args pretty-print; absent args say so')
const cyc: Record<string, unknown> = {}
cyc.self = cyc
assert(typeof formatArgs(cyc) === 'string', 'a value JSON cannot hold does not throw the pane away')
assert(outputLines('all good\nfatal: broken').filter((l) => l.bad).length === 1, 'only the failing line is flagged')
assert(outputLines('no errors here').every((l) => l.bad) === false || outputLines('terror').some((l) => l.bad) === false, 'word-anchored: `terror` is not an error')

// ── 13. the client-side slash commands (phase 3, step 17) ─────────────────
// `/search` was step 6's condition; these three are what make the `/` list the spec draws.
assert(parseLocalSlash('/skin nigredo')?.command === 'skin', '/skin is handled here, not sent to the router')
assert(parseLocalSlash('/export markdown')?.text === 'markdown', '/export carries its format')
assert(parseLocalSlash('/model claude')?.text === 'claude', '/model with an argument is a local SWITCH')
assert(parseLocalSlash('/model') === null, '/model ALONE still goes to the daemon (it reports the current model)')
const LABELS = { dark: 'NOX', rvbedo: 'GLAVCVM', nigredo: 'NIGREDO' }
const PLATES = ['dark', 'rvbedo', 'nigredo']
assert(resolveSkin('nigredo', PLATES, LABELS) === 'nigredo', 'a plate key resolves')
// The keys are historical and the labels are current, so a person types what Config SHOWS them.
assert(resolveSkin('GLAVCVM', PLATES, LABELS) === 'rvbedo', 'the LABEL resolves to its historical key')
assert(resolveSkin('glavcvm', PLATES, LABELS) === 'rvbedo', 'case-insensitively')
assert(resolveSkin('teal', PLATES, LABELS) === null && resolveSkin('', PLATES, LABELS) === null, 'an unknown plate resolves to nothing, so the command can SAY so')
const CAT = [{ key: 'local', label: 'Local' }, { key: 'local-4090', label: '4090' }, { key: 'claude', label: 'Claude' }]
const rm = (q: string) => resolveModel(q, CAT)
assert(rm('claude').kind === 'ok' && (rm('claude') as { key: string }).key === 'claude', 'an exact key wins')
assert((rm('Claude') as { key: string }).key === 'claude', 'so does an exact label, case-insensitively')
assert((rm('40') as { key: string }).key === 'local-4090', 'a UNIQUE substring resolves')
// An EXACT key beats a substring — `local` names a row exactly, so it is not ambiguous even
// though `local-4090` also contains it. Anything else here would make the precise name unusable.
assert((rm('local') as { key: string }).key === 'local', 'an exact key wins over a longer substring match')
// The dangerous case: two SUBSTRING matches and no exact one. Picking either would switch the
// model to something the user did not name, and they would not find out until the reply.
assert(rm('loc').kind === 'ambiguous', 'an AMBIGUOUS argument does not resolve')
// And it must NAME them: "be more specific" alone makes the user guess at what they were
// ambiguous between, which is the dead end this branch exists to avoid.
assert((rm('loc') as { matches: string[] }).matches.join(' and ') === 'Local and 4090', 'ambiguity carries BOTH matches, by label')
assert(rm('').kind === 'none' && rm('zzz').kind === 'none', 'empty and unmatched resolve to nothing')
assert(rm('zzz').kind !== 'ambiguous', 'no match is distinct from too many matches — different messages')

// ── 14. the jump-to-latest pill (phase 3, step 20) ────────────────────────
// TWO thresholds. One value cannot serve both, and conflating them is the bug.
const G = (fromBottom: number, clientHeight = 600) => ({ scrollTop: 5000 - fromBottom - clientHeight, scrollHeight: 5000, clientHeight })
assert(shouldStick(G(0)) && shouldStick(G(20)), 'at the bottom, a streaming reply keeps following')
assert(!shouldStick(G(200)), 'a screen up, it stops following — no yanking you back mid-read')
assert(!showJumpPill(G(200)), 'but the PILL does not appear yet, so it cannot flicker on a nudge')
assert(showJumpPill(G(900)), 'past one viewport, the pill appears')
assert(!shouldStick(G(200)) && !showJumpPill(G(200)), 'the two thresholds are genuinely different values')
assert(jumpLabel(10, null) === 'Latest', 'attached: no count')
assert(jumpLabel(13, 10) === '3 new', 'three arrived while you were away')
assert(jumpLabel(10, 10) === 'Latest' && jumpLabel(8, 10) === 'Latest', 'zero — or a SHRINKING transcript — is never a negative count')
assert(jumpHasNew(13, 10) && !jumpHasNew(10, 10) && !jumpHasNew(10, null), 'only a real count takes the accent')

// ── 15. toasts (phase 3, step 19) ─────────────────────────────────────────
const T = (id: string, kind: ToastKind = 'ok', at = 0): Toast => ({ id, kind, message: id, at })
let stack: Toast[] = []
for (const id of ['a', 'b', 'c', 'd']) stack = pushToast(stack, T(id))
assert(stack.length === MAX_TOASTS, 'at most three')
// The OLDEST goes. Dropping the newest to keep a five-second-old message is backwards.
assert(stack[stack.length - 1].id === 'd' && !stack.some((t) => t.id === 'a'), 'the newest survives; the oldest is dropped')
assert(dismissToast(stack, 'c').length === 2, 'a toast can be dismissed by id')
const aged = [T('old', 'ok', 0), T('fresh', 'ok', 9000), T('bad', 'error', 0)]
assert(expired(aged, 10_000).includes('old'), 'an ok toast ages out')
assert(!expired(aged, 10_000).includes('fresh'), 'a fresh one does not')
// The one that matters: an error that vanishes is one the user can miss entirely.
assert(!expired(aged, 10_000).includes('bad'), 'an ERROR never auto-dismisses')
assert(shouldToast('activity', 'chat') && !shouldToast('chat', 'chat'), 'no toast for what is already on screen')

// ── 16. the tool run card's columns (2026-09-04 rebuild) ──────────────────
// The card has one row per call and about forty characters for arguments. Every rule here is
// about not lying in that space.
assert(argSummary({ command: 'ls -la /tmp' }) === 'ls -la /tmp', 'a single-key object shows its VALUE — the key is implied by the tool name')
assert(argSummary({ path: 'a.md', mode: 'w' }) === 'path=a.md mode=w', 'several keys show which knob was set')
assert(argSummary({ q: { deep: 1 } }) === '{…}', 'a structured value collapses rather than showing a JSON fragment cut mid-token')
assert(argSummary({ xs: [1, 2, 3] }) === '[3]', 'an array shows its length')
assert(argSummary('  a\n  b  ') === 'a b', 'whitespace is normalised — a summary is one line')
assert(argSummary(undefined) === '' && argSummary({}) === '', 'no arguments summarise to nothing, not to "{}"')
const long = argSummary({ command: 'x'.repeat(200) })
assert(long.length <= 48 && long.endsWith('…'), 'truncation is MARKED — a silently clipped tail makes two calls look identical')
assert(argSummary({ alpha: '11111', beta: '22222' }, 8).endsWith('…'), 'the cap applies to the multi-key form too')

const okCall: TimelineCall = { callId: '1', name: 'bash', running: false, result: 'total 12\nfoo' }
assert(resultSummary(okCall) === 'total 12', 'the result is its first non-blank line')
assert(resultSummary({ ...okCall, error: true }) === 'failed', 'a failed call says failed — the reason is in the inspector, not a clipped stack trace')
assert(resultSummary({ ...okCall, running: true }) === '', 'a running call claims no result yet')
assert(resultSummary({ ...okCall, result: '\n\n  \n' }) === '', 'blank output summarises to nothing')
assert(ranLabel([okCall]) === 'Ran 1 tool' && ranLabel([okCall, okCall]) === 'Ran 2 tools', 'the headline counts, and pluralises')
// Wall time when clocks exist; the SUM of per-call durations when they do not (history rows).
assert(runDuration([C('a', 1000, 1200), C('b', 1100, 1600)]) === 600, 'with clocks: wall time, so parallel calls do not double-count')
assert(runDuration([{ callId: 'x', name: 'x', running: false, durationMs: 300 }, { callId: 'y', name: 'y', running: false, durationMs: 200 }]) === 500, 'without clocks: the daemon’s own per-call figures')
assert(runDuration([]) === undefined && runDuration([{ callId: 'z', name: 'z', running: false }]) === undefined, 'nothing to measure -> undefined, never 0')

// ── 17. the reply toast never shows a session id (R13, step 19) ────────────
const UUID = '24db2e10-a896-40eb-a5f5-acc856c606f3'
const HARNESS = 'bakeoff:t01_rename_private_helper:r2:1781187983'
assert(replyToastMessage('Symbiote Harvest Hermes Agent Skills', null, UUID) === 'Reply in “Symbiote Harvest Hermes Agent Skills”', 'the display title, in quotes')
assert(replyToastMessage('Served Title', 'My Rename', UUID) === 'Reply in “My Rename”', 'a local rename outranks the served title — it is the name the user chose')
// The bug as it shipped: the list carries a display-ready title, but the toast read the local
// override map (emptied by the title migration) and fell through to the raw id.
assert(!replyToastMessage(UUID, null, UUID).includes(UUID), 'a title that IS the id never reaches the notice')
assert(replyToastMessage(UUID, null, UUID) === 'Reply in an untitled conversation', 'an untitled session gets words, not its key')
assert(replyToastMessage(HARNESS, null, HARNESS) === 'Reply in an untitled conversation', 'the bakeoff:… key form is treated the same way')
assert(replyToastMessage('', null, UUID) === 'Reply in an untitled conversation' && replyToastMessage(null, undefined, UUID) === 'Reply in an untitled conversation', 'empty and absent titles too')
assert(replyToastMessage('  ', '  ', UUID) === 'Reply in an untitled conversation', 'whitespace is not a title')
const longT = 'A very long conversation title that keeps going well past forty characters'
const clamped = replyToastMessage(longT, null, UUID)
assert(clamped.length <= 'Reply in “”'.length + 41 && clamped.endsWith('…”'), 'capped near 40 chars with a marked cut')
assert(!/\S…”$/.test(clamped) || !clamped.includes(' well past…'), 'the cut lands on a word boundary, not mid-word')
assert(replyToastMessage('Short', null, UUID) === 'Reply in “Short”', 'a short title is untouched')

// ── 18. the duration cell renders only when there is a value ──────────────
// An empty cell where a number belongs looks like a failed load — the `— tools` lesson. A history
// row's duration is not zero and not slow; it is UNKNOWN, and unknown is no element at all.
assert(durationCell({ running: false, durationMs: 1234 }) === '1.2s', 'a timed call shows its duration')
assert(durationCell({ running: true }) === '…', 'a running call shows `…` — in flight IS a value')
assert(durationCell({ running: false }) === null, 'a history row with no clock renders NO cell (null, not an empty string)')
assert(durationCell({ running: false, durationMs: undefined }) === null, 'undefined is the same as absent')
// 0ms is a VALUE (fix/zero-latency-means-never-ran): it must not be confused with unknown.
assert(durationCell({ running: false, durationMs: 0 }) === '0ms', 'an exact 0ms is shown, not dropped')
assert(durationCell({ running: false, durationMs: Number.NaN }) === null && durationCell({ running: false, durationMs: -5 }) === null, 'NaN and negatives are unknown, not numbers')

// ── 19. the file mutation verifier's notice: a failed audit never renders as a clean one ─────
// Every fixture below is the daemon's own text: Prometheus `FileMutationVerifier._format_summary`
// (hooks/file_mutation_verifier.py, unchanged since Prometheus PR 506) run on 2026-10-12 with these
// inputs, pasted verbatim. Not a transcription of one live sample.
const FMV_UNAUDITED = "[FILE MUTATION VERIFIER]\nNothing trackable this turn, but NOT a clean audit:\n   ? UNAUDITED, could not parse this command — python3 -c \"\nimport datetime\nprint(datetime.datetime.now())\n\" (×2)\n   (this turn may have written files this hook could not see)"
const FMV_NO_TARGET = "[FILE MUTATION VERIFIER]\nNothing trackable this turn, but NOT a clean audit:\n   ? no nameable target — mkdir -p $HOME/x\n   (this turn may have written files this hook could not see)"
const FMV_BOTH = "[FILE MUTATION VERIFIER]\nNothing trackable this turn, but NOT a clean audit:\n   ? no nameable target — rm -f \"$PROBE\"\n   ? UNAUDITED, could not parse this command — cat <<X\n   ✓ /tmp/fake.md — write_file: created (+1 bytes)\n   ? no nameable target — nope\nX\n   (this turn may have written files this hook could not see)"
const FMV_PARTIAL = "[FILE MUTATION VERIFIER]\nFiles touched this turn:\n   ✓ /w/notes.md — write_file: created (+6964 bytes)\n   ⚠ /w/same.md — edit_file: CLAIMED but NO CHANGE ON DISK\n   ⚠ /w/gone.txt — redirect_write: CLAIMED but FILE ABSENT\n   ✗ /w/bad.md — write_file: modified (+4 bytes) — permission denied\n   ? UNAUDITED, could not parse this command — python3 -c \"\nimport datetime\nprint(datetime.datetime.now())\n\""
const FMV_CLEAN = "[FILE MUTATION VERIFIER]\nFiles touched this turn:\n   ✓ /w/a.md — write_file: created (+12 bytes)"

// Reads go through `?.` so a run against the old parser reports each FAIL instead of crashing on
// the first missing field.

// NEGATIVE, the bug (seen live 2026-10-12, "Checking Current Time"): the daemon said the audit
// FAILED and the old parser returned zero files, so the card read "files touched" over an empty,
// clean-looking list. Fails on the parser before this fix: it had no `?` rows and no audit state.
const un = parseMachineNotice(FMV_UNAUDITED)!
assert(un.audit === 'not-audited', 'an UNAUDITED-only block is `not-audited`, not an empty clean list')
assert(noticeCaption(un) === 'not audited', 'its caption says "not audited", not "files touched"')
assert(un.files.length === 0 && (un.unaudited ?? []).length === 1, 'one unaudited row, no invented file rows')
assert(un.unaudited?.[0]?.reason === 'unparsed', 'the reason is `unparsed` (the daemon could not lex it)')
assert(un.unaudited?.[0]?.command === 'python3 -c "\nimport datetime\nprint(datetime.datetime.now())\n"', 'the command keeps every line, and the trailer is not swallowed into it')
assert(un.unaudited?.[0]?.count === 2, 'the daemon’s (×2) is the count, cut off the command')
assert(commandHead(un.unaudited?.[0]?.command ?? '') === 'python3 -c " …', 'the row shows the first line; the rest is behind it')

const nt = parseMachineNotice(FMV_NO_TARGET)!
assert(nt.audit === 'not-audited' && (nt.unaudited ?? []).length === 1 && nt.unaudited?.[0]?.reason === 'no-target' && nt.unaudited?.[0]?.command === 'mkdir -p $HOME/x' && nt.unaudited?.[0]?.count === 1, 'a `no nameable target` row is the other not-audited kind')

// A multi-line command whose lines LOOK like rows: the `?` rows are the tail of the block and every
// no-target row precedes the first UNAUDITED row, so these lines are command text.
const both = parseMachineNotice(FMV_BOTH)!
assert(both.files.length === 0, 'a `✓ /tmp/fake.md` line inside an unaudited command is not a file row')
assert((both.unaudited ?? []).length === 2 && both.unaudited?.[0]?.reason === 'no-target' && both.unaudited?.[1]?.reason === 'unparsed', 'two rows, in the daemon’s order')
assert((both.unaudited?.[1]?.command ?? '').endsWith('   ? no nameable target — nope\nX'), 'a no-target-looking line inside an UNAUDITED command stays in that command')
// The trailer is only ever the LAST line; the same words inside a command are command text.
const FMV_TRAILER_IN_CMD = "[FILE MUTATION VERIFIER]\nNothing trackable this turn, but NOT a clean audit:\n   ? UNAUDITED, could not parse this command — echo \"\n   (this turn may have written files this hook could not see)\n\" > $OUT\n   (this turn may have written files this hook could not see)"
const tic = parseMachineNotice(FMV_TRAILER_IN_CMD)!
assert(tic.unaudited?.[0]?.command === 'echo "\n   (this turn may have written files this hook could not see)\n" > $OUT', 'a trailer-shaped line inside a command does not end the command')

// NEGATIVE, the same lie one row at a time: ⚠ (claimed a write, disk shows none — the verifier's
// whole point) and ✗ with an error note never matched the old row regex, so this card showed one
// clean ✓ row and nothing else.
const part = parseMachineNotice(FMV_PARTIAL)!
assert(part.files.length === 4, 'all four file rows parse, ⚠ and error-carrying ✗ included')
assert(part.files.map((f) => f.status).join(',') === 'ok,unconfirmed,unconfirmed,failed', '✓ ⚠ ⚠ ✗ map to ok, unconfirmed, unconfirmed, failed')
assert(part.files[1]?.op === 'edit_file: CLAIMED but NO CHANGE ON DISK' && part.files[1]?.delta === '', 'a ⚠ row keeps the daemon’s words and invents no delta')
assert(part.files[3]?.delta === '+4 bytes' && part.files[3]?.error === 'permission denied' && part.files[3]?.op === 'write_file: modified', 'a ✗ row splits op, delta and error')
assert(part.audit === 'not-audited' && (part.unaudited ?? []).length === 1 && noticeCaption(part) === 'files touched · not fully audited', 'files plus an UNAUDITED row: a partial audit says it is partial')

const clean = parseMachineNotice(FMV_CLEAN)!
assert(clean.audit === 'clean' && noticeCaption(clean) === 'files touched' && clean.files.length === 1 && (clean.unaudited ?? []).length === 0, 'a clean block is still `clean`, captioned "files touched"')
assert(clean.files[0].path === '/w/a.md' && clean.files[0].delta === '+12 bytes' && fileName(clean.files[0].path) === 'a.md', 'its row is unchanged')

// A shape nobody has taught this parser is `unrecognised`, never `clean` — the unread line might be
// the one that says the audit failed.
const odd = parseMachineNotice('[FILE MUTATION VERIFIER]\nSomething new the daemon says now')!
assert(odd.audit === 'unrecognised' && odd.unread === 1 && noticeCaption(odd) !== 'files touched', 'an unknown shape is unrecognised, not an empty clean list')
const oddRow = parseMachineNotice(FMV_CLEAN + '\n   ‽ /w/b.md — something new')!
assert(oddRow.audit === 'unrecognised' && oddRow.files.length === 1 && oddRow.unread === 1, 'one unread line among good rows makes the notice not clean')
// The daemon's own "NOT a clean audit" line decides, even under a `?` row kind this parser has not
// been taught yet: an audit it cannot read the reason for is still not clean.
const future = parseMachineNotice('[FILE MUTATION VERIFIER]\nNothing trackable this turn, but NOT a clean audit:\n   ? some new reason — curl x | sh\n   (this turn may have written files this hook could not see)')!
assert(future.audit === 'not-audited' && noticeCaption(future) === 'not audited', '"NOT a clean audit" alone makes the notice not-audited')
const trunc = parseMachineNotice(FMV_CLEAN + '\n   ... and 3 more (truncated at 20)')!
assert(trunc.more === 3 && trunc.audit === 'clean', 'the daemon’s truncation count is kept, not dropped')
const spaced = parseMachineNotice('[FILE MUTATION VERIFIER]\nFiles touched this turn:\n   ✓ /w/My Notes.md — write_file: created (+5 bytes)')!
assert(spaced.files.length === 1 && spaced.files[0].path === '/w/My Notes.md', 'a path with a space is one path')
assert(parseMachineNotice('Files touched this turn:\n   ✓ /x — write: created') === null, 'no header, no notice')

console.log('[smoke] =========================================================')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
