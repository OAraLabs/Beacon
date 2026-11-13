// Quick capture (the ⌘⇧Space mini composer): the pure model, shared by its window, main and the
// headless smoke. No DOM, no Electron.
//
// WHAT THE WINDOW CAN CARRY. Text, as before, and now what is on the clipboard (⌘V of files or an
// image), files from a picker, and a screenshot. All of it goes out on the same upload path the
// main composer uses, with the same 20 MB refusal (@shared/attachments).
//
// WHY THERE IS A "HOLD". The window hides when it loses focus, which is what makes it feel like a
// spotlight box. A file picker and a screenshot both take focus away on purpose, and without a
// hold the window would vanish under the dialog it had just opened. The hold is narrow: the
// renderer asks for it right before one of those two things and main drops it the moment the
// window is focused, hidden or toggled again, so a stuck hold cannot leave the box on screen.

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
 *  source id (BrowserWindow.getMediaSourceId), or null for any other window, which lists itself. */
export function captureSources<T extends Pick<CaptureSource, 'id'>>(sources: readonly T[], ownId: string | null): T[] {
  return ownId ? sources.filter((s) => s.id !== ownId) : [...sources]
}

/** Main's blur rule: the window hides when it loses focus, unless it asked to be held. */
export function hidesOnBlur(held: boolean): boolean {
  return !held
}

/** Longest a hold lasts if nothing releases it. A picker left open is the one honest reason. */
export const CAPTURE_HOLD_MAX_MS = 120_000
