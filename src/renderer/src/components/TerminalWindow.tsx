// The detached terminal window (#terminal) — the same TerminalPanel, alone, with the persisted theme
// applied on open. The pty stays in main; this window is just another attachment.
import { useEffect, type ReactElement } from 'react'
import { loadAndApplyTheme } from '../theme/apply-theme'
import { TerminalPanel } from './TerminalPanel'

export function TerminalWindow(): ReactElement {
  useEffect(() => { void loadAndApplyTheme() }, [])
  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', background: 'var(--c-base)', color: 'var(--c-text)' }}>
      <TerminalPanel popout />
    </div>
  )
}
