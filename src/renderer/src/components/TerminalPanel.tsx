// Terminal pane — an xterm.js surface over ptys that live in MAIN (window.beacon.terminal). Shells
// survive this component: unmount detaches, mount re-attaches and replays scrollback, so switching
// panes, switching tabs, popping out, or reloading the window never restarts one. Hosted by the
// chat view's side panel (SidePanel.tsx) or, popped out, by TerminalWindow.
//
// THE INVARIANT (claude/BEACON-TERMINAL-SCOPE.md): this is a HUMAN surface. The ONLY thing written
// into a pty is what xterm emits from the keyboard/paste (`term.onData` → `terminal.write`). This
// file never touches chat, streams, gateway events, or the daemon; terminal-smoke asserts that on
// the source. No colours are defined here — the theme is read from the live tokens.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  describeExit,
  isTerminalOpenError,
  xtermThemeFromTokens,
  type TerminalOpenRequest,
  type TerminalPlacement,
  type TerminalSession
} from '@shared/terminal'
import { sshCommand, sshReadiness, type TailnetPeer, type TailnetStatus } from '@shared/tailscale'

const MONO = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
// Fills whatever hosts it: the side panel's body (a column) or the pop-out window (a row).
const panel: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
const head: CSSProperties = { padding: '10px 16px', borderBottom: '1px solid var(--c-line)', background: 'var(--c-raise)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }
const title: CSSProperties = { fontSize: 15, fontWeight: 600, color: 'var(--c-text)' }
const sub: CSSProperties = { fontSize: 12, color: 'var(--c-text-dim)', fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const spacer: CSSProperties = { flex: 1 }
const btn = (disabled: boolean): CSSProperties => ({
  font: 'inherit',
  fontSize: 12,
  padding: '4px 10px',
  borderRadius: 'var(--r-2, 6px)',
  border: '1px solid var(--c-line)',
  background: 'var(--c-base)',
  color: disabled ? 'var(--c-text-faint)' : 'var(--c-text)',
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.6 : 1
})
// Tab strip — one row of session tabs + a "+" — sits between the header and the surface.
const strip: CSSProperties = { display: 'flex', alignItems: 'stretch', gap: 2, padding: '4px 8px 0', background: 'var(--c-raise)', borderBottom: '1px solid var(--c-line)', flexShrink: 0, overflowX: 'auto' }
const tab = (active: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 6px 4px 10px',
  fontFamily: MONO,
  fontSize: 12,
  color: active ? 'var(--c-text)' : 'var(--c-text-dim)',
  background: active ? 'var(--c-base)' : 'transparent',
  border: '1px solid var(--c-line)',
  borderBottom: active ? '1px solid var(--c-base)' : '1px solid transparent',
  borderRadius: 'var(--r-2, 6px) var(--r-2, 6px) 0 0',
  marginBottom: -1,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  maxWidth: 220
})
const tabDot = (exited: boolean): CSSProperties => ({ width: 6, height: 6, borderRadius: '50%', background: exited ? 'var(--c-err)' : 'var(--c-ok)', flexShrink: 0 })
const tabClose: CSSProperties = { font: 'inherit', fontSize: 12, lineHeight: 1, padding: '2px 4px', border: 'none', background: 'transparent', color: 'var(--c-text-faint)', cursor: 'pointer', borderRadius: 'var(--r-1, 4px)' }
const tabAdd: CSSProperties = { ...tabClose, padding: '2px 8px', alignSelf: 'center', color: 'var(--c-text-dim)', fontSize: 14 }
const renameInput: CSSProperties = { font: 'inherit', fontFamily: MONO, fontSize: 12, width: 120, padding: '1px 4px', border: '1px solid var(--c-arc)', borderRadius: 'var(--r-1, 4px)', background: 'var(--c-base)', color: 'var(--c-text)' }
// Peer row (Phase 4) — tailnet boxes as buttons; derived from `tailscale status`, never a stored list.
const peersRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: 'var(--c-raise)', borderBottom: '1px solid var(--c-line)', flexShrink: 0, overflowX: 'auto', fontFamily: MONO, fontSize: 11, color: 'var(--c-text-dim)' }
const peerBtn = (online: boolean): CSSProperties => ({
  font: 'inherit',
  fontFamily: MONO,
  fontSize: 11,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '2px 8px',
  borderRadius: 'var(--r-round, 999px)',
  border: '1px solid var(--c-line)',
  background: 'transparent',
  color: online ? 'var(--c-text)' : 'var(--c-text-faint)',
  cursor: 'pointer',
  whiteSpace: 'nowrap'
})
const peerDot = (online: boolean): CSSProperties => ({ width: 6, height: 6, borderRadius: '50%', background: online ? 'var(--c-ok)' : 'var(--c-idle)', flexShrink: 0 })
const placeholder: CSSProperties = { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--c-text-dim)', fontFamily: MONO, fontSize: 13 }
const body: CSSProperties = { flex: 1, minHeight: 0, background: 'var(--c-base)', padding: '6px 0 0 8px', position: 'relative' }
const host: CSSProperties = { width: '100%', height: '100%' }
const exitBar: CSSProperties = { position: 'absolute', left: 0, right: 0, bottom: 0, padding: '8px 16px', background: 'var(--c-raise)', borderTop: '1px solid var(--c-line)', color: 'var(--c-text)', fontFamily: MONO, fontSize: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }

