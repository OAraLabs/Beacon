/**
 * Headless smoke for the screen-reader announcement model (@shared/live-announce).
 *
 * Proves the rules that make this usable rather than noise: a streaming row is NEVER announced (the
 * token flood), only the newest settled row is, a backlog is armed-not-recited, the user's own words
 * are not echoed back, and arming is separate from announcing. Then proves ChatShell WIRES it — that
 * the effect publishes through nextAnnouncement, arms through initialWatermark, and that the ONE live
 * region sits outside the list while <main> carries no aria-live/role=log (the trap that would put
 * every delta into the announcement path).
 *
 *   npm run build && npm run smoke:live-announce
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initialWatermark, nextAnnouncement, spokenAnnouncement, type AnnounceRow } from '@shared/live-announce'

let failures = 0
function assert(cond: boolean, what: string, detail = ''): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}${detail && !cond ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}

const row = (key: string, role: string, text: string, pending = false): AnnounceRow => ({ key, role, text, pending })

console.log('[smoke] === the token flood is impossible ===')
{
  const streaming = [row('u1', 'user', 'do a thing'), row('a1', 'assistant', 'Sure, let me', true)]
  assert(nextAnnouncement(streaming, null) === null, 'a PENDING row announces nothing — the reducer mutates the same node per delta, so announcing it would fire on every token')
  const grown = [row('u1', 'user', 'do a thing'), row('a1', 'assistant', 'Sure, let me check that', true)]
  assert(nextAnnouncement(grown, null) === null, 'and the SAME row having grown still announces nothing — identity is the key, not the text, so no delta count matters')
}

console.log('\n[smoke] === a settled reply is announced once, then never again ===')
{
  const settled = [row('u1', 'user', 'do a thing'), row('a1', 'assistant', 'Done.')]
  const first = nextAnnouncement(settled, null)
  assert(first?.key === 'a1' && first?.text === 'Done.', `a settled reply is announced (got ${JSON.stringify(first)})`)
  assert(nextAnnouncement(settled, 'a1') === null, 'the same row with the watermark on it announces nothing — no repeat')
  const nextTurn = [...settled, row('u2', 'user', 'and again'), row('a2', 'assistant', 'Also done.')]
  const second = nextAnnouncement(nextTurn, 'a1')
  assert(second?.key === 'a2', `a LATER settled reply is announced (got ${JSON.stringify(second?.key)}) — the watermark moved forward`)
}

console.log('\n[smoke] === only the NEWEST is announced, never a burst ===')
{
  const burst = [
    row('a1', 'assistant', 'first'),
    row('a2', 'assistant', 'second'),
    row('a3', 'assistant', 'third')
  ]
  const got = nextAnnouncement(burst, null)
  assert(got?.key === 'a3', `three completions at once announce only the newest (got ${JSON.stringify(got?.key)}) — a screen reader user wants where the conversation IS, not a recital`)
}

console.log('\n[smoke] === the user never hears their own words echoed back ===')
{
  const onlyUser = [row('u1', 'user', 'hello there')]
  assert(nextAnnouncement(onlyUser, null) === null, 'a session whose only row is the user\'s own message announces nothing')
  const userNewest = [row('a1', 'assistant', 'earlier reply'), row('u1', 'user', 'my newest message')]
  assert(nextAnnouncement(userNewest, null)?.key === 'a1', 'the newest row being a USER row is skipped, and the scan continues to the newest non-user row')
}

console.log('\n[smoke] === blank / unspeakable rows announce nothing ===')
{
  assert(nextAnnouncement([row('a1', 'assistant', '   ')], null) === null, 'whitespace-only text is not announced')
  assert(nextAnnouncement([row('a1', 'assistant', '')], null) === null, 'an image-only row (no text) is not announced')
  // A caller-supplied predicate is honoured — ChatShell passes @shared/speech-text's speakable().
  const onlyCode = (t: string): boolean => !/^[`~]/.test(t)
  assert(nextAnnouncement([row('a1', 'assistant', '```js')], null, onlyCode) === null, 'a caller-supplied speakable() can veto a row')
  assert(nextAnnouncement([row('a1', 'assistant', 'fine')], null, onlyCode)?.key === 'a1', '...and lets one through')
}

console.log('\n[smoke] === arming is its own act, and it does not publish ===')
{
  const backlog = [row('a1', 'assistant', 'old reply'), row('u2', 'user', 'old question'), row('a2', 'assistant', 'the last thing on screen')]
  assert(initialWatermark(backlog) === 'a2', 'arming names the newest settled non-user row — that backlog is treated as already-heard')
  assert(nextAnnouncement(backlog, initialWatermark(backlog)) === null, 'and with that watermark set, NOTHING is announced — opening a session must not recite its last message')
  const empty: AnnounceRow[] = []
  assert(initialWatermark(empty) === null, 'an empty session arms to null — there is nothing to mark as seen')
  assert(nextAnnouncement([row('a1', 'assistant', 'the first ever reply')], initialWatermark(empty))?.key === 'a1', 'so a FRESH session\'s first reply IS announced — correct, that one is genuinely news')
  const userOnly = [row('u1', 'user', 'just my message')]
  assert(initialWatermark(userOnly) === null, 'a session with only the user\'s own row arms to null (nothing markable)')
  const streamingBacklog = [row('a1', 'assistant', 'old'), row('a2', 'assistant', 'still arriving', true)]
  assert(initialWatermark(streamingBacklog) === 'a1', 'arming skips a pending row and names the newest SETTLED one — it must not mark a half-arrived reply as heard')
}

console.log('\n[smoke] === a text-less watermark still stops the scan ===')
{
  // A session whose last turn was tool calls only: its newest settled non-user row has no text.
  const history = [row('a1', 'assistant', 'the reply the user already heard'), row('u2', 'user', 'next question'), row('a2', 'assistant', '')]
  const mark = initialWatermark(history)
  assert(mark === 'a2', 'arming marks the newest settled non-user row even when it has no text')
  const afterSend = [...history, row('u3', 'user', 'and another')]
  assert(nextAnnouncement(afterSend, mark) === null, 'the scan stops AT the watermark, text or not — walking past a text-less mark recited the older reply the user already heard')
  const answered = [...afterSend, row('a3', 'assistant', 'the new answer')]
  assert(nextAnnouncement(answered, mark)?.key === 'a3', 'and the next real reply is still announced')
}

console.log('\n[smoke] === a STOPPED reply is announced as stopped, not as finished ===')
{
  // The daemon's chat_done carries interrupted:true for a Stop pressed in any client. The row is
  // settled (pending cleared) but partial; the visible row says "stopped", so the announcement must too.
  const stopped: AnnounceRow = { key: 'a1', role: 'assistant', text: 'Sure, let me look into', interrupted: true }
  const got = nextAnnouncement([row('u1', 'user', 'q'), stopped], null)
  assert(got?.key === 'a1' && got?.interrupted === true, `a stopped row is announced AND marked interrupted (got ${JSON.stringify(got)})`)
  const said = got ? spokenAnnouncement(got) : ''
  assert(said.startsWith('Reply stopped.'), `what is spoken says it stopped (got ${JSON.stringify(said)}) — a partial reply read as complete misstates what the agent did`)
  assert(said.includes('Sure, let me look into'), 'and still carries what the agent had produced')
  const done = nextAnnouncement([row('a2', 'assistant', 'Done.')], null)
  assert(done !== null && done.interrupted !== true && spokenAnnouncement(done) === 'Done.', 'a finished reply is spoken exactly as written — no prefix')
  assert(spokenAnnouncement({ key: 'a', text: '**bold**', interrupted: true }, (t) => t.replace(/\*/g, '')) === 'Reply stopped. bold', 'the caller\'s cleaner applies to the text, after the prefix')
  assert(nextAnnouncement([{ key: 'a3', role: 'assistant', text: '  ', interrupted: true }], null) === null, 'a stopped row with no speakable text announces nothing (unchanged rule)')
}

