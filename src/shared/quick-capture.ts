// Quick capture (the ⌘⇧Space mini composer): the pure model, shared by its window, main and the
// headless smoke. No DOM, no Electron.
//
// WHAT THE WINDOW CAN CARRY. Text, as before, and now what is on the clipboard (⌘V of files or an
// image), files from a picker, and a screenshot. All of it goes out on the same upload path the
// main composer uses, with the same 20 MB refusal (@shared/attachments).
//
// WHY THERE IS A "HOLD". The window hides when it loses focus, which is what makes it feel like a
// spotlight box. Its own file picker takes focus away on purpose, and without a hold the window
// would vanish under the dialog it had just opened. The hold is narrow: the renderer asks for it
// right before the picker opens and gives it back when the picker answers; main also drops it when
// the window is focused or hidden, and after two minutes regardless, so a stuck hold cannot leave
// the box on screen. (A screenshot needs no hold: main hides the window itself for the shot.)

import type { CaptureSource } from './capture'

/** Settings key for the last conversation used (classified per-Prometheus in @shared/daemon-profiles). */
export const CAPTURE_TARGET_KEY = 'capture:session'

/** Where a capture goes when nothing else was ever chosen: one standing conversation. */
export const CAPTURE_DEFAULT_TARGET = 'desktop:quick'

/** The select's "start a new conversation" choice. Never stored and never sent as a session id. */
export const CAPTURE_NEW_TARGET = '\u0000new'

/** How many recent conversations the select lists. It is a quick box: past this, open Beacon. */
export const CAPTURE_TARGETS_MAX = 30

export interface CaptureTarget {
  value: string
  label: string
}

interface TargetSession {
  id: string
  title?: string
  lastActive?: number
}

const labelOf = (s: TargetSession): string => {
  const t = (s.title ?? '').trim()
  return t ? (t.length > 48 ? `${t.slice(0, 47)}…` : t) : s.id
}

/**
 * The choices in the target select: a new conversation first, then the one in use, then the most
 * recently active, by title. The one in use is always listed, even when it is old or not in the
 * list at all (the standing quick-capture conversation before its first message). `justStarted` is
 * a conversation this window made itself, which has no title to show yet.
 */
export function captureTargets(sessions: readonly TargetSession[], current: string, max = CAPTURE_TARGETS_MAX, justStarted: string | null = null): CaptureTarget[] {
  const out: CaptureTarget[] = [{ value: CAPTURE_NEW_TARGET, label: 'New conversation' }]
  const seen = new Set<string>([CAPTURE_NEW_TARGET])
  const add = (value: string, label: string): void => {
    if (!value || seen.has(value)) return
    seen.add(value)
    out.push({ value, label })
  }
  const byId = new Map(sessions.map((s) => [s.id, s]))
  if (current !== CAPTURE_NEW_TARGET) {
    const cur = byId.get(current)
    // A conversation this window started a moment ago has no title yet, and may not be listed yet.
    const named = cur && (cur.title ?? '').trim() ? labelOf(cur) : null
    add(current, named ?? (current === justStarted ? 'The conversation you just started' : current === CAPTURE_DEFAULT_TARGET ? 'Quick capture' : current))
  }
  const recent = [...sessions].sort((a, z) => (z.lastActive ?? 0) - (a.lastActive ?? 0))
  for (const s of recent) {
    if (out.length >= max + 1) break
    add(s.id, labelOf(s))
  }
  return out
}

/** The stored last target as the window should start on it. A stored "new" is ignored (it is never
 *  written, so finding one means a damaged row), and an empty row means the default. */
export function storedCaptureTarget(raw: string | null | undefined): string {
  const v = (raw ?? '').trim()
  return !v || v === CAPTURE_NEW_TARGET ? CAPTURE_DEFAULT_TARGET : v
}

/** Whether Enter does anything: there is text or a file, and nothing is already going out. */
export function captureCanSend(draft: string, files: number, busy: boolean): boolean {
  return !busy && (draft.trim().length > 0 || files > 0)
}

