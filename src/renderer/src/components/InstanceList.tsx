import { useState } from 'react'
import { ADD_PROMETHEUS, instanceRows } from '@shared/instance-rows'
import { useInstances } from '../instances-store'

// "Your Prometheus" at the top of the sidebar (docs/MULTI-PROMETHEUS.md §5): nothing while Beacon keeps one; with two or more, a row
// each, clicked to switch (§4). Every state is in words beside its dot. "Add a Prometheus…" opens Settings → Connection until P5.

export function InstanceList() {
  const list = useInstances()
  const [switching, setSwitching] = useState<string | null>(null)
  const rows = instanceRows(list)
  if (!rows) return null
  const go = async (id: string): Promise<void> => {
    setSwitching(id)
    try {
      await window.beacon?.instances.switch(id)
    } finally {
      setSwitching(null)
    }
  }
  return (
    <section className="instance-list" aria-label="Your Prometheus" data-testid="instance-list">
      <div className="instance-list-head">Your Prometheus</div>
      {rows.map((r) => (
        <button
          key={r.id}
          className={`instance-row${r.current ? ' is-current' : ''}`}
          aria-current={r.current ? 'true' : undefined}
          disabled={switching !== null}
          onClick={() => (r.current ? undefined : void go(r.id))}
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
        className="instance-row instance-add"
        onClick={() => window.dispatchEvent(new CustomEvent('beacon:open-settings', { detail: { section: 'connection' } }))}
        data-testid="instance-add"
      >
        {ADD_PROMETHEUS}
      </button>
    </section>
  )
}
