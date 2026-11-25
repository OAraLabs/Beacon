/**
 * soul-smoke — Config › Soul (@shared/soul), headless.
 *
 *   1. the 200 body reads as a document, and a body that is not one is "failed", never an empty persona;
 *   2. each status the daemon answers about the file (scripts/fixtures/soul.json) is its plain sentence;
 *   3. an older daemon (404 "Not Found") is told apart from a missing file (404 "not_found") by the body;
 *   4. sizes, the edited day, clipping and the empty file read as the phone's do;
 *   5. wiring: read-only (one GET, no write, no editor), owner-only, pathless tab beside Memory.
 *
 * Run: npm run build && npm run smoke:soul
 */
import { readFileSync } from 'node:fs'
import { CONFIG_TABS } from '@shared/daemon-api'
import { isOwnerOnlyConfigTab, ownerOnlyText } from '@shared/device-role'
import { SOUL_DISPLAY_LIMIT, SOUL_PATH, parseSoul, soulEdited, soulEmptyLine, soulFromError, soulSentence, soulShown, soulSize, type SoulAnswer } from '@shared/soul'
import { configTabVisible } from '@shared/ui-mode'

const MIN_CHECKS = 60
let checks = 0
let failures = 0
function check(cond: boolean, name: string, detail = ''): void {
  checks++
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}
process.on('exit', () => {
  console.log('===================== RESULT =====================')
  if (failures === 0 && checks < MIN_CHECKS) {
    console.error(`soul smoke: FAIL ✗ (only ${checks} of at least ${MIN_CHECKS} checks ran)`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`soul smoke: FAIL ✗ (${failures} of ${checks})`)
    process.exitCode = 1
  } else console.log(`soul smoke: PASS ✓ (${checks} checks: the document, the daemon's statements, an older daemon, words, wiring)`)
})

const fx = JSON.parse(readFileSync(new URL('../../scripts/fixtures/soul.json', import.meta.url), 'utf8')) as {
  document: { content: string; bytes: number; modified_at: number }
  refusals: Record<string, { status: number; body: unknown }>
}
/** The error as the bridge throws it (rest.getDaemon, through IPC). */
const thrown = (status: number, body: unknown, viaIpc = true): Error => new Error(`${viaIpc ? "Error invoking remote method 'daemon:get': Error: " : ''}HTTP ${status}: GET ${SOUL_PATH} — ${typeof body === 'string' ? body : JSON.stringify(body)}`)
const fromRefusal = (k: string): SoulAnswer => soulFromError(thrown(fx.refusals[k].status, fx.refusals[k].body))
const kind = (a: SoulAnswer): string => a.kind

console.log('1. the document')
const doc = parseSoul(fx.document)
check(doc.kind === 'document' && doc.document.bytes === 189 && doc.document.modifiedAt === 1793667600 && doc.document.content.startsWith('# Soul'), 'the daemon\'s 200 body reads as a document')
check(soulSentence(doc) === null, 'a document has no sentence in its place')
for (const [name, body] of Object.entries({ null: null, string: 'x', number: 7, array: [], empty: {}, 'no content': { bytes: 1, modified_at: 1 }, 'content not text': { content: 5, bytes: 1, modified_at: 1 }, 'no bytes': { content: 'x', modified_at: 1 }, 'bytes negative': { content: 'x', bytes: -1, modified_at: 1 }, 'bytes fractional': { content: 'x', bytes: 1.5, modified_at: 1 }, 'bytes text': { content: 'x', bytes: '1', modified_at: 1 }, 'no time': { content: 'x', bytes: 1 }, 'time text': { content: 'x', bytes: 1, modified_at: 'now' }, 'time NaN-ish': { content: 'x', bytes: 1, modified_at: null }, 'time negative': { content: 'x', bytes: 1, modified_at: -5 } })) {
  check(parseSoul(body).kind === 'failed', `a body that is not one (${name}) is "failed", not an empty persona`)
}
const emptyDoc = parseSoul({ content: '  \n\t\n', bytes: 5, modified_at: 1793667600 })
check(emptyDoc.kind === 'document' && soulEmptyLine(emptyDoc.document) === 'The persona file is empty.', 'a file of only blank space is "empty", not a blank screen')
check(doc.kind === 'document' && soulEmptyLine(doc.document) === null, 'and a real one is not')
const zero = parseSoul({ content: '', bytes: 0, modified_at: 0 })
check(zero.kind === 'document' && soulEmptyLine(zero.document) !== null, 'a zero-byte file at time zero is a document, and empty')

