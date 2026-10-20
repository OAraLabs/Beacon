import type { CSSProperties } from 'react'
import { NAV_TREE, RAIL_MAX, railDestination, railEntryActive, type NavEntry, type ViewId } from '@shared/views'
import { ConnectionIndicator } from './ConnectionIndicator'
import { Icon, type IconName } from './Icon'

// The navigation rail (design handoff 2026-09-03, R1): WHERE YOU ARE. Six entries or fewer, each a
// destination — Mission · Chats · Coding · Workspace · Activity · Config — and it never expands. A
// surface's second-level views are a pill row at the top of the surface (SubNav.tsx, R2), not a
// tree in here. The dock's panes (inspector, browser, terminal) are NOT here either (R3): a
// trigger at the far-left edge that opens a pane at the far-right edge was the defect the thread
// header's dock group replaces. The foot keeps the health dot, visible from every view; the
// context meter moved to the sessions panel's footer (screen 3), beside the conversation it
// describes.

const ENTRY_ICON: Record<string, IconName> = {
  // A RETICLE, not a bolt: the bolt is the autonomy chip's glyph, and one symbol used for two
  // unrelated things made the header's `full · auto` read as if it belonged to Mission.
  mission: 'reticle',
  config: 'config',
  'grp:conversations': 'chat',
  'grp:coding': 'code',
  'grp:workspace': 'files',
  'grp:activity': 'activity'
}

function entryKey(entry: NavEntry): string {
  return entry.kind === 'view' ? entry.id : entry.group.id
}
function entryLabel(entry: NavEntry, labels: Record<ViewId, string>): string {
  return entry.kind === 'view' ? labels[entry.id] : entry.group.label
}

const rail: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  width: 60,
  padding: '10px 4px',
  background: 'var(--c-base)',
  borderRight: '1px solid var(--c-line)',
  flexShrink: 0
}

// Rail labels are WORDS, not identifiers. `Mission` is not a value, so it is not mono — serif 9px,
// per the match spec's font table. (Everything a rail label could be confused with — counts,
// times, hosts — lives elsewhere and IS mono.)
function rowStyle(active: boolean, foot = false): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    height: 44,
    padding: '0 2px',
    borderRadius: 8,
    border: 'none',
    background: active ? 'var(--c-arc-soft)' : 'transparent',
    color: active ? 'var(--c-arc)' : 'var(--ink3)',
    cursor: 'pointer',
    font: 'inherit',
    fontFamily: 'var(--font-body)',
    fontSize: 9,
    letterSpacing: '0.02em',
    marginTop: foot ? 'auto' : undefined,
    transition: 'background var(--t-fast) var(--ease)'
  }
}

export function NavRail({ view, onSelect }: { view: ViewId; onSelect: (v: ViewId) => void }) {
  // Labels come from NAV_VIEWS via the tree's own view entries; groups carry their own label.
  const labels = { mission: 'Mission', config: 'Config' } as Record<ViewId, string>
  // R1 is a contract, not a hope: a seventh entry is a bug, so it renders as one.
  const entries = NAV_TREE.length > RAIL_MAX ? NAV_TREE.slice(0, RAIL_MAX) : NAV_TREE
  return (
    <nav className="rail-scroll" style={rail} aria-label="Views" data-rail-entries={NAV_TREE.length}>
      {entries.map((entry) => {
        const active = railEntryActive(entry, view)
        const label = entryLabel(entry, labels)
        // Config is PINNED TO THE FOOT, not the sixth item in the run: it is a utility, not a peer
        // destination, and sitting flush against Activity it read as one more place to go. The
        // `margin-top: auto` is what separates it; the hairline below it is what separates the
        // machine identity from navigation entirely.
        const foot = entryKey(entry) === 'config'
        return (
          <button
            key={entryKey(entry)}
            style={rowStyle(active, foot)}
            // A group's entry lands on its first child; when you are already inside the group,
            // the click is a no-op rather than a jump away from the sub-view you chose.
            onClick={() => {
              if (!active) onSelect(railDestination(entry))
            }}
            title={label}
            aria-current={active ? 'page' : undefined}
          >
            <Icon name={ENTRY_ICON[entryKey(entry)]} size={17} strokeWidth={1.4} />
            <span>{label}</span>
          </button>
        )
      })}
      {/* Below Config: the 34px hairline and then the host chip — both rendered by
          ConnectionIndicator, which owns that pair. The RULE is what says the chip is machine
          identity rather than a seventh nav item. Config's own `margin-top: auto` is what pushes
          the whole foot down, so this no longer needs a spacer of its own. */}
      <ConnectionIndicator />
    </nav>
  )
}
