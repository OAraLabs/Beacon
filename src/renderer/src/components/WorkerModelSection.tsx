import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import {
  WORKER_MODEL_OWNER_ONLY,
  WORKER_MODEL_PATH,
  workerModelBody,
  workerModelError,
  workerModelFromWire,
  workerModelSourceNote,
  type WorkerModelState
} from '@shared/workers'
import { useDeviceRole } from './OwnerOnlyNote'

/**
 * Settings → Worker model (Prometheus 713 / 719): which model the daemon's spawned workers run on.
 *
 * "Same as chat" — the default — means each worker runs on the model of the conversation that
 * started it. A chosen model applies to every worker, from every conversation, and the agent
 * cannot pick one of its own. The daemon owns the setting (`GET`/`PUT /api/workers/model`): the
 * list is the daemon's, the value read back after a write is the daemon's, and nothing is kept
 * here. Owner only: a scoped device is told so instead of offered a control that 403s.
 */
export function WorkerModelSection(): ReactElement | null {
  const [state, setState] = useState<WorkerModelState | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const role = useDeviceRole()

  // Read again whenever the role changes: made an owner here (Settings → Make this Beacon an owner), the answer from before — "Only the
  // owner…" — is stale (the 0.4.5 sweep, E4). An approved device is not asked at all: it would be refused.
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    if (role === 'limited') {
      setState(null)
      setErr(WORKER_MODEL_OWNER_ONLY)
      return
    }
    if (role === undefined) return // main has not said yet: wait rather than ask
    let live = true
    b.daemon
      .get(WORKER_MODEL_PATH)
      .then((raw) => {
        if (!live) return
        setState(workerModelFromWire(raw))
        setErr(null)
      })
      .catch((e: unknown) => {
        if (live) setErr(workerModelError(e))
      })
    return () => {
      live = false
    }
  }, [role])

  const choose = (selected: string): void => {
    const b = window.beacon
    if (!b || !state) return
    setSaving(true)
    setErr(null)
    b.daemon
      .write(WORKER_MODEL_PATH, workerModelBody(selected), 'PUT')
      .then((raw) => {
        const next = workerModelFromWire(raw)
        if (next) setState(next)
      })
      .catch((e: unknown) => setErr(workerModelError(e)))
      .finally(() => setSaving(false))
  }

  const hint: CSSProperties = { fontSize: 11, color: 'var(--c-text-dim)', lineHeight: 1.35 }
  const select: CSSProperties = {
    fontSize: 12,
    padding: '4px 8px',
    borderRadius: 6,
    border: '1px solid var(--c-line)',
    background: 'var(--c-base)',
    color: 'var(--c-text)',
    maxWidth: 260,
    font: 'inherit'
  }
  // Not connected, and nothing to say: no section at all.
  if (!state && !err) return null

  // A stored key the daemon no longer offers (a model removed from the catalog) is still the
  // setting: shown as it is, never silently replaced by the first choice in the list.
  const offered = state ? state.choices.some((c) => c.key === state.model) : false
  const note = state ? workerModelSourceNote(state.source) : null
  return (
    <div style={{ borderTop: '1px solid var(--c-line)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-text-dim)' }}>Worker model</div>
      {state ? (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--c-text)' }}>
          <span>Background workers run on</span>
          <select
            style={{ ...select, cursor: saving ? 'wait' : 'pointer' }}
            value={state.model ?? ''}
            disabled={saving}
            onChange={(e) => choose(e.target.value)}
          >
            <option value="">Same as chat</option>
            {state.model && !offered ? <option value={state.model}>{state.model} (not offered now)</option> : null}
            {state.choices.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div style={hint}>
        Same as chat: each worker uses the model of the conversation that started it. Pick a model
        to run every worker on it instead. A smaller model may have a smaller context window.
      </div>
      {note ? <div style={hint}>{note}</div> : null}
      {err ? <div style={{ fontSize: 12, color: 'var(--c-err-text)' }}>{err}</div> : null}
    </div>
  )
}
