import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import {
  CONFIG_TABS,
  tokenPct,
  toolStatRows,
  asList,
  isAuthError,
  mergeSkillPins,
  cronFormReady,
  cronJobStatus,
  grantIsPersistent,
  type CronJobDTO,
  type GrantDTO,
  type SkillDTO,
  type SkillListDTO,
  type TelemetryDTO,
  type ConfigDTO,
  type WikiStatsDTO,
  type MemoryDTO,
  type MemorySnapshotDTO,
  type SentinelDTO,
  type ProfileDTO,
  ratePct,
  toolCallsReading,
  rateColor
} from '@shared/daemon-api'
import {
  BILLING_LABEL,
  DEFAULT_USAGE_WINDOW,
  USAGE_WINDOWS,
  costCell,
  coverageSentence,
  fmtTokens,
  parseUsage,
  usagePath,
  windowNote,
  type BillingMode,
  type UsageReport
} from '@shared/usage'
import { usePreview } from '../preview-store'
import { ModelKeysTab } from './ModelKeysTab'
import { ConnectorsTab } from './ConnectorsTab'
import { DevicesPanel } from './DevicesPanel'
import { SkinTab } from './SkinTab'
import { NotAuthorized } from './NotAuthorized'
import { isOwnerOnlyConfigTab } from '@shared/device-role'
import { OwnerOnlyNote, useDeviceRole } from './OwnerOnlyNote'

// Config view (Phase 5b) — tabs over the daemon's endpoints (models / skills / telemetry / memory /
// sentinel / wiki / cron / config / profiles), each seeded via the scoped daemon.get. Models (keys),
// Skills (pins) and Cron (CRUD) also write through the scoped daemon.write.

/** R14 grouping of CONFIG_TABS: capability · observability · system. Every tab id appears once;
 *  a tab missing from every group would be unreachable, so the strip also appends any leftover. */
const CONFIG_TAB_GROUPS: string[][] = (() => {
  const groups = [
    ['models', 'connectors', 'skills', 'profiles', 'grants', 'devices'],
    ['telemetry', 'usage', 'memory', 'sentinel'],
    ['wiki', 'cron', 'config', 'skin']
  ]
  const placed = new Set(groups.flat())
  const rest = CONFIG_TABS.map((t) => t.id).filter((id) => !placed.has(id))
  return rest.length ? [...groups, rest] : groups
})()

const MONO = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
const panel: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }
const head: CSSProperties = { padding: '10px 16px 0', borderBottom: '1px solid var(--c-line)', background: 'var(--c-raise)', flexShrink: 0 }
const body: CSSProperties = { flex: 1, overflowY: 'auto', padding: 16 }
const pre: CSSProperties = { margin: 0, fontFamily: MONO, fontSize: 12, color: 'var(--c-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--c-base)', border: '1px solid var(--c-line)', borderRadius: 8, padding: 12, maxHeight: '70vh', overflow: 'auto' }
const tab = (active: boolean): CSSProperties => ({
  padding: '7px 12px',
  fontSize: 12,
  background: 'transparent',
  border: 'none',
  borderBottom: `2px solid ${active ? 'var(--c-arc)' : 'transparent'}`,
  color: active ? 'var(--c-text)' : 'var(--c-text-dim)',
  cursor: 'pointer',
  font: 'inherit'
})
const muted: CSSProperties = { color: 'var(--c-text-dim)', fontSize: 13 }
const badge: CSSProperties = { fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'var(--c-inset)', color: 'var(--c-text-dim)' }
const pinBtn = (pinned: boolean, disabled: boolean): CSSProperties => ({
  fontSize: 11,
  padding: '3px 9px',
  borderRadius: 6,
  border: `1px solid ${pinned ? 'var(--c-warn)' : 'var(--c-line)'}`,
  background: pinned ? 'var(--c-amber-soft)' : 'var(--c-raise)',
  color: disabled ? 'var(--c-text-faint)' : pinned ? 'var(--c-warn)' : 'var(--c-text)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  flexShrink: 0,
  font: 'inherit'
})

/** Config→Skills (Tier 2): the read-only /api/skills list decorated with pin toggles. Auto-skills
 * (present in /api/skills/list) get a Pin/Unpin button → daemon.write POST|DELETE /api/skills/{n}/pin;
 * manual skills render as before. Pin state is optimistic, then reconciled by re-fetching the list. */
