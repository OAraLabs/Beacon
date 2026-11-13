import { useEffect, type CSSProperties } from 'react'
import { answeredView, type Resolution } from '@shared/home-answered'
import type { ApprovalRequest } from '@shared/ipc'
import { homeCardView } from '@shared/home-approval'
import { Icon } from './Icon'
import { approvalCardStyle, approvalHeaderStyle } from './ExecApprovalCard'

/**
 * A Home approval that was answered somewhere else (a chat app, another computer): "Answered on …", and no buttons
 * (docs/HA-UI-DATA-CONTRACT.md §7, Q4). The card it replaces stays recognisable (the device it was about), but there is nothing here
 * to press except Dismiss: the question has its answer. It clears itself after a while.
 */

const AUTO_DISMISS_MS = 15000
const body: CSSProperties = { padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 4 }

export function HomeAnsweredCard({
  approval,
  resolution,
  answeredOn,
  onDismiss
}: {
  approval: ApprovalRequest
  resolution: Resolution | null
  answeredOn: string | null
  onDismiss: () => void
}) {
  const v = answeredView({ resolution, answeredOn })
  const title = approval.home ? homeCardView(approval).title : approval.toolName

  useEffect(() => {
    const t = setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(t)
  }, [onDismiss])

  return (
    <div style={approvalCardStyle} data-testid="home-answered" data-request={approval.requestId}>
      <div style={approvalHeaderStyle}>
        <span style={{ fontSize: 11.5, color: 'var(--lapis-text)' }}>Home · {title}</span>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--c-text-dim)', cursor: 'pointer', padding: 2, display: 'inline-flex' }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div style={body} role="status">
        <div style={{ fontSize: 13, fontWeight: 600 }} data-testid="home-answered-title">{v.title}</div>
        {v.detail ? <div style={{ fontSize: 12, color: 'var(--c-text-dim)' }}>{v.detail}</div> : null}
      </div>
    </div>
  )
}
