import { useState, type CSSProperties } from 'react'
import {
  addServerProblem,
  healthLabel,
  MCP_SERVERS_PATH,
  parseMcpServers,
  toggleTool,
  toolAllowed,
  type McpServer
} from '@shared/connectors'

// Config → Connectors — the management UI over the daemon's MCP client,
// modeled on the Models tab: server cards with PROBED health, an add form, and per-tool
// allowed_tools toggles (the Foundation §2.3a prerequisite rendered as a first-class control).
//
// The daemon surface landed as Prometheus PR 342 (issue 332): two server sources — prometheus.yaml
// (READ-ONLY over REST; the daemon never writes its own yaml) and a REST-managed store. Writes
// apply to the LIVE runtime and the response's `applies` field says so or names why not. A daemon
// predating the endpoint lands in the endpoint-missing state below. The daemon stays the single
// source of truth — every write is followed by a refetch, never an optimistic local guess.

const MONO = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
const card: CSSProperties = {
  border: '1px solid var(--c-line)',
  borderRadius: 8,
  background: 'var(--c-base)',
  padding: '10px 12px',
  marginBottom: 8,
  maxWidth: 640
}
const btn = (danger = false): CSSProperties => ({
  fontSize: 11,
  padding: '3px 9px',
  borderRadius: 6,
  border: '1px solid var(--c-line)',
  background: 'var(--c-raise)',
  color: danger ? 'var(--c-err)' : 'var(--c-text)',
  cursor: 'pointer',
  font: 'inherit'
})
const input: CSSProperties = {
  fontSize: 12,
  padding: '4px 8px',
  background: 'var(--c-inset)',
  border: '1px solid var(--c-line)',
  borderRadius: 6,
  color: 'var(--c-text)',
  outline: 'none',
  font: 'inherit'
}

const HEALTH_COLOR: Record<McpServer['health'], string> = {
  connected: 'var(--c-ok)',
  failed: 'var(--c-err)',
  disabled: 'var(--c-text-faint)',
  unknown: 'var(--c-warn)'
}

function ServerCard({ s, onNote, note, reload }: { s: McpServer; onNote: (id: string, n: string) => void; note?: string; reload: () => void }) {
  const [open, setOpen] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const write = async (method: 'PATCH' | 'DELETE', body?: unknown): Promise<void> => {
    onNote(s.id, '…')
    try {
      const r = (await window.beacon?.daemon.write(`${MCP_SERVERS_PATH}/${encodeURIComponent(s.id)}`, body, method)) as {
        error?: string
        applies?: string
      } | null
      // PR 342's contract: `applies` says whether the change reached the LIVE runtime — anything
      // else names exactly why not, and the operator should see that sentence.
      onNote(s.id, r?.error ? `failed: ${r.error}` : r?.applies && r.applies !== 'live' ? `applies: ${r.applies}` : '')
      reload()
    } catch (e) {
      onNote(s.id, `failed: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`)
    }
  }
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span aria-hidden style={{ width: 8, height: 8, borderRadius: 4, background: HEALTH_COLOR[s.health], flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--c-text)' }}>{s.name}</span>
        <span style={{ fontFamily: MONO, fontSize: 10, textTransform: 'uppercase', letterSpacing: 'var(--track-caps)', color: 'var(--c-text-faint)' }}>
          {s.transport}
        </span>
        {s.readOnly ? (
          <span
            style={{ fontFamily: MONO, fontSize: 10, textTransform: 'uppercase', letterSpacing: 'var(--track-caps)', color: 'var(--c-text-faint)' }}
            title="Defined in prometheus.yaml — the daemon never writes its own yaml, so this card is read-only over REST"
          >
            yaml · read-only
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        {s.readOnly ? null : (
          <>
            <button style={btn()} onClick={() => void write('PATCH', { enabled: !s.enabled })}>
              {s.enabled ? 'Disable' : 'Enable'}
            </button>
            {confirmRemove ? (
              <button style={btn(true)} onClick={() => void write('DELETE')} title="Yes, remove this server">
                Remove — sure?
              </button>
            ) : (
              <button style={btn(true)} onClick={() => setConfirmRemove(true)} title="Remove this server">
                Remove
              </button>
            )}
          </>
        )}
      </div>
      <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--c-text-dim)', margin: '6px 0 0 18px', overflowWrap: 'anywhere' }}>
        {s.transport === 'stdio' ? s.command ?? '(no command)' : s.url ?? '(no url)'}
      </div>
      <div style={{ fontSize: 11, color: s.health === 'failed' ? 'var(--c-err)' : 'var(--c-text-dim)', margin: '4px 0 0 18px' }}>
        {healthLabel(s)}
      </div>
      {s.tools.length > 0 ? (
        <div style={{ margin: '6px 0 0 18px' }}>
          <button style={{ ...btn(), border: 'none', background: 'transparent', color: 'var(--c-arc)', padding: 0 }} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? '▾' : '▸'} tools ({s.allowedTools === null ? `all ${s.tools.length} allowed` : `${s.allowedTools.length} of ${s.tools.length} allowed`})
          </button>
          {open ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
              {s.tools.map((t) => (
                <label key={t.name} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, color: 'var(--c-text)', cursor: s.readOnly ? 'default' : 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={toolAllowed(s.allowedTools, t.name)}
                    disabled={!!s.readOnly}
                    onChange={() => void write('PATCH', { allowed_tools: toggleTool(s.allowedTools, s.tools, t.name) })}
                    aria-label={`Allow tool ${t.name}`}
                    title={s.readOnly ? 'yaml-defined server — edit allowed_tools in prometheus.yaml' : undefined}
                  />
                  <span style={{ fontFamily: MONO }}>{t.name}</span>
                  {t.readOnlyHint === false ? (
                    <span
                      style={{ fontFamily: MONO, fontSize: 9, textTransform: 'uppercase', letterSpacing: 'var(--track-caps)', color: 'var(--c-warn)' }}
                      title="Not read-only — calls need approval at the gate"
                    >
                      writes
                    </span>
                  ) : null}
                  {t.description ? <span style={{ fontSize: 11, color: 'var(--c-text-faint)' }}>{(t.description ?? '').split('\n')[0].slice(0, 90)}</span> : null}
                </label>
              ))}
            </div>
          ) : null}
        </div>
      ) : s.health === 'connected' ? (
        <div style={{ fontSize: 11, color: 'var(--c-text-faint)', margin: '4px 0 0 18px' }}>no tools offered</div>
      ) : null}
      {note ? (
        <div style={{ fontSize: 11, color: 'var(--c-text-dim)', margin: '4px 0 0 18px' }} role="status">
          {note}
        </div>
      ) : null}
    </div>
  )
}

