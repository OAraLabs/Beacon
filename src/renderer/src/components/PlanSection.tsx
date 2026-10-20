// The plan for one story — the RENDERING half, extracted from BoardPanel so a second surface
// cannot fork it. The previous commit was the verbatim move; THIS one makes it shareable.
//
// PlanBody is chrome-free and keyed by a story ID STRING, not a StoryDTO: it only ever read
// `story_id`, and a pane beside a conversation has no board card to hand it. `onToggle` is
// OPTIONAL — omitting it renders the checklist read-only, which is what a summary surface wants
// and what a truncated file requires anyway.
//
// PlanDrawer is now only the Board's chrome around PlanBody: the scrim, the 420px column, the
// title header and the Close button. The dock supplies all four itself, so a pane mounts PlanBody
// directly and inherits none of it.
//
// The style constants moved here with the component rather than being copied, so there stays
// exactly one definition of each; BoardPanel imports them back.

import type { CSSProperties } from 'react'
import { type StoryDTO } from '@shared/daemon-api'
import { PLAN_DIR, planFilename, type PlanState } from '@shared/plan'

export const MONO = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
export const badge: CSSProperties = { fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'var(--c-inset)', color: 'var(--c-text-dim)' }
export const cardBtn: CSSProperties = { fontSize: 10, padding: '2px 8px', borderRadius: 4, border: '1px solid var(--c-line)', background: 'transparent', color: 'var(--c-text-dim)', cursor: 'pointer', font: 'inherit' }

/**
 * The plan for one story. FOUR renderings, and none of them is a bare empty list.
 *
 * The middle two are the reason this component exists: a file that parses to zero task lines is a
 * plan with nothing tickable, NOT the absence of a plan, and a story_id matching two files is an
 * ambiguity rather than a tie to break. Observed 2026-09-18: the first real plan an agent wrote
 * under the documents instruction had zero checkboxes, so "render what parseTasks finds" would have
 * shown an empty checklist for a plan that plainly exists.
 */
