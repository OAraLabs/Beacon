// Terminal pane — the pure model (no Electron, no node-pty, no React). Shared by the main-process
// session manager, the renderer pane, and the headless smoke.
//
// THE INVARIANT (claude/BEACON-TERMINAL-SCOPE.md): this terminal is a HUMAN surface. It runs on the
// Mac, outside the daemon, outside the security gate, with no audit log — exactly like Terminal.app.
// The agent must never be able to write into it: its shell is the daemon's `bash` tool (gated,
// audited, workspace-floored, write-verified). Anything that routed model output into this pty would
// be an invisible gate bypass, because it would not look like a tool call. terminal-smoke asserts the
// ABSENCE of any such wiring — on the source, not on a comment.
//
// Beacon stores ZERO secrets for this feature. No passwords, no keys.

export interface TerminalOpenRequest {
  cols: number
  rows: number
  /** Phase 4: `['ssh', host]`. Absent → the user's login shell. */
  command?: string[]
  /** Tab label; defaults to the shell's basename (or the command's). */
  title?: string
}

export interface TerminalExit {
  exitCode: number
  signal?: number
  at: number // epoch ms
}

/** What the renderer is allowed to know about a live pty. Never carries env or the pty handle. */
export interface TerminalSession {
  id: string
  pid: number
  title: string
  shell: string // the program actually spawned (argv[0])
  cwd: string
  cols: number
  rows: number
  createdAt: number
  exit: TerminalExit | null // non-null once the process has ended; the pane shows why
  /** The argv this session was opened with (so an exited tab can be started again as-is). */
  command: string[]
}

/** Why a session could not be opened — returned, never thrown across IPC, so the pane shows it. */
export interface TerminalOpenError {
  error: string
}
export const isTerminalOpenError = (r: unknown): r is TerminalOpenError =>
  typeof r === 'object' && r !== null && typeof (r as TerminalOpenError).error === 'string'

export interface TerminalAttachResult {
  session: TerminalSession
  /** Everything the pty has emitted (bounded by SCROLLBACK_LIMIT) — replayed into a fresh xterm so a
   *  window reload / detach / re-open shows the same screen and history. */
  replay: string
}

/** Where the pane lives. `cause` lets the main window's pane react (pop-in → show the view). */
export interface TerminalPlacement {
  poppedOut: boolean
  cause: 'query' | 'pop-out' | 'pop-in' | 'closed'
}

/** Bytes of pty output kept in main per session. 2 MiB ≈ thousands of screens; replay is a one-shot
 *  string over IPC, so this is also the largest single attach payload. */
export const SCROLLBACK_LIMIT = 2 * 1024 * 1024

/** Largest single write the renderer may push (a paste). Anything bigger is refused, not truncated. */
export const MAX_WRITE_CHARS = 1024 * 1024

/**
 * Bounded FIFO of output chunks. Eviction is whole-chunk from the front so the kept tail never starts
 * mid-escape-sequence relative to what node-pty delivered (a chunk boundary is a delivery boundary).
 */
export class ScrollbackBuffer {
  private chunks: string[] = []
  private total = 0
  constructor(readonly limit: number = SCROLLBACK_LIMIT) {}

  push(chunk: string): void {
    if (!chunk) return
    // A single chunk larger than the whole limit keeps only its tail.
    if (chunk.length > this.limit) chunk = chunk.slice(chunk.length - this.limit)
    this.chunks.push(chunk)
    this.total += chunk.length
    while (this.total > this.limit && this.chunks.length > 1) {
      this.total -= this.chunks.shift()!.length
    }
  }

  snapshot(): string {
    return this.chunks.join('')
  }

  get size(): number {
    return this.total
  }
}

/** One human line for an ended session — shown IN the pane, never a silent close. */
export function describeExit(exit: TerminalExit, program: string): string {
  const name = program.split('/').pop() || program
  if (exit.signal) return `${name} was killed by signal ${exit.signal}`
  if (exit.exitCode === 0) return `${name} exited`
  return `${name} exited with code ${exit.exitCode}`
}

/** xterm theme keys → the theme token each one reads. No new palette: every colour the pane paints is
 *  one the rest of the app already paints. ANSI colours not listed keep xterm's own defaults. */
export const TERMINAL_TOKEN_MAP: Readonly<Record<string, string>> = {
  background: '--c-base',
  foreground: '--ink',
  cursor: '--c-arc',
  cursorAccent: '--c-base',
  selectionBackground: '--c-arc-soft',
  selectionInactiveBackground: '--c-arc-soft',
  red: '--c-err',
  green: '--c-ok',
  yellow: '--c-warn',
  blue: '--lapis',
  magenta: '--sang',
  brightRed: '--c-err',
  brightGreen: '--c-ok',
  brightYellow: '--c-warn',
  brightBlue: '--lapis',
  brightMagenta: '--sang',
  brightBlack: '--ink4',
  white: '--ink2',
  brightWhite: '--ink'
}

/** Build the xterm theme from the LIVE token values (getComputedStyle at call time). Tokens that
 *  resolve empty are omitted so xterm falls back to its default rather than painting "". */
export function xtermThemeFromTokens(readVar: (name: string) => string): Record<string, string> {
  const theme: Record<string, string> = {}
  for (const [key, token] of Object.entries(TERMINAL_TOKEN_MAP)) {
    const v = readVar(token).trim()
    if (v) theme[key] = v
  }
  return theme
}

/** Basename for a tab label. */
export function defaultTitle(command: string[]): string {
  const prog = command[0] ?? 'shell'
  const base = prog.split('/').pop() || prog
  // `ssh [-o k=v …] host` — the host is the last argv element (options come first).
  const last = command[command.length - 1]
  if (base === 'ssh' && command.length > 1 && last && !last.startsWith('-')) return `ssh ${last}`
  return base
}
