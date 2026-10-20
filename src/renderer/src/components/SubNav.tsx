import { NAV_VIEWS, subNavForView, type ViewId } from '@shared/views'

// Second-level navigation (design handoff 2026-09-03, R2): lives at the top of the surface it
// belongs to, as ONE horizontally scrollable row of pills with counts, under the page title and
// over a 1px rule — never as an expanded tree in the rail. Counts are shown only where the owner
// passed one (a count is meaningless for Live or Status, so those pills carry none). The active
// pill is the region's one accent (R6): sang-soft fill, sang text; the rest are a faint brass fill
// with ink2 text. Renders nothing for a surface with no second level.

const LABEL = Object.fromEntries(NAV_VIEWS.map((v) => [v.id, v.label])) as Record<ViewId, string>

export function SubNav({
  view,
  onSelect,
  counts
}: {
  view: ViewId
  onSelect: (v: ViewId) => void
  /** Per-view counts, where a count means something. Absent → the pill shows its label alone. */
  counts?: Partial<Record<ViewId, number | string>>
}) {
  const group = subNavForView(view)
  if (!group) return null
  return (
    <header className="subnav" data-testid="subnav">
      <h1 className="subnav-title">{group.label}</h1>
      <nav className="subnav-pills" aria-label={`${group.label} sections`}>
        {group.children.map((id) => {
          const active = id === view
          const n = counts?.[id]
          return (
            <button
              key={id}
              className={`pill${active ? ' is-active' : ''}`}
              onClick={() => onSelect(id)}
              aria-current={active ? 'page' : undefined}
            >
              {LABEL[id]}
              {n !== undefined && n !== '' ? <span className="pill-n">{n}</span> : null}
            </button>
          )
        })}
      </nav>
    </header>
  )
}
