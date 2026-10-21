// Machine notices that arrive dressed as USER messages.
//
// The daemon injects turn-summary blocks into the transcript with the user role — the file
// mutation verifier is the one you see most:
//
//   [FILE MUTATION VERIFIER]
//   Files touched this turn:
//      ✓ /home/demo/.prometheus/files/notes.md — write_file: created (+6964 bytes)
//
// Rendered as a user bubble that is raw machine syntax sitting in the conversation, attributed to
// a person who never typed it — R13's "never surface machine syntax raw", and a lie about who
// said what. It is a TOOL RESULT, so it renders as one: a compact row per file, the detail behind
// the row. Pure (no React) so the renderer and a smoke share one parser.
//
// THE SHAPES, from Prometheus `hooks/file_mutation_verifier.py` (`_format_summary`, `_tag`,
// `_blindness_lines`; unchanged since Prometheus PR 506, 2026-09-19). Three-space indented rows:
//
//   ✓ <path> — <action>: <tag>[ (<n> bytes)][ — <error>]   badge ✓ ok, ⚠ claimed-but-nothing, ✗ error
//   ... and <n> more (truncated at <limit>)
//   ? no nameable target — <command>[ (×<n>)]
//   ? UNAUDITED, could not parse this command — <command>[ (×<n>)]
//   (this turn may have written files this hook could not see)
//
// The `?` rows are the daemon saying the audit FAILED: a command it could not lex, or a write whose
// target it could not name. They come after every file row, every `no nameable target` row before
// the first `UNAUDITED` row, and <command> is the bash command verbatim (cut at 200 chars), so it
// can span lines. With no file rows the second line is "Nothing trackable this turn, but NOT a
// clean audit:" and the trailer closes the block. Before this parser read them, that block came out
// as zero files and a card that looked like a clean, empty audit.

export type MachineNoticeFileStatus =
  /** ✓ — the disk agrees with what the tool claimed. */
  | 'ok'
  /** ⚠ — the tool claimed a write and the disk shows none (NO CHANGE ON DISK, FILE ABSENT). */
  | 'unconfirmed'
  /** ✗ — the tool itself reported failure. */
  | 'failed'

export interface MachineNoticeFile {
  status: MachineNoticeFileStatus
  path: string
  /** `write_file: created`, `edit_file: CLAIMED but NO CHANGE ON DISK`, … — the daemon's words. */
  op: string
  /** `+6964 bytes` — kept verbatim; this parser never recomputes a number it was handed. */
  delta: string
  /** The tool's error text on a ✗ row, verbatim; empty otherwise. */
  error: string
}

export interface MachineNoticeUnaudited {
  /** `unparsed`: the daemon could not lex the command. `no-target`: it could not name what was written. */
  reason: 'unparsed' | 'no-target'
  /** The command verbatim, every line of it. */
  command: string
  /** The daemon folds repeats into one row with `(×n)`. */
  count: number
}

export interface MachineNotice {
  kind: 'file-mutation'
  /**
   * `clean` — every line parsed and the daemon reported nothing it could not audit.
   * `not-audited` — the daemon said part or all of the turn went unaudited.
   * `unrecognised` — some line did not parse (`unread`): a shape this parser does not know. It
   *   may be the line that says the audit failed, so it must not render as clean, nor as an empty
   *   clean list when nothing parsed at all.
   */
  audit: 'clean' | 'not-audited' | 'unrecognised'
  files: MachineNoticeFile[]
  unaudited: MachineNoticeUnaudited[]
  /** Files the daemon left out of the list (`... and n more`); 0 when the list is complete. */
  more: number
  /** Non-blank lines this parser did not recognise. Any at all and the notice is not `clean`. */
  unread: number
  /** The original block, for the row's title and the inspector. Never thrown away. */
  raw: string
}

const HEADER = /^\s*\[FILE MUTATION VERIFIER\]/i

/** True when this message text is a daemon-injected notice rather than something a person typed. */
export function isMachineNotice(text: string): boolean {
  return HEADER.test(text ?? '')
}

