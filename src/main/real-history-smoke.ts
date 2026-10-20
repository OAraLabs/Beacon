/**
 * real-history-smoke — coalesceToolResults against a REAL exported session.
 *
 * The unit smokes use synthetic rows. This one runs the actual reported bug:
 * a 79-row session from the live daemon (2026-07-31) where the user saw their
 * own messages "disappear" behind a wall of empty bubbles after reloading.
 *
 * Cause (daemon side is CORRECT): the engine stores each tool result as its own
 * role=user row — the OpenAI wire convention. Beacon rendered rows by raw role,
 * so every tool result became an empty USER bubble and every tool-only
 * assistant turn an empty ASSISTANT bubble, burying the real conversation.
 *
 * Pass a JSON export via BEACON_HISTORY_FIXTURE (array of {role, content}).
 * Without it the check is skipped, so CI never depends on a local file.
 *
 * Run: BEACON_HISTORY_FIXTURE=/tmp/real_rows.json npm run smoke:real-history
 */
import { readFileSync } from 'node:fs'
import { coalesceToolResults } from '@shared/timeline'
import { partsFromContentJson, type ContentPart } from '@shared/parts'

/** Raw export shape, mirroring HistoryMessage from the daemon. */
interface RawRow {
  role: string
  contentJson: string | null
  content: string
  rowId?: number | null
}

interface Row {
  role: string
  content: string | ContentPart[]
  rowId?: number | null
}

let failures = 0
function check(cond: boolean, label: string): void {
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}`)
    failures += 1
  }
}

/** A row the UI would render as an empty bubble: no text, no tool card. */
function isEmptyBubble(r: Row): boolean {
  if (typeof r.content === 'string') return r.content.trim().length === 0
  const parts = r.content
  if (parts.length === 0) return true
  const hasText = parts.some((p) => p.type === 'text' && (p.text ?? '').trim().length > 0)
  const hasCard = parts.some((p) => p.type === 'toolCall')
  return !hasText && !hasCard
}

const fixture = process.env.BEACON_HISTORY_FIXTURE
if (!fixture) {
  console.log('\n=== real-history: SKIPPED (set BEACON_HISTORY_FIXTURE) ===\n')
  process.exit(0)
}

// Mirror the production path EXACTLY: fromHistory() runs partsFromContentJson
// (wire block names tool_use/tool_result → ContentPart toolCall/toolResult)
// BEFORE coalesceToolResults ever sees a row. Feeding raw wire parts here
// would test a shape the app never produces.
const raw: RawRow[] = JSON.parse(readFileSync(fixture, 'utf-8'))
const rows: Row[] = raw.map((r) => ({
  role: r.role,
  content: partsFromContentJson(r.contentJson, r.content),
  rowId: r.rowId ?? null
}))
console.log(`\n=== real history: ${rows.length} rows from ${fixture} ===`)

const beforeEmpty = rows.filter(isEmptyBubble).length
const userTextBefore = rows.filter(
  (r) => r.role === 'user' && !isEmptyBubble(r)
).length

const after = coalesceToolResults(rows)
const afterEmpty = after.filter(isEmptyBubble).length
const userTextAfter = after.filter((r) => r.role === 'user' && !isEmptyBubble(r)).length

console.log(`  rows            ${rows.length} → ${after.length}`)
console.log(`  empty bubbles   ${beforeEmpty} → ${afterEmpty}`)
console.log(`  real user msgs  ${userTextBefore} → ${userTextAfter}`)

check(beforeEmpty > 0, 'the fixture actually reproduces the bug (empty bubbles before)')
check(afterEmpty < beforeEmpty, 'coalescing removes empty bubbles')
check(
  userTextAfter === userTextBefore,
  "every real user message survives — none of the user's own text is dropped"
)
check(after.length < rows.length, 'result-only rows collapse into their tool card')

// The user's actual complaint, quantified: what fraction of rendered rows were noise?
const noiseBefore = Math.round((100 * beforeEmpty) / rows.length)
const noiseAfter = Math.round((100 * afterEmpty) / Math.max(after.length, 1))
console.log(`  noise           ${noiseBefore}% → ${noiseAfter}% of rendered rows`)
check(noiseAfter < 20, 'post-fix, empty bubbles are a small minority of rendered rows')

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`)
process.exit(failures === 0 ? 0 : 1)
