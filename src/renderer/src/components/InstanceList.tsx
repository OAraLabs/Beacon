import { useState } from 'react'
import { ADD_PHONE, ADD_PROMETHEUS, instanceRows, type InstanceRowView } from '@shared/instance-rows'
import { useInstances } from '../instances-store'
import { Icon } from './Icon'

// "Your Prometheus" at the top of the sidebar (docs/MULTI-PROMETHEUS.md §5): nothing while Beacon keeps one; with two or more, a row
// each on one line (dot · name · the model, or the state's words when it isn't connected; the whole in the tooltip), clicked to
// switch (§4). An older Prometheus's "can't prove who it is" is a warning icon at the end. The + in the header opens the Add form
// (AddInstance). The same rows, in full, open from the name in the title bar, from any view (AppChrome's switcher).

export function InstanceList() {
  const rows = instanceRows(useInstances())
  if (!rows) return null
  return (
    <section className="instance-list" aria-label="Your Prometheus" data-testid="instance-list">
      <div className="instance-list-head">
        <span style={{ flex: 1 }}>Your Prometheus</span>
        <button
          className="sidebar-action"
          onClick={() => window.dispatchEvent(new CustomEvent('beacon:add-instance'))}
          title="Add a Prometheus"
          aria-label="Add a Prometheus"
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      <InstanceRowButtons rows={rows} compact />
    </section>
  )
}

/** The rows and "Add a Prometheus…". `onDone` runs once a choice is made (the switcher closes); `menu`: they are a menu's items;
 *  `compact`: one line each and no Add row (the sidebar, whose header has the +). */
export function InstanceRowButtons({
  rows,
  onDone,
  menu = false,
  compact = false
}: {
  rows: InstanceRowView[]
  onDone?: () => void
  menu?: boolean
  compact?: boolean
}) {
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
      {rows.map((r) =>
        compact ? (
          <button
            key={r.id}
            className={`instance-row is-compact${r.current ? ' is-current' : ''}`}
            aria-current={r.current ? 'true' : undefined}
            disabled={switching !== null}
            onClick={() => void go(r)}
            title={`${r.name}: ${r.full}${r.current ? ' (the one Beacon is on)' : ''}`}
            aria-label={`${r.name}: ${r.full}${r.note ? `. ${r.note}` : ''}`}
            data-testid="instance-row"
            data-instance={r.id}
          >
            <span className={`instance-dot is-${r.dot}`} aria-hidden="true" />
            <span className="instance-name">{r.name}</span>
            <span className="instance-detail">{switching === r.id ? 'Switching…' : r.detail}</span>
            {r.note ? (
              <span className="instance-warn" title={r.note} data-testid="instance-note" aria-hidden="true">
                <Icon name="warning" size={12} />
              </span>
            ) : null}
          </button>
        ) : (
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
        )
      )}
      {compact ? null : (
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
      )}
      {compact ? null : (
        <button
          role={role}
          className="instance-row instance-add"
          onClick={() => {
            onDone?.()
            window.dispatchEvent(new CustomEvent('beacon:add-phone'))
          }}
          data-testid="phone-add"
        >
          {ADD_PHONE}
        </button>
      )}
    </>
  )
}