console.log("2. the daemon's statements")
check(kind(fromRefusal('missing')) === 'noPersona', '404 not_found: no persona file yet')
check(kind(fromRefusal('link')) === 'linked', '409 not_a_regular_file: it is a link')
const big = fromRefusal('too_large')
check(big.kind === 'tooLarge' && big.limit === 262144, '413 too_large: over the limit it names')
check(kind(fromRefusal('unreadable')) === 'unreadable', '503 unreadable')
check(kind(fromRefusal('route_absent')) === 'daemonTooOld', '404 {"detail":"Not Found"}: a Prometheus without the route')
const words = (a: SoulAnswer): string => soulSentence(a) ?? ''
check(words(fromRefusal('missing')) === 'This Prometheus has no persona file yet.', 'the words for a missing file')
check(/too old/.test(words(fromRefusal('route_absent'))) && /next update/.test(words(fromRefusal('route_absent'))), 'the words for an older daemon')
check(/is a link/.test(words(fromRefusal('link'))) && /Replace it/.test(words(fromRefusal('link'))), 'the words for a link')
check(words(big) === 'The persona file is over 256 KB, which is too large to show here.', 'the words for a file that is too large say 256 KB, not 256.0')
check(/couldn't read its persona file/.test(words(fromRefusal('unreadable'))), 'the words for an unreadable file')
check(kind(soulFromError(thrown(fx.refusals.missing.status, fx.refusals.missing.body, false))) === 'noPersona', 'the message reads the same without the bridge\'s prefix')
check(soulFromError(thrown(413, { error: 'too_large' })).kind === 'tooLarge' && (soulFromError(thrown(413, { error: 'too_large' })) as { limit: number | null }).limit === null, 'a limit the daemon did not say is none, and the sentence has no number')
check(words(soulFromError(thrown(413, { error: 'too_large' }))) === 'The persona file is too large to show here.', 'and says so without one')
check((soulFromError(thrown(413, { error: 'too_large', limit: 'big' })) as { limit: number | null }).limit === null && (soulFromError(thrown(413, { error: 'too_large', limit: -4 })) as { limit: number | null }).limit === null && (soulFromError(thrown(413, { error: 'too_large', limit: 1.5 })) as { limit: number | null }).limit === null, 'a limit that is not a count is none')

console.log('3. not mistaken for a statement')
const failed = (e: unknown): boolean => soulFromError(e).kind === 'failed'
check(failed(thrown(404, { detail: 'Not Found', error: 'not_found' })) === false, 'both 404 shapes at once: the file\'s own code wins')
check(failed(thrown(404, '')), 'a 404 with no body is not "no persona file"')
check(failed(thrown(404, 'Not Found')), 'a 404 with a plain-text body is not "no persona file" either')
check(failed(thrown(404, { detail: 'Something else' })), 'a 404 about something else is an error')
check(failed(thrown(404, { error: 'other' })), 'a 404 with another code is an error')
check(soulFromError(thrown(403, { error: 'operator_only' })).kind === 'refused' && soulFromError(thrown(401, { detail: 'Unauthorized' })).kind === 'refused', 'a 403 or 401 is a refusal of this device, not a statement about the file')
check(words({ kind: 'refused' }) === "Prometheus won't show its persona to this device." && !failed(thrown(403, {})), 'with its own words, and no retry offered (see wiring)')
check(failed(thrown(500, { error: 'not_found' })), 'a code on the wrong status is an error')
check(failed(thrown(409, { error: 'too_large' })), 'and the wrong code on a status')
check(failed(thrown(503, { error: 'not_found' })), 'a 503 that is not "unreadable"')
check(failed(thrown(413, {})), 'a 413 with no code')
check(failed(new Error('fetch failed')) && failed(new Error('')) && failed(null) && failed(undefined) && failed('boom') && failed({}), 'no answer at all, and things that are not errors')
check(failed(new Error('HTTP 404: GET /api/memory/current — {"error":"not_found"}')), 'an answer about another route is not about the persona')
check(failed(thrown(404, [1])) && failed(thrown(404, 'null')) && failed(thrown(404, '7')), 'a body that is JSON but not an object')
check(words({ kind: 'failed' }) === "Beacon couldn't read the persona just now.", 'a failure says so plainly')
check(Object.values({ a: words({ kind: 'failed' }), b: words(fromRefusal('missing')), c: words(fromRefusal('route_absent')), d: words(big), e: words(fromRefusal('link')), f: words(fromRefusal('unreadable')) }).every((t) => !/\b[45]\d\d\b|HTTP|\/api\/|operator|error|null|undefined/i.test(t)), 'no sentence carries a code, a route or jargon')

console.log('4. words')
check(soulSize(1) === '1 byte' && soulSize(0) === '0 bytes' && soulSize(189) === '189 bytes' && soulSize(1023) === '1023 bytes', 'small sizes')
check(soulSize(1024) === '1.0 KB' && soulSize(1536) === '1.5 KB' && soulSize(262144) === '256.0 KB' && soulSize(262144, true) === '256 KB', 'kilobytes, and whole ones when asked')
check(soulSize(1_048_576) === '1.0 MB' && soulSize(3_145_728) === '3.0 MB', 'megabytes')
check(soulEdited(1793667600) === 'Edited 2026-11-03' && soulEdited(0) === 'Edited 1970-01-01', 'the edited day is the file\'s own, in UTC (the phone\'s format)')
check(soulEdited(1793663999.9) === 'Edited 2026-11-02' && soulEdited(1793664000) === 'Edited 2026-11-03', 'a time just before midnight UTC does not throw')
check(/did not say/.test(soulEdited(Number.NaN)) && /did not say/.test(soulEdited(1e20)), 'a time that is not a time says so')
const short = soulShown({ content: 'abc', bytes: 3, modifiedAt: 1 })
check(short.text === 'abc' && short.note === null, 'a short persona is shown whole')
const long = soulShown({ content: 'x'.repeat(SOUL_DISPLAY_LIMIT + 5), bytes: SOUL_DISPLAY_LIMIT + 5, modifiedAt: 1 })
check(long.text.length === SOUL_DISPLAY_LIMIT && long.note === 'Showing the first 100,000 of 100,005 characters.', 'a long one is clipped, and says how much')
const exact = soulShown({ content: 'x'.repeat(SOUL_DISPLAY_LIMIT), bytes: 1, modifiedAt: 1 })
check(exact.note === null, 'exactly the limit is not clipped')
const emoji = soulShown({ content: '😀'.repeat(6), bytes: 24, modifiedAt: 1 }, 4)
check(emoji.text === '😀😀😀😀' && /first 4 of 6/.test(emoji.note ?? ''), 'clipping counts characters and never cuts one in half')
check(soulShown({ content: '<img src=x onerror=alert(1)>', bytes: 1, modifiedAt: 1 }).text === '<img src=x onerror=alert(1)>', 'markup is returned as the text it is')

console.log('5. wiring')
const src = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
const tab = src('src/renderer/src/components/SoulTab.tsx')
const panel = src('src/renderer/src/components/ConfigPanel.tsx')
const ids = CONFIG_TABS.map((t) => t.id)
check(ids.indexOf('soul') === ids.indexOf('memory') + 1, 'the Soul tab sits right after Memory')
check(CONFIG_TABS.find((t) => t.id === 'soul')?.label === 'Soul' && CONFIG_TABS.find((t) => t.id === 'soul')?.path === '', 'it is called Soul and asks for itself (no seed GET to swallow the daemon\'s statements)')
check(/\['telemetry', 'usage', 'memory', 'soul', 'sentinel'\]/.test(panel), 'and is grouped with Memory in the strip')
check(/id === 'soul'\) return <SoulTab \/>/.test(panel), 'the panel mounts it')
check(isOwnerOnlyConfigTab('soul') && /owner of this Prometheus/.test(ownerOnlyText('soul')) && /persona/.test(ownerOnlyText('soul')), 'the route is the owner\'s: an approved device gets the note, and the tab never mounts for it')
check(configTabVisible('soul', 'everyday') && configTabVisible('soul', 'full'), 'shown wherever Memory is')
check(/daemon\.get\(SOUL_PATH\)/.test(tab), 'one read of /api/soul')
check(!/daemon\.write|<textarea|<input|contentEditable|contenteditable/.test(tab) && /Read-only\./.test(tab), 'no write and no editor: read-only, and it says so')
check(!/dangerouslySetInnerHTML|innerHTML|marked|markdown/i.test(tab), 'the text is shown as text, never as markup')
check(/<pre\b/.test(tab) && /soulShown\(d\)/.test(tab), 'in a plain block, clipped by the rule')
check(!/refused[\s\S]{0,40}Try again/.test(tab), 'a refusal does not offer to try again')
check(/Try again/.test(tab) && /answer\.kind === 'failed'/.test(tab), 'only a failure offers to try again')
