import { useState } from 'react'
import { ADD_PROMETHEUS, instanceRows, type InstanceRowView } from '@shared/instance-rows'
import { useInstances } from '../instances-store'

// "Your Prometheus" at the top of the sidebar (docs/MULTI-PROMETHEUS.md §5): nothing while Beacon keeps one; with two or more, a row
// each, clicked to switch (§4). Every state is in words beside its dot. "Add a Prometheus…" opens the Add form (AddInstance).
// The same rows open from the name in the title bar, from any view (AppChrome's switcher).

export function InstanceList() {
  const rows = instanceRows(useInstances())
  if (!rows) return null
  return (
    <section className="instance-list" aria-label="Your Prometheus" data-testid="instance-list">
      <div className="instance-list-head">Your Prometheus</div>
      <InstanceRowButtons rows={rows} />
    </section>
  )
}

/** The rows and "Add a Prometheus…". `onDone` runs once a choice is made (the switcher closes); `menu`: they are a menu's items. */
export function InstanceRowButtons({ rows, onDone, menu = false }: { rows: InstanceRowView[]; onDone?: () => void; menu?: boolean }) {
  const [switching, setSwitching] = useState<string | null>(null)
  const go = async (r: InstanceRowView): Promise<void> => {
    if (r.current) return onDone?.()
    setSwitching(r.id)
    try {
      await window.beacon?.instances.switch(r.id)
    } finally {
      setSwitching(null)
      onDone?.()
    }
  }
  const role = menu ? 'menuitem' : undefined
  return (
    <>
      {rows.map((r) => (
        <button
          key={r.id}
          role={role}
          className={`instance-row${r.current ? ' is-current' : ''}`}
          aria-current={r.current ? 'true' : undefined}
          disabled={switching !== null}
          onClick={() => void go(r)}
          title={r.current ? `${r.name}: the one Beacon is on` : `Switch to ${r.name}`}
          data-testid="instance-row"
          data-instance={r.id}
        >
          <span className={`instance-dot is-${r.dot}`} aria-hidden="true" />
          <span className="instance-text">
            <span className="instance-name">{r.name}</span>
            <span className="instance-words">
              {switching === r.id ? 'Switching…' : r.words}
              {r.ai ? ` · ${r.ai}` : ''}
            </span>
            {r.note ? <span className="instance-note">{r.note}</span> : null}
          </span>
        </button>
      ))}
      <button
        role={role}
        className="instance-row instance-add"
        onClick={() => {
          onDone?.()
          window.dispatchEvent(new CustomEvent('beacon:add-instance'))
        }}
        data-testid="instance-add"
      >
        {ADD_PROMETHEUS}
      </button>
    </>
  )
}