function SkillsTab({ data }: { data: unknown }) {
  const base = asList<SkillDTO>(data)
  const [pins, setPins] = useState<Record<string, { pinned: boolean; state?: string }>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const { open: openPreview } = usePreview()

  /** Slice 8: full skill definition (GET /api/skills/{name}) → the Hermes pane. */
  const view = (name: string): void => {
    const b = window.beacon
    if (!b) return
    void b.daemon
      .get(`/api/skills/${encodeURIComponent(name)}`)
      .then((d) => {
        const s = (d ?? {}) as { content?: string; path?: string }
        openPreview({ kind: 'text', title: `skill: ${name}`, body: s.content || '(empty skill file)' })
      })
      .catch(() => openPreview({ kind: 'text', title: `skill: ${name}`, body: '(could not load the definition)' }))
  }

  const loadPins = useCallback((): void => {
    const b = window.beacon
    if (!b) return
    void b.daemon
      .get('/api/skills/list')
      .then((d) => {
        const map: Record<string, { pinned: boolean; state?: string }> = {}
        for (const r of asList<SkillListDTO>(d)) map[r.name] = { pinned: !!r.pinned, state: r.state }
        setPins(map)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => loadPins(), [loadPins])

  const toggle = async (name: string, pinned: boolean): Promise<void> => {
    const b = window.beacon
    if (!b) return
    setBusy(name)
    setPins((m) => ({ ...m, [name]: { pinned: !pinned, state: m[name]?.state } })) // optimistic
    try {
      await b.daemon.write(`/api/skills/${encodeURIComponent(name)}/pin`, undefined, pinned ? 'DELETE' : 'POST')
    } catch {
      setPins((m) => ({ ...m, [name]: { pinned, state: m[name]?.state } })) // revert on failure
    } finally {
      setBusy(null)
      loadPins()
    }
  }

  const skills = mergeSkillPins(base, pins)
  if (skills.length === 0) return <div style={muted}>No skills</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {skills.map((s) => (
        <div key={s.name} style={{ background: 'var(--c-base)', border: '1px solid var(--c-line)', borderRadius: 8, padding: '8px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: MONO, fontSize: 13, color: 'var(--c-text)' }}>{s.name}</span>
            {s.source ? <span style={badge}>{s.source}</span> : null}
            {s.state ? <span style={badge}>{s.state}</span> : null}
            <span style={{ flex: 1 }} />
            <button
              onClick={() => view(s.name)}
              style={{ ...badge, border: '1px solid var(--c-line)', background: 'transparent', cursor: 'pointer', font: 'inherit' }}
              title="View the full skill definition"
            >
              View
            </button>
            {s.pinnable ? (
              <button
                onClick={() => toggle(s.name, !!s.pinned)}
                disabled={busy === s.name}
                style={pinBtn(!!s.pinned, busy === s.name)}
                title={s.pinned ? 'Unpin (allow GEPA to prune this skill)' : 'Pin (protect this skill from pruning)'}
              >
                {s.pinned ? '📌 Pinned' : 'Pin'}
              </button>
            ) : null}
          </div>
          {s.description ? <div style={{ fontSize: 12, color: 'var(--c-text-dim)', marginTop: 3 }}>{s.description}</div> : null}
        </div>
      ))}
    </div>
  )
}

function Json({ value }: { value: unknown }) {
  let s: string
  try {
    s = JSON.stringify(value, null, 2)
  } catch {
    s = String(value)
  }
  return <pre style={pre}>{s}</pre>
}

/** Memory editor (Prometheus PR 111) — MEMORY.md / USER.md become editable in place: one entry per
 * line, live char meter against the daemon's budget, Save via PUT /api/memory/current (the daemon
 * snapshots the previous content to ~/.prometheus/memory-history/ before every write, so edits are
 * reversible server-side). Older daemon (no PUT route) → save fails with a clear note; view intact. */
function MemoryEditor({
  title,
  field,
  snap,
  onSaved
}: {
  title: string
  field: 'memory' | 'user'
  snap?: MemorySnapshotDTO | null
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  if (!snap) return null
  const value = draft ?? (snap.content || '')
  // Mirror the server's accounting: entries are trimmed non-empty lines, each costing len+1.
  const chars = value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .reduce((n, e) => n + e.length + 1, 0)
  const limit = snap.char_limit ?? 0
  const pct = tokenPct(chars, limit)
  const dirty = draft !== null && draft !== (snap.content || '')
  const over = limit > 0 && chars > limit
  const save = (): void => {
    setSaving(true)
    setNote(null)
    // base_<field> = the content this editor loaded — the daemon 409s if the agent's memory tool
    // wrote meanwhile (PR 112), so a stale save can never clobber. The draft survives; we rebase.
    void window.beacon?.daemon
      .write('/api/memory/current', { [field]: value, [`base_${field}`]: snap.content || '' }, 'PUT')
      .then(() => {
        setSaving(false)
        setNote('saved ✓')
        setDraft(null)
        onSaved()
      })
      .catch((e) => {
        setSaving(false)
        const msg = String(e)
        if (msg.includes('409')) {
          setNote('changed on the daemon while you edited — reloaded the fresh version; your draft is kept, review and save again')
          onSaved() // refresh the base under the preserved draft
        } else {
          setNote(msg.includes('404') || msg.includes('405') ? 'save failed — this daemon predates memory editing (update Prometheus)' : `save failed: ${msg.slice(0, 140)}`)
        }
      })
  }
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--c-text-dim)', marginBottom: 4 }}>
        <span style={{ fontFamily: MONO }}>
          {title} · {snap.entry_count ?? 0} entries
        </span>
        <span style={{ fontFamily: MONO, fontVariantNumeric: 'tabular-nums', color: over ? 'var(--c-err)' : undefined }}>
          {chars.toLocaleString()} / {limit.toLocaleString()} chars ({pct}%)
        </span>
      </div>
      {/* Slice 8: char-budget gauge — amber past 75%, red past 92% (prune territory). */}
      <div style={{ height: 2, borderRadius: 1, background: 'var(--c-line)', overflow: 'hidden', marginBottom: 6 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: pct >= 92 ? 'var(--c-err)' : pct >= 75 ? 'var(--c-warn)' : 'var(--c-arc)' }} />
      </div>
      <textarea
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="(empty) — one entry per line"
        spellCheck={false}
        style={{
          ...pre,
          maxHeight: '32vh',
          minHeight: 90,
          width: '100%',
          resize: 'vertical',
          font: 'inherit',
          fontFamily: MONO,
          fontSize: 12,
          outline: 'none',
          boxSizing: 'border-box'
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
        <button
          onClick={save}
          disabled={!dirty || saving || over}
          style={{
            fontSize: 12,
            padding: '5px 14px',
            borderRadius: 6,
            border: '1px solid var(--c-line)',
            background: 'var(--c-raise)',
            color: !dirty || saving || over ? 'var(--c-text-faint)' : 'var(--c-ok)',
            cursor: !dirty || saving || over ? 'not-allowed' : 'pointer',
            font: 'inherit'
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {dirty && !note ? <span style={{ fontSize: 11, color: 'var(--c-warn)' }}>unsaved changes</span> : null}
        {note ? <span style={{ fontSize: 11, color: note.startsWith('saved') ? 'var(--c-ok)' : 'var(--c-err)', fontFamily: MONO }}>{note}</span> : null}
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--c-text-faint)' }}>edits snapshot server-side before saving</span>
      </div>
    </div>
  )
}

/** Memory tab — parent data seeds the view; saves re-fetch locally (CronTab pattern) so the
 * editors reflect the daemon's post-write truth without waiting for the panel's refresh cycle. */
function MemoryTab({ data }: { data: unknown }) {
  const [fresh, setFresh] = useState<MemoryDTO | null>(null)
  const reload = useCallback((): void => {
    void window.beacon?.daemon
      .get('/api/memory/current')
      .then((d) => setFresh((d as MemoryDTO) ?? null))
      .catch(() => undefined)
  }, [])
  const m = (fresh ?? (data as MemoryDTO)) ?? {}
  if (m.error) return <div style={muted}>{m.error}</div>
  return (
    <div>
      <MemoryEditor title="MEMORY.md" field="memory" snap={m.memory} onSaved={reload} />
      <MemoryEditor title="USER.md" field="user" snap={m.user} onSaved={reload} />
    </div>
  )
}

const cronForm: CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }
const cronInput = (w: number): CSSProperties => ({
  fontSize: 12,
  padding: '5px 9px',
  borderRadius: 6,
  border: '1px solid var(--c-line)',
  background: 'var(--c-base)',
  color: 'var(--c-text)',
  outline: 'none',
  width: w,
  font: 'inherit'
})
const addBtn = (disabled: boolean): CSSProperties => ({
  fontSize: 12,
  padding: '5px 12px',
  borderRadius: 6,
  border: '1px solid var(--c-line)',
  background: 'var(--c-raise)',
  color: disabled ? 'var(--c-text-faint)' : 'var(--c-ok)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  font: 'inherit'
})
const cronAction: CSSProperties = {
  fontSize: 11,
  padding: '3px 9px',
  borderRadius: 6,
  border: '1px solid var(--c-line)',
  background: 'var(--c-raise)',
  color: 'var(--c-text)',
  cursor: 'pointer',
  flexShrink: 0,
  font: 'inherit'
}

function cleanErr(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  const match = m.match(/\{"error":"([^"]+)"\}/) // surface the daemon's {"error":...} message if present
  return match ? match[1] : m
}

function fmtCronTime(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/** Config→Cron (Tier 3): the read-only job list promoted to full CRUD over daemon.write. A create form
 * (name + schedule + command) POSTs /api/cron; each job gets Run (fire-and-forget) / Enable-Disable
 * (PUT) / Delete. Every write re-fetches /api/cron to refresh. */
function CronTab({ data }: { data: unknown }) {
  const [jobs, setJobs] = useState<CronJobDTO[]>(() => asList<CronJobDTO>(data))
  const [name, setName] = useState('')
  const [schedule, setSchedule] = useState('')
  const [command, setCommand] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback((): void => {
    const b = window.beacon
    if (!b) return
    void b.daemon
      .get('/api/cron')
      .then((d) => setJobs(asList<CronJobDTO>(d)))
      .catch(() => undefined)
  }, [])

  const add = async (): Promise<void> => {
    const b = window.beacon
    if (!b) return
    setBusy(true)
    setErr(null)
    try {
      await b.daemon.write('/api/cron', { name: name.trim(), schedule: schedule.trim(), command: command.trim() }, 'POST')
      setName('')
      setSchedule('')
      setCommand('')
      reload()
    } catch (e) {
      setErr(cleanErr(e))
    } finally {
      setBusy(false)
    }
  }

  const run = (jobName: string): void => {
    const b = window.beacon
    if (!b) return
    void b.daemon.write(`/api/cron/${encodeURIComponent(jobName)}/run`, undefined, 'POST').catch(() => undefined)
    setTimeout(reload, 700) // run-now is fire-and-forget — surface last_run/last_status shortly after
  }

  const del = (jobName: string): void => {
    const b = window.beacon
    if (!b) return
    void b.daemon
      .write(`/api/cron/${encodeURIComponent(jobName)}`, undefined, 'DELETE')
      .then(reload)
      .catch(() => undefined)
  }

  const toggleEnabled = (job: CronJobDTO): void => {
    const b = window.beacon
    if (!b) return
    void b.daemon
      .write(`/api/cron/${encodeURIComponent(job.name)}`, { enabled: job.enabled === false }, 'PUT')
      .then(reload)
      .catch(() => undefined)
  }

  const ready = cronFormReady({ name, schedule, command })

  return (
    <div>
      <div style={cronForm}>
        <input style={cronInput(120)} placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
        <input style={cronInput(150)} placeholder="*/5 * * * *" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
        <input style={{ ...cronInput(120), flex: 1, minWidth: 160 }} placeholder="command" value={command} onChange={(e) => setCommand(e.target.value)} />
        <button style={addBtn(!ready || busy)} disabled={!ready || busy} onClick={add} title="Create cron job">
          Add
        </button>
      </div>
      {err ? <div style={{ color: 'var(--c-err)', fontSize: 12, marginBottom: 8 }}>{err}</div> : null}
      {jobs.length === 0 ? (
        <div style={muted}>No cron jobs</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {jobs.map((j) => {
            const st = cronJobStatus(j)
            return (
              <div key={j.name} style={{ background: 'var(--c-base)', border: '1px solid var(--c-line)', borderRadius: 8, padding: '8px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: MONO, fontSize: 13, color: 'var(--c-text)' }}>{j.name}</span>
                  <span style={{ ...badge, color: st.ok ? 'var(--c-ok)' : 'var(--c-err)' }}>{st.label}</span>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--c-text-dim)' }}>{j.schedule}</span>
                  <span style={{ flex: 1 }} />
                  <button style={cronAction} onClick={() => run(j.name)} title="Run now (fire-and-forget)">
                    ▶ Run
                  </button>
                  <button style={cronAction} onClick={() => toggleEnabled(j)} title={j.enabled === false ? 'Enable' : 'Disable'}>
                    {j.enabled === false ? 'Enable' : 'Disable'}
                  </button>
                  <button style={{ ...cronAction, color: 'var(--c-err)' }} onClick={() => del(j.name)} title="Delete">
                    Delete
                  </button>
                </div>
                <div style={{ fontFamily: MONO, fontSize: 12, color: 'var(--c-text-dim)', marginTop: 4, wordBreak: 'break-all' }}>{j.command}</div>
                <div style={{ fontSize: 11, color: 'var(--c-text-faint)', marginTop: 3 }}>
                  next: {fmtCronTime(j.next_run)} · last: {fmtCronTime(j.last_run)}
                  {j.last_status ? ` (${j.last_status})` : ''}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Remembered approval grants (SPRINT-CONSENT Phase 2) — rows + revoke.
 *
 * Typed against a REAL populated row (see GrantDTO); the scaffold that stood here held out for
 * that deliberately, after two of this sprint's three payload guesses were wrong.
 *
 * Rows and revoke ship together, as the scaffold promised: a list showing what was granted with
 * no way to remove it is the write-only shape this sprint exists to fix.
 *
 * `describes` is rendered VERBATIM and never reconstructed from kind/value. If the daemon's
 * description is wrong, that is a daemon defect and must remain visible here — a Beacon-side
 * "fix" would hide the only signal the operator gets.
 */
function GrantsTab({ data, reload }: { data: unknown; reload: () => void }) {
  const grants = asList<GrantDTO>(data)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const revoke = (id: string): void => {
    const b = window.beacon
    if (!b || !id) return
    setBusy(id)
    setError(null)
    void b.daemon
      .write(`/api/approvals/grants/${encodeURIComponent(id)}`, undefined, 'DELETE')
      .then(() => reload())
      // Surfaced, not swallowed. A revoke that silently fails leaves the operator believing
      // access was withdrawn when it was not — strictly worse than never offering the button.
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null))
  }

  return (
    <div style={{ maxWidth: 620 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
        <span style={{ fontFamily: MONO, fontSize: 18, fontVariantNumeric: 'tabular-nums', color: 'var(--c-text)' }}>
          {grants.length}
        </span>
        <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 'var(--track-caps)', color: 'var(--c-text-faint)' }}>
          active {grants.length === 1 ? 'grant' : 'grants'}
        </span>
      </div>

      {error ? (
        <div style={{ ...muted, color: 'var(--c-warn)', marginBottom: 8 }}>Revoke failed — {error}</div>
      ) : null}

      {grants.length === 0 ? (
        <div style={muted}>No remembered grants. Approvals taken as “once” leave nothing behind.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {grants.map((g, i) => (
            <div
              key={g.id || `grant-${i}`}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '8px 10px',
                border: '1px solid var(--c-border)',
                borderRadius: 4
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                {/*
                  `describes` VERBATIM — the daemon computes the extent and both surfaces render
                  the same string. Re-wording it here would recreate the two-surfaces defect
                  SPRINT-CONSENT removed, and would hide a wrong description rather than show it.
                */}
                <div style={{ fontSize: 12, color: 'var(--c-text)', wordBreak: 'break-word' }}>
                  {g.describes ?? (
                    // No describes → say so. Do NOT reconstruct one from kind/value: an extent
                    // Beacon invented is exactly the thing the operator must not be shown.
                    <span style={{ color: 'var(--c-warn)' }}>
                      (this daemon sent no description for {g.kind ?? 'grant'} {g.value ?? ''})
                    </span>
                  )}
                </div>
                <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--c-text-faint)', marginTop: 3 }}>
                  {g.id ?? 'no-id'}
                  {g.scope ? ` · ${g.scope}` : ''}
                  {grantIsPersistent(g) ? ' · survives restart' : ''}
                </div>
              </div>
              <button
                onClick={() => revoke(g.id ?? '')}
                disabled={!g.id || busy === g.id}
                title={g.id ? `Revoke ${g.id}` : 'This grant has no id — it cannot be revoked from here'}
                style={{
                  fontSize: 11,
                  padding: '3px 9px',
                  border: '1px solid var(--c-border)',
                  borderRadius: 3,
                  background: 'transparent',
                  color: g.id ? 'var(--c-text-dim)' : 'var(--c-text-faint)',
                  cursor: g.id && busy !== g.id ? 'pointer' : 'default'
                }}
              >
                {busy === g.id ? '…' : 'Revoke'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}


/**
 * Usage tab. Owns its own window + fetch rather than riding the panel's single per-tab request,
 * because the window is a property of THIS view and nothing else in Config has one.
 *
 * `initial` is the panel's all-time fetch. It seeds the "All time" window so that selection costs
 * no second request; every other window fetches. Opening on the 30-day default therefore makes one
 * extra call — a deliberate trade for a tab that answers "this month" on open instead of showing a
 * lifetime total that is interesting once and then static.
 */
function UsageTab({ initial }: { initial: unknown }) {
  const [windowId, setWindowId] = useState(DEFAULT_USAGE_WINDOW)
  const [report, setReport] = useState<UsageReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const win = USAGE_WINDOWS.find((w) => w.id === windowId) ?? USAGE_WINDOWS[0]

  useEffect(() => {
    if (win.days === null) {
      setReport(parseUsage(initial))
      setError(null)
      return
    }
    let alive = true
    setReport(null)
    void window.beacon?.daemon
      .get(usagePath(win.days))
      .then((d) => {
        if (!alive) return
        setReport(parseUsage(d))
        setError(null)
      })
      .catch((e) => {
        if (!alive) return
        // Loud: a window that silently shows the previous window's numbers is worse than an error.
        setError(e?.message ? String(e.message) : 'could not load usage for this window')
        setReport(null)
      })
    return () => {
      alive = false
    }
  }, [win.days, initial])

  const u = report
  const modes: BillingMode[] = ['metered', 'subscription', 'local', 'unknown']

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        {USAGE_WINDOWS.map((w) => (
          <button
            key={w.id}
            onClick={() => setWindowId(w.id)}
            style={{
              fontSize: 11,
              padding: '3px 10px',
              borderRadius: 6,
              border: `1px solid ${w.id === windowId ? 'var(--c-arc)' : 'var(--c-line)'}`,
              background: w.id === windowId ? 'var(--c-inset)' : 'transparent',
              color: w.id === windowId ? 'var(--c-text)' : 'var(--c-text-dim)',
              cursor: 'pointer'
            }}
          >
            {w.label}
          </button>
        ))}
      </div>

      {error ? (
        <div style={{ ...muted, color: 'var(--c-err)' }}>Could not load usage: {error}</div>
      ) : !u ? (
        <div style={muted}>Loading…</div>
      ) : (
        <>
          <div style={{ fontSize: 13, color: 'var(--c-text)', marginBottom: 4 }}>{coverageSentence(u.totals)}</div>
          <div style={{ fontSize: 11, color: 'var(--c-text-faint)', marginBottom: 12 }}>
            {windowNote(win, u.trackingSince)}
            {u.totals.runs > 0 ? ` · ${u.totals.runs.toLocaleString()} model calls` : ''}
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {modes
              .filter((m) => u.coverage[m])
              .map((m) => (
                <div key={m} style={{ border: '1px solid var(--c-line)', borderRadius: 8, padding: '6px 10px', minWidth: 108 }}>
                  <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 'var(--track-caps)', color: 'var(--c-text-faint)' }}>
                    {BILLING_LABEL[m]}
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 14, color: 'var(--c-text)', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtTokens(u.coverage[m]?.inputTokens ?? 0)}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--c-text-dim)' }}>
                    {u.coverage[m]?.models ?? 0} model{(u.coverage[m]?.models ?? 0) === 1 ? '' : 's'}
                  </div>
                </div>
              ))}
          </div>

          {u.models.length === 0 ? (
            <div style={muted}>No token usage in this window.</div>
          ) : (
            u.models.map((m) => {
              const cell = costCell(m)
              return (
                <div key={m.model || '(unattributed)'} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--c-line)' }}>
                  <span title={m.model || 'no model recorded on these rows'} style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.model || '(unattributed)'}
                  </span>
                  <span title={m.billingReason} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 5, border: '1px solid var(--c-line)', color: 'var(--c-text-dim)', flexShrink: 0 }}>
                    {BILLING_LABEL[m.billing]}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--c-text-dim)', fontVariantNumeric: 'tabular-nums', minWidth: 64, textAlign: 'right', flexShrink: 0 }}>
                    {fmtTokens(m.inputTokens)} in
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--c-text-faint)', fontVariantNumeric: 'tabular-nums', minWidth: 58, textAlign: 'right', flexShrink: 0 }}>
                    {fmtTokens(m.outputTokens)} out
                  </span>
                  <span
                    title={cell.isMoney ? 'metered — billed per token' : m.billingReason}
                    style={{
                      fontFamily: cell.isMoney ? MONO : 'inherit',
                      fontSize: 11,
                      color: cell.isMoney ? 'var(--c-text)' : 'var(--c-text-faint)',
                      fontStyle: cell.isMoney ? 'normal' : 'italic',
                      minWidth: 62,
                      textAlign: 'right',
                      flexShrink: 0
                    }}
                  >
                    {cell.text}
                  </span>
                </div>
              )
            })
          )}
        </>
      )}
    </div>
  )
}

function TabView({ id, data, reload }: { id: string; data: unknown; reload: () => void }) {
  // Devices owns its own fetching (mint and revoke are writes, not a seeded read), so the tab's
  // seed GET is ignored here — the panel renders exactly as it did when it was a rail view.
  if (id === 'devices') return <DevicesPanel />
  if (id === 'skin') return <SkinTab />
  switch (id) {
    case 'models':
      return <ModelKeysTab data={data} />
    case 'connectors':
      return <ConnectorsTab initial={data} reload={reload} />
    case 'skills':
      return <SkillsTab data={data} />
    case 'usage':
      return <UsageTab initial={data} />
    case 'telemetry': {
      const t = (data as TelemetryDTO) ?? {}
      const rows = toolStatRows(t.tools as Record<string, unknown> | undefined)
      const reading = toolCallsReading(t.total_calls, t.overall_success_rate)
      const pct = reading.kind === 'calls' ? reading.pct : null
      // No calls yet: say so, with no rate, no bar and no colour (a fresh daemon reports a rate of 0 for nothing done).
      if (reading.kind === 'none') return <div style={muted}>No tool calls yet.</div>
      return (
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 6 }}>
            <span style={{ fontFamily: MONO, fontSize: 18, fontVariantNumeric: 'tabular-nums', color: 'var(--c-text)' }}>{t.total_calls ?? 0}</span>
            <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 'var(--track-caps)', color: 'var(--c-text-faint)' }}>calls</span>
            {/* null = the daemon reported no rate. It renders as "—", never as 0% — a fresh daemon
                with nothing measured yet is not a daemon that failed every call. */}
            <span style={{ fontFamily: MONO, fontSize: 18, fontVariantNumeric: 'tabular-nums', color: rateColor(pct) }}>
              {pct === null ? '—' : `${pct}%`}
            </span>
            <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 'var(--track-caps)', color: 'var(--c-text-faint)' }}>success</span>
          </div>
          <div style={{ height: 2, borderRadius: 1, background: 'var(--c-line)', overflow: 'hidden', marginBottom: 12, maxWidth: 360 }}>
            <div style={{ width: `${pct ?? 0}%`, height: '100%', background: rateColor(pct) }} />
          </div>
          {rows.length === 0 ? (
            <div style={muted}>No per-tool telemetry</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 560 }}>
              {rows.map((r) => (
                <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0', borderBottom: '1px solid var(--c-line)' }}>
                  <span style={{ flex: 1, fontFamily: MONO, fontSize: 12, color: 'var(--c-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                  {r.calls !== undefined ? <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--c-text-dim)', fontVariantNumeric: 'tabular-nums' }}>{r.calls}×</span> : null}
                  {r.successRate !== undefined ? (
                    <span style={{ fontFamily: MONO, fontSize: 11, fontVariantNumeric: 'tabular-nums', color: rateColor(ratePct(r.successRate)) }}>
                      {ratePct(r.successRate)}%
                    </span>
                  ) : null}
                  {r.avgLatencyMs !== undefined ? (
                    <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--c-text-faint)', fontVariantNumeric: 'tabular-nums' }}>{Math.round(r.avgLatencyMs)}ms</span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      )
    }
    case 'memory':
      return <MemoryTab data={data} />
    case 'sentinel': {
      const s = (data as SentinelDTO) ?? {}
      const rel = (epoch?: number | null): string => {
        if (!epoch) return '—'
        const mins = Math.floor((Date.now() / 1000 - epoch) / 60)
        return mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ago`
      }
      return (
        <div>
          <div style={{ display: 'flex', gap: 22, marginBottom: 12 }}>
            {[
              { l: 'state', v: (s.state ?? '—').toUpperCase(), c: s.state === 'dreaming' ? 'var(--c-violet)' : 'var(--c-text)' },
              { l: 'dreams', v: String(s.dream_count ?? 0), c: 'var(--c-text)' },
              { l: 'last dream', v: rel(s.last_dream), c: 'var(--c-text-dim)' },
              { l: 'idle since', v: rel(s.idle_since), c: 'var(--c-text-dim)' }
            ].map((x) => (
              <div key={x.l}>
                <div style={{ fontFamily: MONO, fontSize: 15, color: x.c, fontVariantNumeric: 'tabular-nums' }}>{x.v}</div>
                <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 'var(--track-caps)', color: 'var(--c-text-faint)' }}>{x.l}</div>
              </div>
            ))}
          </div>
          {Array.isArray(s.dream_log_tail) && s.dream_log_tail.length > 0 ? <Json value={s.dream_log_tail} /> : null}
        </div>
      )
    }
    case 'wiki': {
      const w = (data as WikiStatsDTO) ?? {}
      const entities = Object.entries(w.entity_counts ?? {})
      return (
        <div>
          <div style={{ fontSize: 13, color: 'var(--c-text)', marginBottom: 10 }}>{w.page_count ?? 0} pages</div>
          {entities.length === 0 ? (
            <div style={muted}>No entities</div>
          ) : (
            entities.map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '2px 0', maxWidth: 320 }}>
                <span style={{ color: 'var(--c-text-dim)' }}>{k}</span>
                <span style={{ color: 'var(--c-text)', fontFamily: MONO }}>{v}</span>
              </div>
            ))
          )}
        </div>
      )
    }
    case 'config': {
      const c = (data as ConfigDTO) ?? {}
      return c.raw_yaml ? <pre style={pre}>{c.raw_yaml}</pre> : <Json value={c.parsed ?? c} />
    }
    case 'profiles': {
      const profiles = asList<ProfileDTO>(data)
      if (profiles.length === 0) return <div style={muted}>No profiles</div>
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {profiles.map((p) => (
            <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: p.is_active ? 'var(--c-ok)' : 'var(--c-line)' }} />
              <span style={{ fontSize: 13, color: p.is_active ? 'var(--c-text)' : 'var(--c-text-dim)', fontWeight: p.is_active ? 600 : 400 }}>{p.name}</span>
              {p.description ? <span style={{ fontSize: 12, color: 'var(--c-text-faint)' }}>— {p.description}</span> : null}
            </div>
          ))}
        </div>
      )
    }
    case 'cron':
      return <CronTab data={data} />
    case 'grants':
      return <GrantsTab data={data} reload={reload} />
    default: {
      const arr = asList(data)
      return arr.length === 0 ? <div style={muted}>None</div> : <Json value={data} />
    }
  }
}

export function ConfigPanel({ initialTab }: { initialTab?: string }) {
  const [active, setActive] = useState<string>(
    CONFIG_TABS.some((t) => t.id === initialTab) ? (initialTab as string) : CONFIG_TABS[0].id
  )
  const [data, setData] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [authErr, setAuthErr] = useState(false)
  // Bumped by a child that mutated server state (revoke), so the tab re-fetches and the row
  // list reflects the daemon rather than an optimistic local guess.
  const [nonce, setNonce] = useState(0)
  // An approved device (not the owner): a tab that reads only the owner's routes is the note, and its seed GET is never sent.
  const role = useDeviceRole()
  const noted = role === 'limited' && isOwnerOnlyConfigTab(active)
  // Main has not said yet whether this is the owner: such a tab waits (Loading…) rather than asks.
  const waiting = role === undefined && isOwnerOnlyConfigTab(active)

  useEffect(() => {
    const b = window.beacon
    if (!b) return
    let alive = true
    setLoading(true)
    setData(null)
    setAuthErr(false)
    const path = CONFIG_TABS.find((t) => t.id === active)?.path ?? CONFIG_TABS[0].path
    // A pathless tab is local-only (Skin). Fetching nothing is the correct behaviour, not an error.
    if (!path || noted || waiting) {
      setLoading(waiting)
      return
    }
    void b.daemon
      .get(path)
      .then((d) => {
        if (alive) {
          setData(d)
          setLoading(false)
        }
      })
      .catch((e) => {
        if (alive) {
          setLoading(false)
          setAuthErr(isAuthError(e))
        }
      })
    return () => {
      alive = false
    }
  }, [active, nonce, noted, waiting])

  return (
    <div style={panel}>
      <div style={head}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 500, color: 'var(--ink)', margin: '0 0 6px' }}>Config</h1>
        {/* R14: twelve siblings are ONE level, grouped by spacing — capability · observability ·
            system — never divided into a second bar. CONFIG_TABS stays the registry (its order
            and count are a tested contract); this only decides where the gaps go. */}
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }} data-testid="config-tab-groups">
          {CONFIG_TAB_GROUPS.map((group) => (
            <div key={group.join(',')} style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
              {group.map((id) => CONFIG_TABS.find((t) => t.id === id)).filter((t): t is (typeof CONFIG_TABS)[number] => !!t).map((t) => (
                <button
                  key={t.id}
                  style={tab(t.id === active)}
                  onClick={() => {
                    // The tab already showing: nothing to change. Resetting here set "Loading…" with no read to clear it (the read runs
                    // when `active` changes, and it did not), so a click on the current tab hung it.
                    if (t.id === active) return
                    setActive(t.id)
                    setLoading(true)
                    setData(null)
                    setAuthErr(false)
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div style={body}>
        {noted ? (
          <OwnerOnlyNote area={active} />
        ) : authErr ? (
          <NotAuthorized what="config" />
        ) : loading ? (
          <div style={muted}>Loading…</div>
        ) : (
          <TabView id={active} data={data} reload={() => setNonce((n) => n + 1)} />
        )}
      </div>
    </div>
  )
}