export function PlanBody({
  storyId,
  state,
  err,
  onToggle
}: {
  storyId: string
  state: PlanState | null
  err: string | null
  /** Omitted ⇒ read-only. A surface that cannot write must not render a control that looks writable. */
  onToggle?: (path: string, content: string, lineIndex: number, done: boolean, truncated: boolean) => void
}) {
  return (
    <>
          {err ? (
            <div style={{ color: 'var(--c-err)', fontSize: 12 }}>
              Could not read the plan: {err}. This story may still have one — the read failed.
            </div>
          ) : state === null ? (
            <div style={{ color: 'var(--c-text-dim)', fontSize: 12 }}>Reading the plan…</div>
          ) : state.kind === 'no-plan' ? (
            <div style={{ color: 'var(--c-text-dim)', fontSize: 12, lineHeight: 1.5 }}>
              No plan file for this story yet. Ask the agent to draft one and save it for later —
              it writes to the documents library under <code style={{ fontFamily: MONO }}>{PLAN_DIR}/</code>,
              and a file named <code style={{ fontFamily: MONO }}>{planFilename(storyId, 'plan')}</code>
              {' '}shows up here. Any slug works; the <code style={{ fontFamily: MONO }}>{storyId}-</code> prefix is the join.
              {state.nearMisses.length ? (
                <div style={{ marginTop: 10, padding: '7px 10px', borderRadius: 6, background: 'var(--c-amber-soft)', color: 'var(--c-warn)' }}>
                  <strong>{state.nearMisses.length === 1 ? 'A file starts' : 'Files start'} with this
                  story's id but {state.nearMisses.length === 1 ? 'is' : 'are'} not claimed:</strong>{' '}
                  {state.nearMisses.map((f) => <code key={f} style={{ fontFamily: MONO }}>{f} </code>)}
                  — the part after <code style={{ fontFamily: MONO }}>{storyId}-</code> opens with
                  digits, which is the shape of a longer story id, so this may belong to that story
                  instead. Shown rather than dropped: a near miss is not an absence.
                </div>
              ) : null}
            </div>
          ) : state.kind === 'ambiguous' ? (
            <div style={{ color: 'var(--c-warn)', fontSize: 12, lineHeight: 1.5 }}>
              <strong>{state.paths.length} files match this story id.</strong> Showing none of them
              on purpose: <code style={{ fontFamily: MONO }}>story_id</code> has no UNIQUE constraint,
              so picking one would quietly show a plan that may belong to another story.
              <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
                {state.paths.map((f) => <li key={f} style={{ fontFamily: MONO, fontSize: 11 }}>{f}</li>)}
              </ul>
            </div>
          ) : state.kind === 'untickable' ? (
            <div>
              <div style={{ color: 'var(--c-warn)', fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
                <strong>This plan has no checkboxes.</strong> It exists — {state.path} — but nothing in
                it is tickable, so there is no checklist to show. Steps written as
                <code style={{ fontFamily: MONO }}> - [ ] step</code> render as a live checklist here.
                {!state.hasContent ? ' The file is also empty.' : ''}
                {state.truncated ? ' It is also larger than the daemon will return, so this is only its first part.' : ''}
              </div>
              <pre style={{ fontFamily: MONO, fontSize: 11, margin: 0, padding: 10, background: 'var(--c-inset)', borderRadius: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--c-text-dim)' }}>
                {state.content}
              </pre>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 12, color: 'var(--c-text-dim)', marginBottom: 8, fontFamily: MONO }}>
                {state.done}/{state.total} · {state.path}
              </div>
              {state.truncated ? (
                <div style={{ marginBottom: 10, padding: '7px 10px', borderRadius: 6, background: 'var(--c-amber-soft)', color: 'var(--c-warn)', fontSize: 12, lineHeight: 1.5 }}>
                  <strong>Read-only — this file is larger than the daemon will return.</strong> You are
                  seeing the first part of it, so the steps below are incomplete and ticking is
                  disabled: saving would write this excerpt over the whole file and delete the rest.
                </div>
              ) : null}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {state.tasks.map((t) => (
                  <label key={t.lineIndex} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 6px', borderRadius: 5, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={t.done}
                      disabled={state.truncated || !onToggle}
                      onChange={() => onToggle?.(state.path, state.content, t.lineIndex, !t.done, state.truncated)}
                      style={{ marginTop: 2 }}
                    />
                    <span style={{ fontSize: 13, color: t.done ? 'var(--c-text-faint)' : 'var(--c-text)', textDecoration: t.done ? 'line-through' : 'none' }}>
                      {t.text || '(empty)'}
                    </span>
                    {t.tag ? <span style={{ ...badge, fontSize: 9 }}>{t.tag}</span> : null}
                  </label>
                ))}
              </div>
            </div>
      )}
    </>
  )
}

/** The BOARD's chrome around PlanBody — scrim, 420px column, title header, Close. Board-only. */
export function PlanDrawer({
  story,
  state,
  err,
  onClose,
  onToggle
}: {
  story: StoryDTO
  state: PlanState | null
  err: string | null
  onClose: () => void
  onToggle: (path: string, content: string, lineIndex: number, done: boolean, truncated: boolean) => void
}) {
  const shell: CSSProperties = {
    position: 'absolute', inset: 0, background: 'var(--c-scrim)', display: 'flex',
    alignItems: 'stretch', justifyContent: 'flex-end', zIndex: 20
  }
  const body: CSSProperties = {
    width: 420, maxWidth: '100%', background: 'var(--c-base)', borderLeft: '1px solid var(--c-line)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden'
  }
  return (
    <div style={shell} onClick={onClose}>
      <div style={body} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--c-line)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...badge, fontFamily: MONO }}>{story.story_id}</span>
          <span style={{ fontSize: 13, color: 'var(--c-text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{story.title}</span>
          <button style={cardBtn} onClick={onClose}>Close</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
          <PlanBody storyId={story.story_id} state={state} err={err} onToggle={onToggle} />
        </div>
      </div>
    </div>
  )
}