/** What can be captured, without the window that is asking when that is the quick-capture window:
 *  it is hidden for the shot, so a row for it could only ever fail. `ownId` is that window's media
 *  source id (BrowserWindow.getMediaSourceId), or null for any other window, which lists itself.
 *
 *  By id only, never by title: the box's title is the page's ("Beacon"), which is also the main
 *  window's with one Prometheus, and a title match would take the main window out of the list.
 *  The id is written the way the list writes ids (the probe checks that against the main window),
 *  and on macOS the system does not list a floating window like this one in the first place. */
export function captureSources<T extends Pick<CaptureSource, 'id'>>(sources: readonly T[], ownId: string | null): T[] {
  return ownId ? sources.filter((s) => s.id !== ownId) : [...sources]
}

/** Whether an IPC sender is the quick-capture window. By webContents id: a destroyed window, or
 *  none, matches nothing, and a recreated window has a new id. */
export function isCaptureSender(senderId: number, capture: { id: number; destroyed: boolean } | null): boolean {
  return capture !== null && !capture.destroyed && capture.id === senderId
}

// ── The hold, as a state machine ────────────────────────────────────────────────────────────────
// Main owns the timer; what each thing that happens does to the hold is decided here.

export type HoldEvent =
  | 'ask-on' // the window is about to open its file picker
  | 'ask-off' // the picker gave its answer (a choice or a cancel)
  | 'shot-returned-unfocused' // back from a screenshot, and the OS would not give it focus
  | 'focus' // the window has focus again
  | 'hide' // the window hid (toggle, Open in Beacon, a shot stepping out)
  | 'closed'
  | 'timeout' // CAPTURE_HOLD_MAX_MS passed with nothing else ending it

/** The hold after an event. */
export function holdAfter(held: boolean, ev: HoldEvent): boolean {
  if (ev === 'ask-on' || ev === 'shot-returned-unfocused') return true
  if (ev === 'ask-off' || ev === 'focus' || ev === 'hide' || ev === 'closed' || ev === 'timeout') return false
  return held
}

/** The window hides when it loses focus, unless it is held or is in the middle of a screenshot
 *  (it is already hidden for that, and must not be shown again under the grab). */
export function hidesOnBlur(held: boolean): boolean {
  return !held
}

/** When a hold times out, the window goes if it is still up without focus. */
export function hidesOnHoldTimeout(visible: boolean, focused: boolean): boolean {
  return visible && !focused
}

/** Whether the toggle (the global key, the menu item) does anything: not during a screenshot,
 *  when showing the box would put it in the picture. */
export function toggleAllowed(shooting: boolean): boolean {
  return !shooting
}

/** Longest a hold lasts if nothing releases it. A picker left open is the one honest reason. */
export const CAPTURE_HOLD_MAX_MS = 120_000

// ── Sending ─────────────────────────────────────────────────────────────────────────────────────

/** What goes back in the box after a send that did not all go out. `sent` files went and are not
 *  offered again (a retry would send them twice); the text rides on the LAST file, so it went only
 *  if every file did. Whatever the person typed or attached while the send was going out is kept,
 *  after what is put back. */
export function restoreAfterFailedSend<F>(
  wasText: string,
  wasFiles: readonly F[],
  sent: number,
  now: { draft: string; files: readonly F[] }
): { draft: string; files: F[] } {
  const unsent = wasFiles.slice(Math.max(0, Math.min(sent, wasFiles.length)))
  const draft = !now.draft.trim() ? wasText : wasText ? `${wasText}\n${now.draft}` : now.draft
  return { draft, files: [...unsent, ...now.files] }
}

/** Esc closes the box, which destroys its window, and a send is a loop in that window: closing
 *  part-way would drop the files not yet sent without a word. So Esc waits for the send. */
export function escClosesBox(sending: boolean): boolean {
  return !sending
}
