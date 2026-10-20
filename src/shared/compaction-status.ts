/**
 * The inline compaction status in chat (#283): what the "Tidying up the conversation…" line shows,
 * decided from the frames, with no React in it so compaction-status-smoke can drive every rule.
 *
 * Why it exists: since Prometheus #773 a compaction pass on a long cloud session is several
 * summarizer calls (one per chunk, then a combine) before the model call, tens of seconds to
 * minutes. Without a line of its own the chat shows "Pondering…" for all of it and the pause reads
 * as a stall.
 *
 * The rules:
 * - ONLY THE SESSION THE FRAME NAMES. A compaction frame must carry this session's id. ChatShell's
 *   deliversToSession lets a frame with no session id through (tool frames predate scoping), and a
 *   compaction line from another conversation in this one would be a false claim about this one.
 * - The bar is chunks_done / chunks_total, then the daemon's `progress`, else indeterminate. A value
 *   that makes no sense (more done than total, a progress over 1) is unknown, never clamped: a full
 *   bar drawn from a bad number is a claim the pass is nearly over.
 * - `done` and `noop` hide the line. `failed` leaves a short plain note, which stays through the
 *   reply that follows (it is about this turn) and goes when the operator sends the next message.
 *   A pass ended by Stop (`failed` with reason `cancelled`) just hides: it is not a failure.
 * - A running line also goes when the model call starts (a delta or a tool call) or the turn ends,
 *   so a pass whose end frame never arrives cannot leave a bar on screen forever.
 * - Announcements are polite and only at the edges (start, done, failed), never per chunk.
 */

export const COMPACTION_STAGES = ['start', 'progress', 'done', 'failed', 'noop'] as const
export type CompactionStage = (typeof COMPACTION_STAGES)[number]

export function isCompactionStage(s: unknown): s is CompactionStage {
  return typeof s === 'string' && (COMPACTION_STAGES as readonly string[]).includes(s)
}

export const COMPACTION_RUNNING_TEXT = 'Tidying up the conversation so we can keep going…'
export const COMPACTION_FAILED_TEXT = 'Couldn’t tidy up the conversation. Continuing with all of it.'
export const COMPACTION_START_ANNOUNCE = 'Tidying up the conversation so we can keep going.'
export const COMPACTION_DONE_ANNOUNCE = 'Finished tidying up the conversation.'

/** The frame fields the bar reads. */
export interface CompactionFields {
  progress?: number
  chunksDone?: number
  chunksTotal?: number
}

export interface CompactionState {
  /** What the chat shows: the running line with its bar, the failure note, or nothing. */
  show: 'running' | 'failed' | 'none'
  /** 0..1 while running when the daemon says how far along it is; null = indeterminate. */
  fraction: number | null
  /** The polite live region's text. Changes only at start, done and failed. */
  announce: string
}

export const COMPACTION_IDLE: CompactionState = { show: 'none', fraction: null, announce: '' }

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0

/** How far along the pass is, 0..1, or null when the frame does not say (or says nonsense). */
export function compactionFraction(f: CompactionFields): number | null {
  if (isCount(f.chunksDone) && isCount(f.chunksTotal) && f.chunksTotal > 0 && f.chunksDone <= f.chunksTotal) {
    return f.chunksDone / f.chunksTotal
  }
  if (typeof f.progress === 'number' && Number.isFinite(f.progress) && f.progress >= 0 && f.progress <= 1) {
    return f.progress
  }
  return null
}

/** The frame fields the rules read: a ChatStreamFrame, structurally, so a test can build one literally. */
export interface CompactionInput extends CompactionFields {
  kind: string
  sessionId?: string
  stage?: string
  role?: string
  /** Why a pass failed. Only read to tell a stopped turn from a real failure. */
  reason?: string
}

/** The reason the daemon gives when the turn was stopped mid-pass (Prometheus #784): not a failure to
 *  tidy up, so no note. The turn's own "stopped" already says what happened. */
export const COMPACTION_STOPPED_REASON = 'cancelled'

/** The next state after one frame, for the chat showing `sessionId`. Returns `prev` itself when the
 *  frame changes nothing, so a caller can skip a render. */
export function nextCompaction(prev: CompactionState, f: CompactionInput, sessionId: string): CompactionState {
  if (f.sessionId !== sessionId) return prev

  if (f.kind === 'compaction') {
    switch (f.stage) {
      case 'start':
        return { show: 'running', fraction: compactionFraction(f), announce: COMPACTION_START_ANNOUNCE }
      case 'progress':
        return {
          show: 'running',
          fraction: compactionFraction(f),
          // Opened mid-pass: the start was never seen, so this is the first word of it.
          announce: prev.show === 'running' ? prev.announce : COMPACTION_START_ANNOUNCE
        }
      case 'done':
        return { show: 'none', fraction: null, announce: prev.show === 'running' ? COMPACTION_DONE_ANNOUNCE : prev.announce }
      case 'noop':
        return prev.show === 'none' ? prev : { show: 'none', fraction: null, announce: '' }
      case 'failed':
        if (f.reason === COMPACTION_STOPPED_REASON) return { show: 'none', fraction: null, announce: '' }
        return { show: 'failed', fraction: null, announce: COMPACTION_FAILED_TEXT }
      default:
        return prev
    }
  }

  // The model call has started, or the turn is over: the pass is behind us whatever frame was lost.
  if (prev.show === 'running' && (f.kind === 'delta' || f.kind === 'tool_start' || f.kind === 'done' || f.kind === 'error')) {
    return { show: 'none', fraction: null, announce: prev.announce }
  }
  // The operator's next message starts a new exchange; the old failure is not about it.
  if (prev.show === 'failed' && f.kind === 'message' && f.role === 'user') {
    return { show: 'none', fraction: null, announce: '' }
  }
  return prev
}

/**
 * Did this frame end a pass in the chat showing `sessionId`? While a pass runs the daemon's pulse says
 * `compacting`, and the pulse is sampled every ~3 s, so the last one seen can outlive the pass: the
 * live check showed "Tidying up…" for 2 s after the line had gone and "Finished" had been announced.
 * ChatShell drops a readout still in that phase when this is true, and the next pulse brings back a
 * fresh one.
 */
export function endsCompaction(f: CompactionInput, sessionId: string): boolean {
  return f.kind === 'compaction' && f.sessionId === sessionId && (f.stage === 'done' || f.stage === 'failed' || f.stage === 'noop')
}