function AddServerForm({ reload }: { reload: () => void }) {
  const [openForm, setOpenForm] = useState(false)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [note, setNote] = useState('')
  const submit = async (): Promise<void> => {
    const problem = addServerProblem({ name, transport: 'stdio', command })
    if (problem) {
      setNote(problem)
      return
    }
    setNote('adding…')
    try {
      // PR 342's store shape: command + args split, the way the daemon spawns it. The command runs
      // ON THE DAEMON HOST, which the placeholder says out loud. (stdio is the only transport the
      // daemon implements — PR 315's accepted limit — so there is no transport picker to offer.)
      const parts = command.trim().split(/\s+/)
      const body = { name: name.trim(), command: parts[0], args: parts.slice(1) }
      const r = (await window.beacon?.daemon.write(MCP_SERVERS_PATH, body, 'POST')) as { error?: string; applies?: string } | null
      if (r?.error) {
        setNote(`failed: ${r.error}`)
        return
      }
      setName('')
      setCommand('')
      setNote('')
      setOpenForm(false)
      reload()
    } catch (e) {
      setNote(`failed: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`)
    }
  }
  if (!openForm)
    return (
      <button style={btn()} onClick={() => setOpenForm(true)}>
        ＋ Add server
      </button>
    )
  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <input style={{ ...input, width: 200 }} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Server name" />
      <input
        style={input}
        placeholder="Command (runs on the DAEMON host, e.g. uvx mcp-server-time)"
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        aria-label="Command"
        spellCheck={false}
      />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button style={btn()} onClick={() => void submit()}>
          Add
        </button>
        <button style={{ ...btn(), color: 'var(--c-text-dim)' }} onClick={() => setOpenForm(false)}>
          Cancel
        </button>
        {note ? (
          <span style={{ fontSize: 11, color: 'var(--c-text-dim)' }} role="status">
            {note}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export function ConnectorsTab({ initial, reload }: { initial: unknown; reload: () => void }) {
  const [notes, setNotes] = useState<Record<string, string>>({})
  // ConfigPanel hands null when the GET failed — for connectors that is TODAY'S daemon, so the
  // missing endpoint is a first-class state naming the issue, never a blank pane.
  if (initial === null || initial === undefined)
    return (
      <div style={{ maxWidth: 560, fontSize: 13, color: 'var(--c-text-dim)', lineHeight: 1.5 }}>
        This daemon predates the connectors surface. Prometheus issue{' '}
        <a href="https://github.com/OAraLabs/Prometheus/issues/332" target="_blank" rel="noreferrer" style={{ color: 'var(--c-arc)' }}>
          332
        </a>{' '}
        added <span style={{ fontFamily: MONO }}>GET /api/mcp/servers</span> over the MCP client.
        Update and redeploy the daemon to light it up.
      </div>
    )
  const servers = parseMcpServers(initial)
  const onNote = (id: string, n: string): void => setNotes((prev) => ({ ...prev, [id]: n }))
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--c-text-dim)', marginBottom: 10, maxWidth: 620 }}>
        MCP servers give the agent tools (Foundation §2.3a). Tools run on the daemon, not in Beacon; the per-tool
        checkboxes are the daemon’s <span style={{ fontFamily: MONO }}>allowed_tools</span> allowlist — an unchecked tool is never even registered.
      </div>
      {servers.length === 0 ? <div style={{ fontSize: 13, color: 'var(--c-text-dim)', marginBottom: 10 }}>No servers configured yet.</div> : null}
      {servers.map((s) => (
        <ServerCard key={s.id} s={s} onNote={onNote} note={notes[s.id]} reload={reload} />
      ))}
      <AddServerForm reload={reload} />
    </div>
  )
}
