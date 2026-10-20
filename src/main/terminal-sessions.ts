// The pty side of the terminal pane — node-pty sessions owned by the MAIN process, so a renderer
// reload, a detached window, or a closed pane never kills the shell. No Electron import: the headless
// smoke drives this class with real ptys under ELECTRON_RUN_AS_NODE.
//
// THIS IS THE ONLY FILE THAT TOUCHES node-pty. Its one input path is `write(id, data)`, whose one
// caller is the terminal:write IPC handler (terminal-ipc.ts), whose one sender is the pane's xterm
// keyboard. terminal-smoke pins all three facts on the source.
import * as pty from 'node-pty'
import { accessSync, constants as fsConstants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import {
  ScrollbackBuffer,
  SCROLLBACK_LIMIT,
  defaultTitle,
  type TerminalAttachResult,
  type TerminalOpenError,
  type TerminalExit,
  type TerminalOpenRequest,
  type TerminalSession
} from '@shared/terminal'

export interface TerminalSink {
  data(id: string, chunk: string): void
  exit(id: string, exit: TerminalExit): void
}

interface Live {
  session: TerminalSession
  proc: pty.IPty | null // null once exited
  scrollback: ScrollbackBuffer
  sinks: Set<TerminalSink>
}

export interface TerminalSessionsOptions {
  shell: string // login shell to run when a request carries no command
  shellArgs?: string[]
  home: string
  env: NodeJS.ProcessEnv
  scrollbackLimit?: number
}

let counter = 0
const mkId = (): string => `t${++counter}-${Math.random().toString(36).slice(2, 8)}`

/** Where a program would be found — or null. node-pty spawns a MISSING program as a pty that exits 1
 *  with no output at all (measured 2026-09-03), which is exactly the silent failure the pane must not
 *  show; resolving first turns it into a sentence. */
export function resolveProgram(prog: string, pathEnv: string | undefined, cwd: string): string | null {
  const runnable = (p: string): boolean => { try { accessSync(p, fsConstants.X_OK); return true } catch { return false } }
  if (prog.includes('/')) {
    const p = isAbsolute(prog) ? prog : join(cwd, prog)
    return runnable(p) ? p : null
  }
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (dir && runnable(join(dir, prog))) return join(dir, prog)
  }
  return null
}

/** Environment for a spawned shell: the app's, minus Electron's own switches, plus a truthful TERM. */
export function shellEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'Beacon'
  if (!env.LANG) env.LANG = 'en_US.UTF-8'
  return env
}

export class TerminalSessions {
  private live = new Map<string, Live>()
  constructor(private readonly opts: TerminalSessionsOptions) {}

  open(req: TerminalOpenRequest): TerminalSession | TerminalOpenError {
    const command = req.command && req.command.length > 0 ? req.command : [this.opts.shell, ...(this.opts.shellArgs ?? [])]
    const cols = clampDim(req.cols, 80)
    const rows = clampDim(req.rows, 24)
    const env = shellEnv(this.opts.env)
    if (!resolveProgram(command[0], env.PATH, this.opts.home)) {
      return { error: `${command[0]} is not installed or not on PATH` }
    }
    let proc: pty.IPty
    try {
      proc = pty.spawn(command[0], command.slice(1), {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: this.opts.home,
        env: env as Record<string, string>
      })
    } catch (e) {
      return { error: `could not start ${command[0]}: ${e instanceof Error ? e.message : String(e)}` }
    }
    const session: TerminalSession = {
      id: mkId(),
      pid: proc.pid,
      title: req.title || defaultTitle(command),
      shell: command[0],
      cwd: this.opts.home,
      cols,
      rows,
      createdAt: Date.now(),
      exit: null,
      command: [...command]
    }
    const entry: Live = { session, proc, scrollback: new ScrollbackBuffer(this.opts.scrollbackLimit ?? SCROLLBACK_LIMIT), sinks: new Set() }
    this.live.set(session.id, entry)
    proc.onData((chunk) => {
      entry.scrollback.push(chunk)
      for (const s of entry.sinks) s.data(session.id, chunk)
    })
    proc.onExit(({ exitCode, signal }) => {
      const exit: TerminalExit = { exitCode, signal: signal || undefined, at: Date.now() }
      entry.session.exit = exit
      entry.proc = null
      for (const s of entry.sinks) s.exit(session.id, exit)
    })
    return { ...session }
  }

  /** Subscribe a sink and get the full replay. Resizes to the attaching surface's geometry. */
  attach(id: string, sink: TerminalSink, cols?: number, rows?: number): TerminalAttachResult | null {
    const e = this.live.get(id)
    if (!e) return null
    e.sinks.add(sink)
    if (cols && rows) this.resize(id, cols, rows)
    return { session: { ...e.session }, replay: e.scrollback.snapshot() }
  }

  detach(id: string, sink: TerminalSink): void {
    this.live.get(id)?.sinks.delete(sink)
  }

  /** Drop a sink from every session (a window went away). */
  detachAll(sink: TerminalSink): void {
    for (const e of this.live.values()) e.sinks.delete(sink)
  }

  /** THE input path. Returns false when the session is gone or has exited. */
  write(id: string, data: string): boolean {
    const e = this.live.get(id)
    if (!e?.proc) return false
    e.proc.write(data)
    return true
  }

  resize(id: string, cols: number, rows: number): boolean {
    const e = this.live.get(id)
    if (!e?.proc) return false
    const c = clampDim(cols, e.session.cols)
    const r = clampDim(rows, e.session.rows)
    if (c === e.session.cols && r === e.session.rows) return true
    e.proc.resize(c, r) // SIGWINCH to the foreground job
    e.session.cols = c
    e.session.rows = r
    return true
  }

  rename(id: string, title: string): boolean {
    const e = this.live.get(id)
    if (!e) return false
    const t = title.trim().slice(0, 64)
    if (t) e.session.title = t
    return true
  }

  get(id: string): TerminalSession | null {
    const e = this.live.get(id)
    return e ? { ...e.session } : null
  }

  list(): TerminalSession[] {
    return [...this.live.values()].map((e) => ({ ...e.session }))
  }

  /** Kill (if live) and forget. */
  close(id: string): boolean {
    const e = this.live.get(id)
    if (!e) return false
    this.live.delete(id)
    e.sinks.clear()
    if (e.proc) {
      try { e.proc.kill() } catch { /* already gone */ }
    }
    return true
  }

  /** App quit: kill every live pty. Returns how many were still running. */
  disposeAll(): number {
    let killed = 0
    for (const id of [...this.live.keys()]) {
      if (this.live.get(id)?.proc) killed++
      this.close(id)
    }
    return killed
  }
}

function clampDim(n: unknown, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return Math.max(2, Math.min(1000, Math.floor(n)))
}
