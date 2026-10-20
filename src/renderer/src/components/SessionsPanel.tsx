import { useMemo, useState, type CSSProperties } from 'react'
import type { SessionSummary } from '@shared/ipc'
import { buildSessionTree } from '@shared/session-tree'
import {
  isPurgeConfirmed,
  parsePurgeResult,
  purgeBody,
  purgePath,
  purgeSummary,
  PURGE_TYPED_CONFIRM
} from '@shared/purge'

// Sessions view (Phase 5b) — the active-session tree (roots + nested subagents) from the existing
// /api/sessions data (no new daemon call). Click a row to open it in Chat.

const MONO = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
const panel: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }
const head: CSSProperties = { padding: '10px 16px', borderBottom: '1px solid var(--c-line)', background: 'var(--c-raise)', flexShrink: 0 }

function ago(ms?: number): string {
  if (!ms) return ''
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

function Row({
  s,
  indent,
  active,
  onOpen,
  onPurge
}: {
  s: SessionSummary
  indent: number
  active: boolean
  onOpen: (id: string) => void
  onPurge?: (id: string) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
    <button
      onClick={() => onOpen(s.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '7px 16px',
        paddingLeft: 16 + indent * 20,
        background: active ? 'var(--c-raise)' : 'transparent',
        border: 'none',
        borderLeft: `2px solid ${active ? 'var(--c-arc)' : 'transparent'}`,
        cursor: 'pointer',
        textAlign: 'left',
        font: 'inherit'
      }}
    >
      {indent > 0 ? <span style={{ color: 'var(--c-line)', fontFamily: MONO, fontSize: 12 }}>└</span> : null}
      <span style={{ flex: 1, fontFamily: MONO, fontSize: 13, color: active ? 'var(--c-text)' : 'var(--c-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {s.id}
      </span>
      {s.gateway ? <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'var(--c-inset)', color: 'var(--c-text-dim)' }}>{s.gateway}</span> : null}
      <span style={{ fontSize: 11, color: 'var(--c-text-faint)', flexShrink: 0 }}>{s.messageCount ?? 0} msg</span>
      <span style={{ fontSize: 11, color: 'var(--c-text-faint)', fontFamily: MONO, flexShrink: 0, width: 34, textAlign: 'right' }}>{ago(s.lastActive)}</span>
    </button>
    {/* Purge lives HERE and not beside the sidebar's ✕ on purpose: forget is a tidy-up, purge
        destroys the record. Two destructive-looking controls a few pixels apart is how the wrong
        one gets clicked. Muted until hover/focus so the rare, irreversible action is never the
        loudest thing on the row. */}
    {onPurge ? (
      <button
        onClick={() => onPurge(s.id)}
        title={`Purge ${s.id} — permanently delete its messages from the daemon's database`}
        aria-label={`Purge session ${s.id}`}
        style={{
          fontSize: 10,
          padding: '2px 8px',
          marginRight: 12,
          borderRadius: 5,
          border: '1px solid var(--c-line)',
          background: 'transparent',
          color: 'var(--c-text-faint)',
          cursor: 'pointer',
          font: 'inherit',
          flexShrink: 0
        }}
      >
        Purge…
      </button>
    ) : null}
    </div>
  )
}

export function SessionsPanel({
  sessions,
  active,
  onOpen,
  onPurged
}: {
  sessions: SessionSummary[]
  active: string
  onOpen: (id: string) => void
  /** Purge succeeded daemon-side — the host drops its local cache rows and refreshes. */
  onPurged?: (id: string) => void
}) {
  const tree = useMemo(() => buildSessionTree(sessions), [sessions])
  // The purge flow: arm (pick a row) → type PURGE → POST → report what actually went.
  const [arming, setArming] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ id: string; text: string; ok: boolean } | null>(null)

  const armed = arming !== null && isPurgeConfirmed(typed)

  const runPurge = async (): Promise<void> => {
    if (!arming || !armed || busy) return
    const id = arming
    setBusy(true)
    try {
      const raw = await window.beacon?.daemon.write(purgePath(id), purgeBody(id), 'POST')
      const res = parsePurgeResult(raw)
      setOutcome({ id, text: purgeSummary(res), ok: res.ok && !res.error })
      // Local cache only AFTER the daemon confirmed what it deleted — dropping local rows first
      // would leave a failed purge looking successful from this window.
      if (res.ok && !res.error) onPurged?.(id)
    } catch (e) {
      setOutcome({ id, text: `purge failed: ${e instanceof Error ? e.message.slice(0, 140) : String(e)}`, ok: false })
    } finally {
      setBusy(false)
      setArming(null)
      setTyped('')
    }
  }

  return (
    <div style={panel}>
      <div style={head}>
        <p style={{ fontSize: 12, color: 'var(--c-text-dim)', margin: 0 }}>
          {sessions.length} sessions · {tree.length} roots
        </p>
      </div>
      {arming ? (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--c-line)', background: 'var(--c-inset)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--c-err)', marginBottom: 4 }}>
            Purge this conversation permanently?
          </div>
          <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--c-text-dim)', marginBottom: 6, overflowWrap: 'anywhere' }}>{arming}</div>
          {/* Say exactly what each verb does. "Forget" is reversible-ish (the session resurfaces on
              new activity); this is not, and the difference is the whole reason for two buttons. */}
          <div style={{ fontSize: 12, color: 'var(--c-text-dim)', marginBottom: 10, maxWidth: 620, lineHeight: 1.5 }}>
            This deletes its messages and summaries from the daemon's database — including the search
            index, so the text stops being findable. <strong style={{ color: 'var(--c-text)' }}>There is no undo.</strong>{' '}
            Forget (✕ in the sidebar) only hides a session and keeps the history; use that if you just
            want a tidier list. Branches forked from this session keep their own copies and survive.
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && armed) void runPurge()
                else if (e.key === 'Escape') { setArming(null); setTyped('') }
              }}
              placeholder={`type ${PURGE_TYPED_CONFIRM} to enable`}
              aria-label="Type PURGE to confirm"
              spellCheck={false}
              style={{ fontSize: 12, padding: '5px 10px', width: 200, borderRadius: 6, border: '1px solid var(--c-line)', background: 'var(--c-void)', color: 'var(--c-text)', font: 'inherit' }}
            />
            <button
              onClick={() => void runPurge()}
              disabled={!armed || busy}
              title={busy ? 'Purging…' : !armed ? `Type ${PURGE_TYPED_CONFIRM} first — this cannot be undone` : 'Delete this conversation permanently'}
              style={{
                fontSize: 12,
                padding: '5px 12px',
                borderRadius: 6,
                border: `1px solid ${armed && !busy ? 'var(--c-err)' : 'var(--c-line)'}`,
                background: armed && !busy ? 'var(--c-err-soft)' : 'transparent',
                color: armed && !busy ? 'var(--c-err)' : 'var(--c-text-faint)',
                cursor: armed && !busy ? 'pointer' : 'not-allowed',
                font: 'inherit'
              }}
            >
              {busy ? 'Purging…' : 'Purge permanently'}
            </button>
            <button
              onClick={() => { setArming(null); setTyped('') }}
              style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, border: '1px solid var(--c-line)', background: 'transparent', color: 'var(--c-text)', cursor: 'pointer', font: 'inherit' }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {outcome ? (
        <div
          role="status"
          style={{ padding: '8px 16px', borderBottom: '1px solid var(--c-line)', fontSize: 12, color: outcome.ok ? 'var(--c-text-dim)' : 'var(--c-err)', display: 'flex', gap: 10, alignItems: 'baseline' }}
        >
          <span style={{ flex: 1 }}>{outcome.text}</span>
          <button
            onClick={() => setOutcome(null)}
            aria-label="Dismiss purge result"
            style={{ background: 'transparent', border: 'none', color: 'var(--c-text-dim)', cursor: 'pointer', font: 'inherit' }}
          >
            ✕
          </button>
        </div>
      ) : null}
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
        {tree.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '64px 16px', color: 'var(--c-text-dim)', fontSize: 13 }}>No sessions</div>
        ) : (
          tree.map((node) => (
            <div key={node.session.id}>
              <Row s={node.session} indent={0} active={node.session.id === active} onOpen={onOpen} onPurge={setArming} />
              {node.children.map((c) => (
                <Row key={c.id} s={c} indent={1} active={c.id === active} onOpen={onOpen} onPurge={setArming} />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
