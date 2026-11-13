import { useEffect, useState, type CSSProperties } from 'react'
import {
  addServerProblem,
  DEFAULT_TOKEN_HEADER,
  healthLabel,
  keyKnowledge,
  MAIN_KEY_NOTE,
  offersWrites,
  MCP_SERVERS_PATH,
  parseMcpServers,
  toggleTool,
  toolAllowed,
  urlServerBody,
  urlServerProblem,
  writeFailure,
  type KeyKnowledge,
  type McpServer,
  type UrlTransport
} from '@shared/connectors'
import { DEVICES_PATH } from '@shared/device-role'

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

function ServerCard({ s, onNote, note, reload, canWrite }: { s: McpServer; onNote: (id: string, n: string) => void; note?: string; reload: () => void; canWrite: boolean }) {
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
      onNote(s.id, writeFailure(e instanceof Error ? e.message : String(e), body).words)
    }
  }
  // Read-only when the server is defined in prometheus.yaml, or when this Beacon does not hold the
  // main key (the note above the list says why): nothing that would be refused is offered.
  const locked = !!s.readOnly || !canWrite
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
        {locked ? null : (
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
      {s.headerNames.length > 0 ? (
        <div style={{ fontSize: 11, color: 'var(--c-text-dim)', margin: '4px 0 0 18px' }}>
          Signs in with a token Prometheus keeps ({s.headerNames.join(', ')}). It is never shown here.
        </div>
      ) : null}
      {s.tools.length > 0 ? (
        <div style={{ margin: '6px 0 0 18px' }}>
          <button style={{ ...btn(), border: 'none', background: 'transparent', color: 'var(--c-arc)', padding: 0 }} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? '▾' : '▸'} tools ({s.allowedTools === null ? `all ${s.tools.length} allowed` : `${s.allowedTools.length} of ${s.tools.length} allowed`})
          </button>
          {open ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
              {s.tools.map((t) => (
                <label key={t.name} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, color: 'var(--c-text)', cursor: locked ? 'default' : 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={toolAllowed(s.allowedTools, t.name)}
                    disabled={locked}
                    onChange={() => void write('PATCH', { allowed_tools: toggleTool(s.allowedTools, s.tools, t.name) })}
                    aria-label={`Allow tool ${t.name}`}
                    title={s.readOnly ? 'yaml-defined server — edit allowed_tools in prometheus.yaml' : locked ? MAIN_KEY_NOTE.title : undefined}
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

type AddKind = 'url' | 'command'

/** Add a server: one at an address (with the token it signs in with), or a command that runs on
 *  the Prometheus computer. The token is held only in this form's state, sent once in the POST,
 *  and dropped when the POST answers (@shared/connectors, "WHERE THE TOKEN GOES"). */
function AddServerForm({ reload, onNotice }: { reload: () => void; onNotice: (words: string) => void }) {
  const [openForm, setOpenForm] = useState(false)
  const [kind, setKind] = useState<AddKind>('url')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [url, setUrl] = useState('')
  const [transport, setTransport] = useState<UrlTransport>('streamable-http')
  const [token, setToken] = useState('')
  const [headerName, setHeaderName] = useState<string>(DEFAULT_TOKEN_HEADER)
  const [otherHeader, setOtherHeader] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const close = (): void => {
    setToken('')
    setNote('')
    setOpenForm(false)
  }
  const submit = async (): Promise<void> => {
    if (busy) return
    const form = { name, url, transport, token, headerName: otherHeader ? headerName : DEFAULT_TOKEN_HEADER }
    const problem = kind === 'url' ? urlServerProblem(form) : addServerProblem({ name, transport: 'stdio', command })
    if (problem) {
      setNote(problem)
      return
    }
    setBusy(true)
    setNote('Adding… Prometheus connects to the server before it answers, which can take a little while.')
    // The store's shape (Prometheus PR 342): a command is split the way the daemon spawns it, and
    // runs ON THE PROMETHEUS COMPUTER, which the form says out loud; an address carries its
    // transport and, when there is a token, the one header that signs in.
    const parts = command.trim().split(/\s+/)
    const body = kind === 'url' ? urlServerBody(form) : { name: name.trim(), command: parts[0], args: parts.slice(1) }
    const hadToken = kind === 'url' && !!token.trim()
    try {
      const r = (await window.beacon?.daemon.write(MCP_SERVERS_PATH, body, 'POST')) as { error?: string; applies?: string } | null
      // Sent. Whatever the answer, the token has done its one job here.
      setToken('')
      if (r?.error) {
        setNote(writeFailure(`HTTP 200: POST ${MCP_SERVERS_PATH} — ${r.error}`, body).words)
        return
      }
      setName('')
      setCommand('')
      setUrl('')
      setNote('')
      setOpenForm(false)
      reload()
    } catch (e) {
      setToken('')
      const f = writeFailure(e instanceof Error ? e.message : String(e), body)
      if (f.kind === 'no-answer') {
        // It may have been added all the same: show the list as Prometheus has it now, and do not
        // send anyone to type the token again for a server that is already there. (The reload
        // remounts this tab, so the words go to the tab, which outlives it.)
        onNotice(f.words)
        reload()
        return
      }
      setNote(`${f.words}${hadToken && f.kind === 'refused' ? ' Enter the token again to retry.' : ''}`)
    } finally {
      setBusy(false)
    }
  }
  if (!openForm)
    return (
      <button style={btn()} onClick={() => setOpenForm(true)}>
        ＋ Add server
      </button>
    )
  const pick = (k: AddKind): CSSProperties => ({ ...btn(), background: kind === k ? 'var(--c-arc-soft)' : 'var(--c-raise)', color: kind === k ? 'var(--c-arc)' : 'var(--c-text)' })
  const hint: CSSProperties = { fontSize: 11, color: 'var(--c-text-dim)', lineHeight: 1.4 }
  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6 }} role="group" aria-label="Where the server is">
        <button style={pick('url')} aria-pressed={kind === 'url'} onClick={() => { setKind('url'); setNote('') }}>
          At an address
        </button>
        <button style={pick('command')} aria-pressed={kind === 'command'} onClick={() => { setKind('command'); setToken(''); setNote('') }}>
          A command on the Prometheus computer
        </button>
      </div>
      <input style={{ ...input, width: 200 }} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Server name" />
      {kind === 'command' ? (
        <input
          style={input}
          placeholder="Command (runs on the Prometheus computer, e.g. uvx mcp-server-time)"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          aria-label="Command"
          spellCheck={false}
        />
      ) : (
        <>
          <input style={input} placeholder="https://example.com/mcp (an address Prometheus can reach)" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Server address" spellCheck={false} autoCapitalize="off" />
          <label style={{ ...hint, display: 'flex', alignItems: 'center', gap: 6 }}>
            How it talks
            <select style={{ ...input, padding: '3px 6px' }} value={transport} onChange={(e) => setTransport(e.target.value as UrlTransport)} aria-label="How it talks">
              <option value="streamable-http">Streamable HTTP (most servers)</option>
              <option value="sse">SSE (older servers)</option>
            </select>
          </label>
          <input
            style={input}
            type="password"
            placeholder="Token, if the server needs one"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            aria-label="Token"
            aria-describedby="connector-token-hint"
            autoComplete="new-password"
            spellCheck={false}
          />
          <div id="connector-token-hint" style={hint}>
            The token goes to Prometheus, which keeps it and uses it to sign in to this server. Beacon does not keep it and cannot show it again. To change it later, remove the server and add it again (its allowed-tools choices start over).
          </div>
          <label style={{ ...hint, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={otherHeader} onChange={(e) => setOtherHeader(e.target.checked)} />
            The server asks for the token in a header other than Authorization
          </label>
          {otherHeader ? (
            <input style={{ ...input, width: 220 }} placeholder="Header name, e.g. X-API-Key" value={headerName} onChange={(e) => setHeaderName(e.target.value)} aria-label="Header name" spellCheck={false} />
          ) : null}
        </>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button style={{ ...btn(), cursor: busy ? 'not-allowed' : 'pointer', color: busy ? 'var(--c-text-faint)' : 'var(--c-text)' }} disabled={busy} onClick={() => void submit()}>
          Add
        </button>
        <button style={{ ...btn(), color: 'var(--c-text-dim)' }} onClick={close}>
          Cancel
        </button>
      </div>
      {/* Always mounted, so a screen reader hears the text arrive. */}
      <div style={{ fontSize: 11, color: 'var(--c-text-dim)', lineHeight: 1.4 }} role="status">
        {note}
      </div>
    </div>
  )
}

const KEY_REMEMBER_MS = 5_000
let lastKey: { value: KeyKnowledge; at: number } = { value: 'asking', at: 0 }
/** Words for the tab to show after the reload that follows a write with no answer. */
let pendingNotice = ''

export function ConnectorsTab({ initial, reload }: { initial: unknown; reload: () => void }) {
  const [notes, setNotes] = useState<Record<string, string>>({})
  // Which key this Beacon holds (GET /api/devices is allowed to every key). Until the answer comes
  // no write control is offered (@shared/connectors keyKnowledge). A write reloads this tab, which
  // remounts it: the last answer is kept for a few seconds so the controls do not blink away and a
  // click cannot land in the gap.
  const [key, setKey] = useState<KeyKnowledge>(() => (Date.now() - lastKey.at < KEY_REMEMBER_MS ? lastKey.value : 'asking'))
  const [notice, setNotice] = useState(() => {
    const words = pendingNotice
    pendingNotice = ''
    return words
  })
  useEffect(() => {
    let alive = true
    const got = (k: KeyKnowledge): void => {
      lastKey = { value: k, at: Date.now() }
      if (alive) setKey(k)
    }
    const b = window.beacon
    if (!b) return got('unknown')
    void b.daemon.get(DEVICES_PATH).then(
      (d) => got(keyKnowledge({ state: 'answered', devices: d })),
      () => got(keyKnowledge({ state: 'failed' }))
    )
    return () => {
      alive = false
    }
  }, [])
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
  const canWrite = offersWrites(key)
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--c-text-dim)', marginBottom: 10, maxWidth: 620 }}>
        MCP servers give the agent tools (Foundation §2.3a). Tools run on the daemon, not in Beacon; the per-tool
        checkboxes are the daemon’s <span style={{ fontFamily: MONO }}>allowed_tools</span> allowlist — an unchecked tool is never even registered.
      </div>
      {servers.length === 0 ? <div style={{ fontSize: 13, color: 'var(--c-text-dim)', marginBottom: 10 }}>No servers configured yet.</div> : null}
      {notice ? (
        <div style={{ fontSize: 12, color: 'var(--c-warn-text)', marginBottom: 10, maxWidth: 620 }} role="status">
          {notice}
        </div>
      ) : null}
      {key === 'device' ? (
        <div style={{ ...card, maxWidth: 620 }} role="note" aria-label={MAIN_KEY_NOTE.title}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--c-text)', marginBottom: 4 }}>{MAIN_KEY_NOTE.title}</div>
          <div style={{ fontSize: 12, color: 'var(--c-text-dim)', lineHeight: 1.5 }}>{MAIN_KEY_NOTE.body}</div>
          <div style={{ fontSize: 12, color: 'var(--c-text-dim)', lineHeight: 1.5, marginTop: 6 }}>{MAIN_KEY_NOTE.how}</div>
        </div>
      ) : null}
      {servers.map((s) => (
        <ServerCard key={s.id} s={s} onNote={onNote} note={notes[s.id]} reload={reload} canWrite={canWrite} />
      ))}
      {canWrite ? (
        <AddServerForm
          reload={reload}
          onNotice={(words) => {
            pendingNotice = words
            setNotice(words)
          }}
        />
      ) : null}
    </div>
  )
}