/** The live token values, read at call time so a theme flip re-paints the terminal. */
const readTheme = (): Record<string, string> => {
  const cs = getComputedStyle(document.documentElement)
  return xtermThemeFromTokens((name) => cs.getPropertyValue(name))
}

/** The tab this window last showed — survives an unmount so re-entering the view re-attaches to
 *  the same shell (main keeps every shell alive either way). */
let lastActiveId: string | null = null

export interface TerminalPanelProps {
  /** `popout` = this instance IS the detached window (#terminal). In the main window the pane
   *  yields to the pop-out while one exists: it detaches and shows a placeholder instead of mirroring. */
  popout?: boolean
  /** Phase 4: a request to open right away (e.g. `ssh <host>` from a peer button). */
  openRequest?: TerminalOpenRequest | null
}

export function TerminalPanel({ popout = false, openRequest = null }: TerminalPanelProps = {}): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [sessions, setSessions] = useState<TerminalSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(lastActiveId)
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [tailnet, setTailnet] = useState<TailnetStatus | null>(null)
  // null until main answers; the main-window pane must not attach before it knows.
  const [placement, setPlacement] = useState<TerminalPlacement | null>(null)

  const refresh = useCallback(async (): Promise<TerminalSession[]> => {
    const list = (await window.beacon?.terminal.list()) ?? []
    setSessions(list)
    return list
  }, [])

  useEffect(() => {
    const b = window.beacon
    if (!b) return
    let live = true
    void b.terminal.placement().then((p) => { if (live) setPlacement(p) })
    const off = b.terminal.onPlacement((p) => setPlacement(p))
    return () => { live = false; off() }
  }, [])

  // Exactly one of the two windows attaches: the main pane while NOT popped out, the pop-out
  // while it is. The pop-out window is hidden rather than destroyed on pop-in / close, so its
  // pane must let go of the pty too, or two surfaces would mirror one shell.
  const yields = placement !== null && placement.poppedOut !== popout
  const ready = placement !== null

  /** Spawn a session and make it the active tab. Failures are shown, not thrown. */
  const openTab = useCallback(async (req: TerminalOpenRequest): Promise<void> => {
    const b = window.beacon
    if (!b) return
    const r = await b.terminal.open(req)
    if (!r) { setError('main refused to open a shell for this window'); return }
    if (isTerminalOpenError(r)) { setError(r.error); await refresh(); return }
    setError(null)
    lastActiveId = r.id
    setActiveId(r.id)
    await refresh()
  }, [refresh])

  // Pick a tab on mount: the one this window last showed, else the newest live one, else spawn.
  useEffect(() => {
    if (!ready || yields) return
    let live = true
    void (async () => {
      const list = await refresh()
      if (!live) return
      if (openRequest) { await openTab(openRequest); return }
      const remembered = activeId && list.find((s) => s.id === activeId)
      if (remembered) return
      const newest = [...list].reverse().find((s) => !s.exit) ?? [...list].reverse()[0]
      if (newest) { lastActiveId = newest.id; setActiveId(newest.id); return }
      await openTab({ cols: 80, rows: 24 })
    })()
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, yields, openRequest])

  // The peer row: asked for on mount and on demand; never cached across mounts, never persisted.
  const loadPeers = useCallback(async (): Promise<void> => {
    const t = await window.beacon?.terminal.peers().catch(() => null)
    if (t) setTailnet(t)
  }, [])
  useEffect(() => {
    if (!ready || yields) return
    void loadPeers()
  }, [ready, yields, loadPeers])

  /** A peer button: opens `ssh <host>` in a new tab only when no credential could ever be asked
   *  for; otherwise reports why and does nothing. */
  const openPeer = (peer: TailnetPeer): void => {
    if (!tailnet) return
    const r = sshReadiness(peer, tailnet)
    if (!r.ok) { setError(r.reason); return }
    void openTab({ cols: 80, rows: 24, command: sshCommand(peer), title: `ssh ${peer.hostName}` })
  }

  // Any tab may exit while another is shown: keep the strip's status dots truthful.
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    return b.terminal.onExit(() => { void refresh() })
  }, [refresh])

  // The xterm surface for the ACTIVE tab. Re-created per tab: dispose + attach-with-replay is what
  // a reload does too, so one code path covers view switch, tab switch, and pop-out.
  useEffect(() => {
    if (!ready || yields || !activeId) return
    const b = window.beacon
    const el = hostRef.current
    if (!b || !el) {
      setError('terminal bridge unavailable')
      return
    }
    const id = activeId
    const term = new Terminal({
      fontFamily: MONO,
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      macOptionIsMeta: false,
      theme: readTheme()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    fit.fit()

    let disposed = false
    const unsubs: Array<() => void> = []

    // Re-skin with the app: the tokens change when <html data-theme> flips.
    const mo = new MutationObserver(() => { term.options.theme = readTheme() })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    unsubs.push(() => mo.disconnect())

    // Keep the pty's geometry equal to the pane's: fit on every size change → onResize → main.
    const ro = new ResizeObserver(() => { try { fit.fit() } catch { /* not laid out yet */ } })
    ro.observe(el)
    unsubs.push(() => ro.disconnect())
    unsubs.push(term.onResize(({ cols, rows }) => { b.terminal.resize(id, cols, rows) }).dispose)

    // THE only writer: what the keyboard/paste produced inside xterm.
    unsubs.push(term.onData((data) => { b.terminal.write(id, data) }).dispose)

    unsubs.push(b.terminal.onData((m) => { if (m.id === id) term.write(m.data) }))

    void (async () => {
      const attached = await b.terminal.attach(id, term.cols, term.rows)
      if (disposed) { if (attached) b.terminal.detach(id); return }
      if (!attached) { setError('session vanished before attach'); await refresh(); return }
      setError(null)
      if (attached.replay) term.write(attached.replay)
      term.focus()
    })()

    return () => {
      disposed = true
      for (const u of unsubs) u()
      b.terminal.detach(id)
      term.dispose()
    }
  }, [activeId, ready, yields, refresh])

  const active = sessions.find((s) => s.id === activeId) ?? null

  const selectTab = (id: string): void => { lastActiveId = id; setActiveId(id); setError(null) }
  const closeTab = async (id: string): Promise<void> => {
    await window.beacon?.terminal.close(id)
    const list = await refresh()
    if (activeId === id) {
      const next = list[list.length - 1] ?? null
      lastActiveId = next?.id ?? null
      setActiveId(next?.id ?? null)
      if (!next) await openTab({ cols: 80, rows: 24 })
    }
  }
  const commitRename = async (): Promise<void> => {
    if (!renaming) return
    const { id, value } = renaming
    setRenaming(null)
    if (value.trim()) { await window.beacon?.terminal.rename(id, value); await refresh() }
  }

  return (
    <div style={panel}>
      <div style={head}>
        <span style={title}>Terminal</span>
        <span style={sub} title="These shells run on this Mac, outside the daemon and its gate. The agent cannot write into them.">
          {active ? `${active.shell}  pid ${active.pid}  ·  ${active.cwd}` : error ? `unavailable — ${error}` : 'starting shell…'}
        </span>
        <span style={spacer} />
        {popout ? (
          <button type="button" style={btn(false)} onClick={() => window.beacon?.terminal.popIn()} title="Close this window and show the terminal in the main window">
            Pop in
          </button>
        ) : (
          <button type="button" style={btn(yields)} disabled={yields} onClick={() => void window.beacon?.terminal.popOut()} title="Detach the terminal into its own window — the shells keep running">
            Pop out
          </button>
        )}
      </div>
      {yields ? (
        <div style={placeholder}>
          {popout ? (
            <span>The terminal is back in the main window.</span>
          ) : (
            <>
              <span>The terminal is open in its own window.</span>
              <button type="button" style={btn(false)} onClick={() => window.beacon?.terminal.popIn()}>Bring it back here</button>
            </>
          )}
        </div>
      ) : (
        <>
          <div style={strip} role="tablist" aria-label="Terminal tabs">
            {sessions.map((s) => (
              <div
                key={s.id}
                role="tab"
                aria-selected={s.id === activeId}
                style={tab(s.id === activeId)}
                onClick={() => selectTab(s.id)}
                onDoubleClick={() => setRenaming({ id: s.id, value: s.title })}
                title={s.exit ? describeExit(s.exit, s.shell) : `${s.title} — pid ${s.pid} (double-click to rename)`}
              >
                <span style={tabDot(s.exit !== null)} aria-label={s.exit ? 'exited' : 'running'} />
                {renaming?.id === s.id ? (
                  <input
                    autoFocus
                    style={renameInput}
                    value={renaming.value}
                    onChange={(e) => setRenaming({ id: s.id, value: e.target.value })}
                    onBlur={() => void commitRename()}
                    onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(); else if (e.key === 'Escape') setRenaming(null) }}
                    onClick={(e) => e.stopPropagation()}
                    aria-label="Tab name"
                  />
                ) : (
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title}</span>
                )}
                <button type="button" style={tabClose} title="Close this shell" aria-label={`Close ${s.title}`} onClick={(e) => { e.stopPropagation(); void closeTab(s.id) }}>×</button>
              </div>
            ))}
            <button type="button" style={tabAdd} title="New shell" aria-label="New shell" onClick={() => void openTab({ cols: 80, rows: 24 })}>+</button>
          </div>
          <div style={peersRow} aria-label="Tailnet peers">
            <span title="Boxes on your tailnet, from `tailscale status`. Auth is Tailscale SSH or your ssh-agent — Beacon never asks for, sees, or stores a credential.">tailnet</span>
            {tailnet === null ? (
              <span>…</span>
            ) : !tailnet.available ? (
              <span title={tailnet.error}>{tailnet.error ?? 'tailscale unavailable'}</span>
            ) : tailnet.peers.length === 0 ? (
              <span>no ssh-capable peers ({tailnet.backendState ?? 'unknown state'})</span>
            ) : (
              tailnet.peers.map((peer) => {
                const r = sshReadiness(peer, tailnet)
                return (
                  <button
                    key={peer.dnsName}
                    type="button"
                    style={peerBtn(peer.online)}
                    onClick={() => openPeer(peer)}
                    data-peer={peer.hostName}
                    data-ready={r.ok ? r.mode : 'no'}
                    title={r.ok ? `ssh ${peer.dnsName} (${r.mode}) — ${peer.os}` : r.reason}
                  >
                    <span style={peerDot(peer.online)} aria-label={peer.online ? 'online' : 'offline'} />
                    {peer.hostName}
                  </button>
                )
              })
            )}
            <button type="button" style={tabClose} title="Refresh the peer list" aria-label="Refresh peers" onClick={() => void loadPeers()}>↻</button>
          </div>
          <div style={body}>
            <div ref={hostRef} style={host} />
            {error && !active?.exit && (
              <div style={exitBar} role="alert">
                <span>{error}</span>
              </div>
            )}
            {active?.exit && (
              <div style={exitBar} role="status">
                <span>{describeExit(active.exit, active.shell)}</span>
                <button type="button" style={btn(false)} onClick={() => void openTab({ cols: 80, rows: 24, command: active.command, title: active.title })}>Start it again</button>
                <button type="button" style={btn(false)} onClick={() => void closeTab(active.id)}>Close tab</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
