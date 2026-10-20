import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { isAuthError, type SkillDraftDTO } from '@shared/daemon-api'
import { NotAuthorized } from './NotAuthorized'

// Skills view (Gap 4): the GEPA skill-draft review loop, formerly Telegram-only. Polls the daemon's
// pending drafts (GET /api/learning/skill-drafts), shows the proposed SKILL.md, and resolves it
// binary (accept / reject) over the same REST paths the Telegram reviewer uses. Polling matches the
// approvals pattern (REST-poll, no WS push).

const panel: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }
const head: CSSProperties = { padding: '10px 16px', borderBottom: '1px solid var(--c-line)', background: 'var(--c-raise)', flexShrink: 0 }
const body: CSSProperties = { flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }
const card: CSSProperties = { background: 'var(--c-base)', border: '1px solid var(--c-line)', borderRadius: 10, overflow: 'hidden' }
const cardHead: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--c-line)', background: 'var(--c-raise)' }
const cardBody: CSSProperties = { padding: '10px 14px' }
// Disabled is a visible state (see DevicesPanel btn): the flag drives prop + style together.
const btn = (c: string, disabled = false): CSSProperties => ({
  padding: '5px 12px',
  fontSize: 12,
  fontWeight: 600,
  background: 'transparent',
  border: `1px solid ${disabled ? 'var(--c-line)' : c}`,
  borderRadius: 6,
  color: disabled ? 'var(--c-text-faint)' : c,
  cursor: disabled ? 'not-allowed' : 'pointer',
  font: 'inherit'
})
const empty: CSSProperties = { padding: 40, textAlign: 'center', color: 'var(--c-text-dim)', fontSize: 13, lineHeight: 1.6 }

function age(iso?: string): string {
  const t = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function DraftCard({ draft }: { draft: SkillDraftDTO }) {
  const [content, setContent] = useState<string | null>(null)
  const [edited, setEdited] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Lazy-fetch the draft body on first expand — the list endpoint ships sidecars only.
  const toggle = async (): Promise<void> => {
    const b = window.beacon
    if (!b) return
    const next = !open
    setOpen(next)
    if (next && content === null) {
      try {
        const res = (await b.daemon.get(`/api/learning/skill-drafts/${encodeURIComponent(draft.draft_id)}`)) as { content?: string }
        setContent(res?.content ?? '(no content)')
      } catch (e) {
        setContent(`failed to load: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  const resolve = async (action: 'accept' | 'reject'): Promise<void> => {
    const b = window.beacon
    if (!b) return
    setBusy(true)
    setError(null)
    try {
      // Beacon redline: an edited draft is accepted as-edited (the daemon persists the edit).
      const body = action === 'accept' && edited !== null && edited !== content ? { content: edited } : undefined
      await b.daemon.write(`/api/learning/skill-drafts/${encodeURIComponent(draft.draft_id)}/${action}`, body, 'POST')
      // The 5s poll removes the card; an accept that the daemon's persistence rejected (422) throws,
      // leaving the draft in place with the reason surfaced inline.
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg.includes('422') ? 'Daemon rejected the content (missing/invalid frontmatter name:) — edit the draft file and retry.' : msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={card}>
      <div style={cardHead}>
        <span style={{ fontSize: 14 }}>🧠</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--c-text)' }}>{draft.title ?? draft.name ?? draft.draft_id}</div>
          <div style={{ fontSize: 11, color: 'var(--c-text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {draft.description || 'no description'}
          </div>
        </div>
        <span style={{ fontSize: 11, color: 'var(--c-text-faint)', flexShrink: 0 }}>
          {draft.source ?? '?'} · {age(draft.created_at)}
        </span>
        <span style={{ fontSize: 11, color: 'var(--c-text-faint)', flexShrink: 0 }}>
          {draft.step_count ?? 0} steps{typeof draft.parameter_count === 'number' ? ` · ${draft.parameter_count} params` : ''}
        </span>
      </div>
      <div style={cardBody}>
        <button
          style={{ ...btn('var(--c-text-dim)'), marginBottom: open ? 8 : 0, fontSize: 11 }}
          onClick={() => void toggle()}
        >
          {open ? 'Hide draft' : 'Show draft'}
        </button>
        {open && (
          <>
          <textarea
            value={edited ?? content ?? ''}
            onChange={(e) => setEdited(e.target.value)}
            readOnly={content === null}
            spellCheck={false}
            style={{
              width: '100%',
              margin: 0,
              padding: '10px 12px',
              background: 'var(--c-inset)',
              border: '1px solid var(--c-line)',
              borderRadius: 6,
              color: 'var(--c-text)',
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: 12,
              lineHeight: 1.5,
              minHeight: 160,
              maxHeight: 320,
              resize: 'vertical',
              overflowY: 'auto'
            }}
          >
            {content ?? ''}
          </textarea>
          {content === null && <div style={{ marginTop: 4, fontSize: 11, color: 'var(--c-text-faint)' }}>loading…</div>}
          </>
        )}
        {edited !== null && edited !== content && (
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--c-warn)' }}>edited — accepting will install your version</div>
        )}
        {error && (
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--c-err)' }}>{error}</div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button style={btn('var(--c-ok)', busy)} disabled={busy} title={busy ? 'Working…' : undefined} onClick={() => void resolve('accept')}>
            Accept
          </button>
          <button style={btn('var(--c-err)', busy)} disabled={busy} title={busy ? 'Working…' : undefined} onClick={() => void resolve('reject')}>
            Reject
          </button>
        </div>
      </div>
    </div>
  )
}

export function SkillsPanel() {
  const [drafts, setDrafts] = useState<SkillDraftDTO[]>([])
  const [authErr, setAuthErr] = useState(false)
  const [seen, setSeen] = useState(false)

  const poll = useCallback((): void => {
    const b = window.beacon
    if (!b) return
    void b.daemon
      .get('/api/learning/skill-drafts')
      .then((d) => {
        const list = (d as { drafts?: SkillDraftDTO[] })?.drafts
        setDrafts(Array.isArray(list) ? list : [])
        setAuthErr(false)
        setSeen(true)
      })
      .catch((e) => {
        if (isAuthError(e)) setAuthErr(true)
        setSeen(true)
      })
  }, [])

  useEffect(() => {
    poll()
    const id = setInterval(poll, 5000)
    return () => clearInterval(id)
  }, [poll])

  if (authErr)
    return (
      <div style={panel}>
        <div style={head}>
          <p style={{ fontSize: 12, color: 'var(--c-text-dim)', margin: 0 }}>GEPA skill-draft review</p>
        </div>
        <NotAuthorized what="skill drafts" />
      </div>
    )

  return (
    <div style={panel}>
      <div style={head}>
        <p style={{ fontSize: 12, color: 'var(--c-text-dim)', margin: 0 }}>
          Proposed skill drafts awaiting review — accept to install under skills/auto/, reject to discard
        </p>
      </div>
      <div style={body}>
        {seen && drafts.length === 0 ? (
          <div style={empty}>
            No pending skill drafts.
            <br />
            Drafts appear when GEPA or video ingestion proposes a new skill.
          </div>
        ) : (
          drafts.map((d) => <DraftCard key={d.draft_id} draft={d} />)
        )}
      </div>
    </div>
  )
}
