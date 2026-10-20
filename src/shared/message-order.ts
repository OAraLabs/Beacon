// Pure chat-transcript row ordering. Lives in `shared` so the headless smoke can prove it without a
// renderer/DOM.
//
// Durable LCM rowids are monotonic + restart-stable, so CONFIRMED rows sort by rowId. But live rows
// arrive rowid-less, and asymmetrically so: the daemon echoes the durable rowid for a USER message
// (the chat_message frame) yet streams an ASSISTANT reply with only a synthetic handle
// (chat_delta/chat_done) — so mid-conversation the assistant rows have `rowId === null` while the
// user rows around them are already confirmed. Sinking every null row to the bottom (the old
// behavior) therefore stacked all user messages above all assistant replies.
//
// Instead, a rowid-less row INHERITS the running-max rowid of everything before it (+0.5) — i.e. it
// sorts right after the row it was inserted after, which is its true chronological slot. Insertion
// index breaks ties within a run of consecutive unconfirmed rows. Reload is unaffected: every row
// then carries a rowid, there are no nulls, and this reduces to a plain ascending rowId sort.
// (rowids are integers, so the +0.5 fractional key never collides with a real one.)
export function orderForRender<T extends { rowId: number | null }>(rows: T[]): T[] {
  let lastRow = -1
  return rows
    .map((m, i) => {
      if (m.rowId !== null) lastRow = Math.max(lastRow, m.rowId)
      return { m, i, sort: m.rowId ?? lastRow + 0.5 }
    })
    .sort((a, b) => a.sort - b.sort || a.i - b.i)
    .map((x) => x.m)
}

/** The fields of a streamed row that a `chat_done` finalizes. Structural, so a smoke can build one
 *  literally and ChatShell can pass its own richer row through it. */
export interface FinalizableRow {
  key: string
  rowId: number | null
}

/**
 * How a `chat_done` finalizes a streamed assistant row (P9.8, Prometheus#129).
 *
 * The daemon puts the turn's durable rowid on the frame precisely so the client can re-key its
 * streamed bubble WITHOUT waiting on a `?since=` re-read. Taking it closes a window that otherwise
 * lasts until reconcile completes: in that window the row's rowId is null, so anything keyed on a
 * real rowid — an edit-into-branch fired right after the reply lands — computes its fork point
 * THROUGH the fractional placeholder `orderForRender` assigns to null-rowid rows (lastRow+0.5),
 * forking before the reply instead of after it.
 *
 * On a present rowId this returns the row re-keyed to `str(rowId)` — the SAME key reconcile assigns
 * when it later pulls the durable row — so the re-key and the reconcile converge on one row and
 * never leave a duplicate. On an absent/invalid rowId (older daemon, or a persist that surfaced
 * none — the wire omits the key rather than sending null) the row only leaves its pending state and
 * keeps its synthetic key; reconcile fills the real rowid in, exactly as before.
 */
export function finalizeRow<T extends FinalizableRow>(row: T, rowId: number | undefined): T {
  if (typeof rowId === 'number' && Number.isFinite(rowId) && rowId > 0) {
    return { ...row, key: String(rowId), rowId }
  }
  return row
}
