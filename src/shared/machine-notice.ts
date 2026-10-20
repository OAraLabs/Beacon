// Machine notices that arrive dressed as USER messages.
//
// The daemon injects turn-summary blocks into the transcript with the user role — the file
// mutation verifier is the one you see most:
//
//   [FILE MUTATION VERIFIER]
//   Files touched this turn:
//   ✓ /home/demo/.prometheus/files/notes.md — write_file: created (+6964 bytes)
//
// Rendered as a user bubble that is raw machine syntax sitting in the conversation, attributed to
// a person who never typed it — R13's "never surface machine syntax raw", and a lie about who
// said what. It is a TOOL RESULT, so it renders as one: a compact row per file, the detail behind
// the row. Pure (no React) so the renderer and a smoke share one parser.

export interface MachineNoticeFile {
  ok: boolean
  path: string
  /** `write_file: created`, `edit_file: modified`, … — whatever the daemon named the operation. */
  op: string
  /** `+6964 bytes` — kept verbatim; this parser never recomputes a number it was handed. */
  delta: string
}

export interface MachineNotice {
  kind: 'file-mutation'
  files: MachineNoticeFile[]
  /** The original block, for the row's title and the inspector. Never thrown away. */
  raw: string
}

const HEADER = /^\s*\[FILE MUTATION VERIFIER\]/i

/** True when this message text is a daemon-injected notice rather than something a person typed. */
export function isMachineNotice(text: string): boolean {
  return HEADER.test(text ?? '')
}

/**
 * Parse the block. Unrecognised lines are IGNORED rather than guessed at: a notice whose shape the
 * daemon changes should degrade to "0 files" and keep its raw text, not invent rows. The caller
 * shows `raw` either way, so nothing is ever lost by a parse that comes up short.
 */
export function parseMachineNotice(text: string): MachineNotice | null {
  if (!isMachineNotice(text)) return null
  const files: MachineNoticeFile[] = []
  for (const line of (text ?? '').split('\n')) {
    const m = line.match(/^\s*([✓✗x×])\s+(\S+)\s+[—-]\s+([^(]+?)\s*(\([^)]*\))?\s*$/u)
    if (!m) continue
    files.push({ ok: m[1] === '✓', path: m[2], op: m[3].trim(), delta: (m[4] ?? '').replace(/[()]/g, '') })
  }
  return { kind: 'file-mutation', files, raw: text }
}

/** `notes.md` from a full path — the row leads with the name and keeps the path in its title. */
export function fileName(path: string): string {
  const tail = path.split('/').filter(Boolean).pop()
  return tail && tail.length ? tail : path
}