const FILE_ROW = /^\s*([✓⚠✗])\s+(.+?)\s+—\s+(.+?)(?:\s+\(([+-]?\d+ bytes)\))?(?:\s+—\s+(.*?))?\s*$/u
const MORE_ROW = /^\s*\.\.\. and (\d+) more \(truncated at \d+\)\s*$/
const NO_TARGET = /^\s*\? no nameable target — (.*)$/u
const UNPARSED = /^\s*\? UNAUDITED, could not parse this command — (.*)$/u
const FILES_HEAD = /^\s*Files touched this turn:\s*$/
const NOT_CLEAN = /^\s*Nothing trackable this turn, but NOT a clean audit:\s*$/
const TRAILER = /^\s*\(this turn may have written files this hook could not see\)\s*$/
const COUNT = /\s\(×(\d+)\)$/u

const STATUS: Record<string, MachineNoticeFileStatus> = { '✓': 'ok', '⚠': 'unconfirmed', '✗': 'failed' }

/**
 * Parse the block. A line this parser does not recognise is counted, not guessed at, and any such
 * line makes the notice `unrecognised` rather than `clean`: the caller shows `raw` either way, so
 * nothing is ever lost by a parse that comes up short.
 */
export function parseMachineNotice(text: string): MachineNotice | null {
  if (!isMachineNotice(text)) return null
  const lines = (text ?? '').split('\n')
  const files: MachineNoticeFile[] = []
  const unaudited: MachineNoticeUnaudited[] = []
  let more = 0
  let unread = 0
  let notClean = false
  // The `?` rows are the tail of the block, so once one opens nothing after it is a file row: a
  // line inside a multi-line command that LOOKS like `✓ /x — …` is command text, not a file.
  let open = null as { reason: MachineNoticeUnaudited['reason']; lines: string[] } | null
  const close = (): void => {
    if (!open) return
    let command = open.lines.join('\n')
    let count = 1
    const c = command.match(COUNT)
    if (c && c.index !== undefined) {
      count = Number(c[1])
      command = command.slice(0, c.index)
    }
    unaudited.push({ reason: open.reason, command, count })
    open = null
  }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    // Every `no nameable target` row is written before the first UNAUDITED row, so inside an
    // UNAUDITED command a line that reads like one is command text, not a new row.
    const noTarget: RegExpMatchArray | null = open?.reason === 'unparsed' ? null : line.match(NO_TARGET)
    const unparsed: RegExpMatchArray | null = noTarget ? null : line.match(UNPARSED)
    if (noTarget || unparsed) {
      close()
      open = { reason: noTarget ? 'no-target' : 'unparsed', lines: [(noTarget ?? unparsed)![1]] }
      continue
    }
    if (open) {
      // The trailer is only ever the LAST line of a not-clean block, so anywhere else it is text.
      if (notClean && i === lines.length - 1 && TRAILER.test(line)) close()
      else open.lines.push(line)
      continue
    }
    if (NOT_CLEAN.test(line)) {
      notClean = true
      continue
    }
    const truncated = line.match(MORE_ROW)
    if (truncated) {
      more = Number(truncated[1])
      continue
    }
    const m = line.match(FILE_ROW)
    if (!m) {
      if (line.trim() && !FILES_HEAD.test(line)) unread++
      continue
    }
    files.push({ status: STATUS[m[1]], path: m[2], op: m[3].trim(), delta: m[4] ?? '', error: m[5] ?? '' })
  }
  close()
  const audit = notClean || unaudited.length ? 'not-audited' : files.length && !unread ? 'clean' : 'unrecognised'
  return { kind: 'file-mutation', audit, files, unaudited, more, unread, raw: text }
}

/** `notes.md` from a full path — the row leads with the name and keeps the path in its title. */
export function fileName(path: string): string {
  const tail = path.split('/').filter(Boolean).pop()
  return tail && tail.length ? tail : path
}

/** The first line of a command, for a one-line row; the whole command stays behind the row. */
export function commandHead(command: string): string {
  const nl = command.indexOf('\n')
  return nl < 0 ? command : `${command.slice(0, nl)} …`
}

/**
 * The card's caption. It names what the daemon said, not what the rows add up to: a block with no
 * file rows is NOT "files touched" with an empty list when the daemon said the audit failed.
 */
export function noticeCaption(n: MachineNotice): string {
  if (n.audit === 'not-audited') return n.files.length ? 'files touched · not fully audited' : 'not audited'
  if (n.audit === 'unrecognised') return n.files.length ? 'files touched · partly unreadable' : 'file audit · unreadable'
  return 'files touched'
}

/** The row label for a `?` row, in Beacon's words; the daemon's own wording stays in `raw`. */
export function unauditedLabel(u: MachineNoticeUnaudited): string {
  return u.reason === 'unparsed' ? 'could not parse' : 'no nameable target'
}
