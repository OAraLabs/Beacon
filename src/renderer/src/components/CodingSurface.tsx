import type { ReactNode } from 'react'
import { NAV_VIEWS, subNavForView, type ViewId } from '@shared/views'
import { PANEL_PANES, type PanelPane } from '@shared/side-panel'
import { Icon, type IconName } from './Icon'

// The Coding surface's own navigation (2026-09-03). Run and Loop Manager are NOT two tabs of a
// page — they are the same /api/code engine at two altitudes — so this group draws its second
// level as a left DRILL-DOWN (NavGroup.layout === 'column') instead of R2's pill row. The column
// stays put while a run is going, which a pill row at the top of a scrolling page does not.
//
// The Terminal and Browser live here too, and this is the one place outside the thread where the
// dock's own controls appear. That is not a hole in R3: R3 forbids a trigger at the FAR-LEFT EDGE
// that opens a pane at the far-right edge, and forbids the rail carrying panes. These buttons sit
// on the surface the pane opens beside, which is exactly the adjacency R3 asks for — a shell next
// to a diff, without being thrown back to the chat to get one.

const MODE_ICON: Record<string, IconName> = { coding: 'code', 'loop-manager': 'refresh' }
const PANE_ICON: Record<PanelPane, IconName> = { inspector: 'toolfeed', browser: 'globe', terminal: 'terminal', progress: 'check' }
const LABEL = Object.fromEntries(NAV_VIEWS.map((v) => [v.id, v.label])) as Record<ViewId, string>

/** The dock panes worth reaching from a coding run. The inspector is a thread thing — it inspects
 *  a tool call in a conversation — so it is deliberately absent here. */
// An ALLOW-list, not a deny-list. As `filter(p => p.id !== 'inspector')` this opted every future
// pane into the coding surface by default — the opposite of the deliberate exclusion the line
// looked like. Whether a pane belongs beside a coding run is a decision; make it one here.
// Progress is out for now: a coding run's plan is not the conversation's plan, and nothing
// resolves one for it yet.
const CODING_PANE_IDS: readonly PanelPane[] = ['browser', 'terminal']
const CODING_PANES = PANEL_PANES.filter((p) => CODING_PANE_IDS.includes(p.id))

export function CodingSurface({
  view,
  onSelect,
  dockPane,
  onToggleDock,
  children
}: {
  view: ViewId
  onSelect: (v: ViewId) => void
  /** The pane the dock is SHOWING beside this surface (null = closed) — same rule as the thread. */
  dockPane: PanelPane | null
  onToggleDock: (p: PanelPane) => void
  children: ReactNode
}) {
  const group = subNavForView(view)
  const modes = group?.children ?? [view]
  return (
    <div className="coding-surface">
      <nav className="coding-drill" aria-label="Coding">
        <h1 className="coding-drill-title">{group?.label ?? 'Coding'}</h1>
        <div className="coding-drill-modes">
          {modes.map((id) => (
            <button
              key={id}
              className={`coding-drill-mode${id === view ? ' is-active' : ''}`}
              onClick={() => onSelect(id)}
              aria-current={id === view ? 'page' : undefined}
            >
              <Icon name={MODE_ICON[id] ?? 'code'} size={14} />
              <span>{LABEL[id]}</span>
            </button>
          ))}
        </div>
        <div className="coding-drill-foot">
          <div className="coding-drill-cap">tools</div>
          {CODING_PANES.map((p) => {
            const pressed = dockPane === p.id
            return (
              <button
                key={p.id}
                className={`coding-drill-tool${pressed ? ' is-active' : ''}`}
                onClick={() => onToggleDock(p.id)}
                aria-pressed={pressed}
                title={`${pressed ? 'Close' : 'Open'} the ${p.label.toLowerCase()} beside this run (${p.shortcut})`}
              >
                <Icon name={PANE_ICON[p.id]} size={14} />
                <span>{p.label}</span>
                <kbd>{p.shortcut}</kbd>
              </button>
            )
          })}
        </div>
      </nav>
      <div className="coding-body">{children}</div>
    </div>
  )
}
