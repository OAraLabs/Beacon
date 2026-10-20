import { viewLabel, type ViewId } from '@shared/views'

// Placeholder for views whose UI isn't built yet (Phase 5a ships Activity + Tool Feed; Status /
// Sessions / Config arrive in 5b). Keeps the nav shell complete + navigable today.

const NOTE: Partial<Record<ViewId, string>> = {
  status: 'Agent status — Phase 5b',
  sessions: 'Session tree — Phase 5b',
  config: 'Skills · telemetry · sentinel · memory — Phase 5b'
}

export function StubPanel({ view }: { view: ViewId }) {
  const label = viewLabel(view)
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        color: 'var(--c-text-dim)'
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--c-text)' }}>{label}</div>
      <div style={{ fontSize: 13 }}>{NOTE[view] ?? 'Coming soon'}</div>
    </div>
  )
}
