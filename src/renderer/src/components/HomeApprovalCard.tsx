import { useEffect, useState, type CSSProperties } from 'react'
import type { ApprovalDecision, ApprovalRequest } from '@shared/ipc'
import { approvalKey, isTypingTarget } from '@shared/approval-keys'
import { COLLAPSE_AFTER, homeCardView } from '@shared/home-approval'
import { Icon } from './Icon'
import { HomeTierBadge } from './HomeTierBadge'
import { approvalActionKey, approvalCardStyle, approvalHeaderStyle, approvalNoteStyle, approvalVerbChip } from './ExecApprovalCard'
import { trace } from '../ui-trace-client'

/**
 * The approval card for a Home Assistant control call (docs/HA-UI-DATA-CONTRACT.md §3.1).
 *
 * It renders what the daemon sent in `approval.home`: which devices, their tier, and current → requested
 * state, in the daemon's words. The card decides nothing. Three rules it keeps:
 *
 *   * A tier is a word and a glyph (HomeTierBadge), never a colour alone.
 *   * A lasting option appears only when homeCardView says so (Ordinary, or Sensitive with "Ask once" on
 *     for every device, and the daemon sent an extent). Its text is the daemon's extent, verbatim.
 *   * A Critical call has Deny only, and a sentence saying why.
 *
 * Same keys as the generic card: A approves once, D denies (@shared/approval-keys), and the lasting
 * options sit behind a disclosure, so nothing that outlives the call is one click from Approve.
 */

const body: CSSProperties = { padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 10 }
const list: CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, fontSize: 12.5, lineHeight: 1.4 }
const change: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--ink-soft)', overflowWrap: 'anywhere' }
const link: CSSProperties = { background: 'transparent', border: 'none', padding: 0, font: 'inherit', fontSize: 11.5, color: 'var(--lapis-text)', cursor: 'pointer', textAlign: 'left' }

function age(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`
}

export function HomeApprovalCard({
  approval,
  error,
  cannotApprove = null,
  disclosureOpen = false,
  onToggleDisclosure,
  first,
  onResolve
}: {
  approval: ApprovalRequest
  error?: string | null
  cannotApprove?: string | null
  disclosureOpen?: boolean
  onToggleDisclosure?: () => void
  first?: boolean
  onResolve: (d: ApprovalDecision) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const view = homeCardView(approval, expanded)
  const total = approval.home?.devices.length ?? 0
  const canApprove = view.canApprove && !cannotApprove

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const action = approvalKey({
        key: e.key,
        modified: e.metaKey || e.ctrlKey || e.altKey,
        typing: isTypingTarget(e.target as HTMLElement | null),
        first: first !== false
      })
      if (!action) return
      if (action === 'approve' && !canApprove) return // Critical, or refused for who is asking: `A` falls through
      e.preventDefault()
      if (action === 'approve') {
        trace({ point: 'card:click', requestId: approval.requestId, scope: 'once' })
        onResolve({ kind: 'approve', scope: 'once' })
      } else onResolve({ kind: 'deny' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [approval.requestId, first, onResolve, canApprove])

  return (
    <div style={approvalCardStyle} data-testid="home-approval" data-tier={view.tier} data-request={approval.requestId}>
      <div style={approvalHeaderStyle}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--lapis)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m3 11 9-8 9 8" />
          <path d="M5 10v10h14V10" />
        </svg>
        <span style={{ fontSize: 11.5, color: 'var(--lapis-text)' }}>Home · permission needed</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--ink3)' }}>{age(approval.createdAt)}</span>
      </div>
      <div style={body}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13.5 }} data-testid="home-title">{view.title}</strong>
          <HomeTierBadge tier={view.tier} />
          {view.tierReason ? <span style={{ fontSize: 11.5, color: 'var(--c-text-dim)' }}>{view.tierReason}</span> : null}
        </div>

        <ul style={list} aria-label="Devices this will change">
          {view.rows.map((r) => (
            <li key={r.id} style={row} data-testid="home-row">
              <span style={{ flexShrink: 0 }}>
                {r.name}
                {r.room ? <span style={{ color: 'var(--c-text-dim)' }}> · {r.room}</span> : null}
              </span>
              {total > 1 ? <HomeTierBadge tier={r.tier} /> : null}
              <span style={change} data-unknown={r.currentUnknown ? '1' : '0'}>{r.change}</span>
            </li>
          ))}
        </ul>
        {view.moreLabel ? (
          <button style={link} onClick={() => setExpanded(true)} aria-expanded={false} data-testid="home-more">
            {view.moreLabel}
          </button>
        ) : expanded && total > COLLAPSE_AFTER ? (
          <button style={link} onClick={() => setExpanded(false)} aria-expanded={true} data-testid="home-more">
            Show fewer
          </button>
        ) : null}

        {approval.description ? <div style={{ fontSize: 11.5, color: 'var(--c-text-dim)', overflowWrap: 'anywhere' }}>{approval.description}</div> : null}

        {error ? (
          <div role="alert" style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid var(--sang)', color: 'var(--c-err-text)', fontSize: 12, fontFamily: 'var(--font-mono, monospace)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {error}
          </div>
        ) : null}
        {cannotApprove ? <div style={{ fontSize: 12.5, lineHeight: 1.5 }} data-testid="approval-cannot-approve">{cannotApprove}</div> : null}
        {view.criticalNote ? (
          <div style={{ display: 'flex', gap: 7, fontSize: 12.5, lineHeight: 1.5 }} data-testid="home-critical-note">
            <Icon name="lock" size={13} />
            <span>{view.criticalNote}</span>
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: 8 }}>
          {canApprove ? (
            <button
              className="approval-btn approval-btn-approve"
              onClick={() => {
                trace({ point: 'card:click', requestId: approval.requestId, scope: 'once' })
                onResolve({ kind: 'approve', scope: 'once' })
              }}
            >
              Approve once <span style={approvalActionKey}>A</span>
            </button>
          ) : null}
          <button className="approval-btn approval-btn-deny" onClick={() => onResolve({ kind: 'deny' })}>
            Deny <span style={approvalActionKey}>D</span>
          </button>
        </div>

        {view.lasting.length > 0 ? (
          <div>
            <button
              className="approval-disclosure-head"
              onClick={() => onToggleDisclosure?.()}
              aria-expanded={disclosureOpen}
              title={disclosureOpen ? 'Hide the options that create a lasting grant' : 'Show the options that create a lasting grant'}
            >
              <Icon name={disclosureOpen ? 'chevron-down' : 'chevron-right'} size={11} />
              <span>Always allow… ({view.lasting.length} option{view.lasting.length === 1 ? '' : 's'})</span>
            </button>
            {disclosureOpen ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                {view.lasting.map(([verb, describes]) => (
                  <button
                    key={verb}
                    className="approval-scope-btn"
                    title={describes}
                    onClick={() => {
                      trace({ point: 'card:click', requestId: approval.requestId, scope: verb })
                      onResolve({ kind: 'approve', scope: verb })
                    }}
                  >
                    <span style={approvalVerbChip}>{verb}</span>
                    <span style={{ display: 'block', marginTop: 2, color: 'var(--c-text-dim)' }}>{describes}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : view.canApprove && !cannotApprove ? (
          <div style={approvalNoteStyle}>
            {view.tier === 'sensitive'
              ? 'Sensitive: asked every time. Turn on "Ask once" for a device under Integrations → Home to be offered Always allow.'
              : 'This action is approved once, each time — no lasting grant is on offer.'}
          </div>
        ) : null}
      </div>
    </div>
  )
}
