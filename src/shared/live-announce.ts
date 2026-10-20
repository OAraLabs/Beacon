// Which finished message, if any, a screen reader should hear NEXT.
//
// WHY THIS IS NOT "PUT aria-live ON THE MESSAGE LIST". That is the obvious fix and it is wrong here,
// for a reason specific to how streaming renders. The chat reducer MUTATES THE SAME ROW per delta
// (ChatShell's `delta` case appends to the existing UiMessage rather than adding a node), so a live
// region over the list fires on every token — a reply arrives as a few hundred announcements. And
// `role="log"` carries an IMPLICIT aria-live="polite", so adding the role for structure alone would
// create that same flood by accident. Settled text, announced once, is the only usable behavior.
//
// WHY A HIDDEN REGION AND NOT THE VISIBLE ROW. Announcing a row when it FINALIZES cannot be done by
// making the visible row live: by then the node already exists, so an additions-only live region
// never sees it, and a text-watching one sees every token on the way. So the finished text is
// published into a visually-hidden live region as a NEW node, once per turn. The visible list keeps
// its structure for navigation and its rows stay out of the announcement path entirely.
//
// WHY THIS SHARES THE RULE WITH READ-ALOUD. ChatShell already speaks the newest FINISHED reply aloud
// when that toggle is on, and its comment records the reasoning: "speaking a partial reply means
// starting over every few tokens, and the synthesiser has no way to resume mid-sentence." A screen
// reader has exactly the same problem, so this is the same decision reached from the other direction
// — one rule, two consumers. Read-aloud is opt-in and drives speechSynthesis; this is always present
// and drives the accessibility tree. Different mechanism, identical "finished, once, no backlog".
//
// PURE. No DOM, no React: the caller owns the element and the ref that remembers what was announced.

export interface AnnounceRow {
  /** Stable row key (ChatShell's UiMessage.key). Identity for "already announced". */
  key: string
  /** Row role. Only non-user rows are announced — see nextAnnouncement. */
  role: string
  /** True while the row is still receiving deltas. A pending row is never announced. */
  pending?: boolean
  /** Flat text of the row, already stripped of markup by the caller. */
  text: string
  /** The turn was stopped (the daemon's chat_done carried interrupted:true). Settled, but partial. */
  interrupted?: boolean
}

export interface Announcement {
  /** The row being announced, so the caller can remember it as the new watermark. */
  key: string
  /** The text to publish into the live region. */
  text: string
  /** The announced row was a STOPPED turn — partial text, not a finished reply. */
  interrupted?: boolean
}

/**
 * The one message to announce now, or null.
 *
 * @param rows     the rendered list, oldest first (ChatShell's `rendered` order).
 * @param lastKey  the key last announced, or null when nothing has been announced yet in this mount.
 * @param speakable  whether a text is worth saying. Defaults to "has non-whitespace content" —
 *                 ChatShell passes @shared/speech-text's speakable() so the two consumers agree on
 *                 what counts, and an image-only or blank row announces nothing.
 *
 * Three rules, each because the alternative is noise:
 *   1. NEVER a pending row — that is the token flood.
 *   2. Only the NEWEST such row — a burst of completions announces the latest, not all of them. A
 *      screen reader user catching up on a backlog wants where the conversation IS, not a recital.
 *   3. A `lastKey` of null means "nothing has been seen yet", so the newest settled row IS news and
 *      is returned. Suppressing the backlog recital is therefore the CALLER's job, done by arming
 *      the watermark with `initialWatermark()` before the first call — not something this function
 *      can infer, because "empty session, nothing seen" and "backlog already on screen" are the same
 *      null and deserve opposite treatment. Conflating them is a bug with a specific symptom: every
 *      session open recites the last message the user has already read.
 *
 * Only non-user rows are announced. The user's own message is text they just typed or dictated, and
 * an echoed-back announcement of your own words is the classic screen-reader annoyance. Machine
 * notices ride the user role too, so this also keeps tool results out of the stream — they have
 * their own surfaces (the tool timeline). Read-aloud draws the same line.
 */
export function nextAnnouncement(
  rows: readonly AnnounceRow[],
  lastKey: string | null,
  speakable: (text: string) => boolean = (t) => t.trim().length > 0
): Announcement | null {
  // Newest first, so the scan stops at the first settled, speakable, non-user row.
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    // Reaching the watermark ends the scan: it and everything older has been heard. This comes BEFORE
    // the skips, because the marked row may itself be unspeakable (a tool-call-only turn has no text);
    // checked after them, the scan walked past such a mark and recited the reply before it. A null
    // watermark means "nothing seen yet" and the candidate is genuinely news (see rule 3).
    if (lastKey !== null && r.key === lastKey) return null
    if (r.role === 'user') continue
    if (r.pending) continue
    if (!speakable(r.text)) continue
    return { key: r.key, text: r.text, interrupted: r.interrupted === true }
  }
  return null
}

/**
 * The watermark to arm on when a conversation first becomes visible, so its backlog is NOT announced.
 *
 * Separate from `nextAnnouncement` because arming is a different act with a different result: it
 * names a row to treat as already-heard and publishes nothing. Folding it into nextAnnouncement
 * would mean overloading a null watermark to signify both "not armed" and "nothing seen yet", and
 * those two states need opposite behavior — see rule 3 there.
 *
 * Returns the newest settled non-user row's key, or null when there isn't one (an empty session, or
 * one whose only rows so far are the user's own). Null is a CORRECT result, not a failure: it means
 * "nothing to mark as seen", so the next row to settle will be announced as new — which is exactly
 * right for a fresh session, where the first reply SHOULD be heard.
 *
 * Call this once per conversation, on the first render that has rows. ChatShell remounts per session
 * switch, so a fresh mount re-arms and switching sessions never recites the one you landed on.
 */
export function initialWatermark(rows: readonly AnnounceRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (r.role === 'user') continue
    if (r.pending) continue
    return r.key
  }
  return null
}

/**
 * The words to publish for an announcement. `clean` strips markup (ChatShell passes speechText).
 *
 * A STOPPED turn is settled but partial: the daemon kept what the agent had produced when Stop was
 * pressed, here or in any other client. The visible row marks it "stopped"; read without that, the
 * partial text sounds like the agent's complete answer. So it is prefixed, and the prefix is not
 * passed through `clean`, which exists to strip markup from the agent's text, not from ours.
 */
export function spokenAnnouncement(a: Announcement, clean: (text: string) => string = (t) => t): string {
  const body = clean(a.text)
  return a.interrupted ? `Reply stopped. ${body}` : body
}