console.log('\n[smoke] === ChatShell wires the model, and the list itself is NOT a live region ===')
{
  const shell = readFileSync(join(process.cwd(), 'src/renderer/src/components/ChatShell.tsx'), 'utf8')
  assert(shell.includes('nextAnnouncement(') && shell.includes('initialWatermark('), 'the effect calls both model functions — arming and announcing, not one overloaded ref')
  assert(/announceArmedRef/.test(shell), 'arming has its OWN ref, separate from the watermark (one null meaning two things was the bug this prevents)')
  // Arming waits for HISTORY, not for the first render with rows: a stream frame can render a row
  // before history lands, and arming on that render marks nothing as heard, so the backlog is then
  // recited when history replaces the list (#185 review).
  assert(/if \(!historyLoaded\) return/.test(shell), 'arming waits until history has LOADED — not merely the first render with rows, which a stream frame can produce before history lands')
  assert((shell.match(/setHistoryLoaded\(true\)/g) ?? []).length >= 2, 'history-loaded is set on BOTH the fetch resolving and the fetch failing — a failed fetch must not leave announcements disarmed forever')
  assert(/\}, \[rendered, historyLoaded\]\)/.test(shell), 'the announce effect re-runs when history loads, so arming happens on that render even if no row changed')
  assert(/interrupted: m\.interrupted/.test(shell), 'the rows fed to the model carry the interrupted flag')
  assert(/speakable\)/.test(shell) && /speechText\(/.test(shell), 'the SAME speakable/speechText pair read-aloud uses is applied, so both consumers agree on what is worth saying and neither reads raw markdown')
  assert(/setAnnounce\(\(a\) => \(\{ text: spokenAnnouncement\(next, speechText\), seq: a\.seq \+ 1 \}\)\)/.test(shell), 'publishing goes through spokenAnnouncement (so a stopped reply says so) and bumps a seq — two identical consecutive replies would otherwise reuse the node and stay silent')

  // The trap: role="log" implies aria-live="polite", and the reducer mutates rows per token, so a
  // live region ON THE LIST announces every delta. Assert the list carries neither.
  //
  // IMPORTANT: match the ELEMENT, not substrings of the whole file. This source carries prose
  // explaining WHY the list is not a live region, and that prose contains the very tokens
  // ('aria-live="polite"', 'aria-hidden') a naive count would hit — an earlier version of this smoke
  // failed three checks by reading its own subject's comments. Locate the region div by its className
  // and assert on that element's own text.
  const mainOpen = shell.match(/<main className="messages"[^>]*>/)
  assert(!!mainOpen, 'the messages <main> was found to inspect')
  assert(!!mainOpen && !/aria-live/.test(mainOpen[0]), 'the messages <main> carries NO aria-live — the visible list is out of the announcement path')
  assert(!!mainOpen && !/role="log"/.test(mainOpen[0]), 'and no role="log" — it implies aria-live="polite", which would put every delta into the announcement path')

  const regionTag = shell.match(/<div className="sr-only"[^>]*aria-live="polite"[^>]*>/)
  assert(!!regionTag, 'exactly one sr-only polite live region element exists (found by its className, not by counting tokens in the file)')
  const regions = shell.match(/<div className="sr-only"[^>]*aria-live="polite"/g) ?? []
  assert(regions.length === 1, `and there is only ONE such region (found ${regions.length}) — a second live region would double-announce every reply`)
  if (regionTag) {
    assert(/aria-atomic="true"/.test(regionTag[0]), 'the region is aria-atomic="true" — announce the whole thing, not just the changed fragment')
    assert(!/aria-hidden/.test(regionTag[0]), 'the region is NOT aria-hidden — that would silence the one thing this exists to say')
    assert(!/\bkey=/.test(regionTag[0]), 'the region element itself is NOT keyed — it must stay mounted, because a live region inserted together with its text is often not announced')
    const mainCloseIdx = shell.indexOf('</main>')
    const regionIdx = shell.indexOf(regionTag[0])
    assert(mainCloseIdx > -1 && regionIdx > mainCloseIdx, 'the region renders AFTER </main> — outside the scroll container, so it is not a row the user navigates')
    const after = shell.slice(regionIdx + regionTag[0].length, regionIdx + regionTag[0].length + 120)
    assert(/^\s*<span key=\{announce\.seq\}>\{announce\.text\}<\/span>\s*<\/div>/.test(after), 'and its only child is a span keyed on announce.seq holding the published text — replacing the CHILD re-announces identical consecutive replies without remounting the region')
  }
}

console.log(`\n[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
