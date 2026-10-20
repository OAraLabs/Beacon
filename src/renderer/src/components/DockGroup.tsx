import { PANEL_PANES, type PanelPane } from '@shared/side-panel'
import { Icon, type IconName } from './Icon'

// The dock group (design handoff 2026-09-03, R3): ONE segmented control, in the thread header,
// adjacent to the pane it opens — three segments (inspector · browser · terminal) in one
// brass-tinted well, ⌘1 / ⌘2 / ⌘3, Esc to close. Pressed = the dock is SHOWING that pane (on the
// chat view, open, on that pane) — not merely persisted open. The owner passes `pane` already
// resolved that way: launch lands on Mission, the dock lives on the chat view, and a pressed
// segment the user cannot see would close on the press meant to reveal it. Discovered by the
// probe, not designed; do not "simplify" it back to the raw persisted flag.

const ICON: Record<PanelPane, IconName> = { inspector: 'panel', browser: 'globe', terminal: 'terminal', progress: 'check' }

export function DockGroup({ pane, onToggle }: { pane: PanelPane | null; onToggle: (p: PanelPane) => void }) {
  return (
    <div className="dock-group" role="group" aria-label="Dock">
      {PANEL_PANES.map((p) => {
        const pressed = pane === p.id
        return (
          <button
            key={p.id}
            className={`dock-seg${pressed ? ' is-active' : ''}`}
            onClick={() => onToggle(p.id)}
            aria-pressed={pressed}
            title={`${pressed ? 'Close' : 'Open'} the ${p.label.toLowerCase()} pane (${p.shortcut})`}
          >
            <Icon name={ICON[p.id]} size={13} />
          </button>
        )
      })}
    </div>
  )
}
