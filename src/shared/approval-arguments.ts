/**
 * The ARGUMENTS an operator is shown when asked to approve a tool call.
 *
 * WHY THIS EXISTS. The approval card named the tool and the reason and nothing
 * else. For `write_file` that survived, because the reason carries the path.
 * For a desktop action it does not: "computer_type_text requires confirmation"
 * says neither what is being typed nor where, and an approval given on that
 * basis is not consent to anything in particular. Ruled daemon-side 2026-09-18
 * and promoted to a prerequisite on 2026-09-19 — FOR `type_text` THE ARGUMENTS
 * ARE THE DECISION.
 *
 * ── BEACON RENDERS. THE DAEMON DECIDES. ──────────────────────────────────────
 *
 * The strings on this wire are ALREADY redacted, truncated and ordered by
 * `permissions/argument_view.py`, which scrubs ONCE at the point of capture
 * through the audit redactor. Beacon therefore does NOT re-scrub, re-truncate,
 * re-order or re-word them. That is the same rule `extents` follows and for the
 * same reason: two surfaces computing one truth is the defect SPRINT-CONSENT
 * existed to remove (Standing-Principles §17).
 *
 * Three consequences that look like omissions and are not:
 *
 *   * NO SECOND TRUNCATION. A long value already ends "… (+391 more chars)" —
 *     the daemon's rule is that a cut never happens silently. Beacon cutting it
 *     again would produce a silent cut, which is the defect, not the fix. The
 *     block is bounded by CSS instead, so it scrolls rather than being hidden.
 *   * THE OVERFLOW ROW IS NEVER HIDDEN OR REWRITTEN. When the whole block overruns
 *     its budget the daemon appends a row keyed "…" whose value reads
 *     "(13 more argument(s) not shown)". It renders like every other row, in the
 *     daemon's words. What `describeArguments` adds is a notice above the block,
 *     because a person who reads the rows first can miss that the list ends early;
 *     it recognises the daemon's marker only in its exact form, so if the daemon
 *     changes it the notice stops, and the row still says what it says.
 *   * NO RE-SORTING. Keys arrive `sorted()`, so for `type_text` the decisive
 *     `text` sits after `app` and `delivery`. That ordering is the daemon's
 *     call; hoisting the "important" one here would be Beacon deciding which
 *     argument matters, which is precisely what it must not do.
 *
 * CAPTURED, not assumed — Prometheus bf4e1fe, run through the real
 * `redact_arguments` on 2026-09-19 (see approval-smoke's fixture note):
 *
 *   type_text   {"app":"firefox","delivery":"background",
 *                "text":"transfer 500 to account 9"}
 *   secret      {"api_key":"***","app":"firefox","text":"hunter2"}
 *   long text   {"text":"Dear Alex, the quick brown fox…… (+391 more chars)"}
 *   multiline   {"text":"line one ⏎ line two ⏎ line three"}
 *   menu        {"app":"Finder","delivery":"background",
 *                "menu_path":"[File, New Folder]"}
 *   plumbing    null   ← element_token / snapshot_id / session are dropped
 */

/** Wire shape: verb-free, every value ALREADY rendered to a string by the daemon. */
export type ApprovalArguments = Record<string, string>

/**
 * The wire's `arguments` as something the card can render, or undefined when
 * there is nothing to show.
 *
 * `null`, `{}` and ABSENT all collapse to undefined, deliberately. The daemon's
 * serializer notes that None "is different from {}, and Beacon may render the
 * difference" — but `redact_arguments` ends `return out or None`, so an empty
 * map CANNOT be produced: every empty outcome is already None. Rendering a
 * distinction the producer cannot emit would be a branch no daemon can reach,
 * and a state nothing can enter is a state nothing can verify.
 *
 * A NON-STRING VALUE IS SHOWN, NEVER DROPPED. The daemon emits strings only, so
 * this is off-contract — but dropping an argument silently is the exact defect
 * this whole path exists to remove, and it would be invisible. JSON.stringify
 * renders 5, true, null, ["a"] and {"k":1} faithfully, so the operator sees
 * whatever really arrived instead of a gap where an argument used to be.
 */
export function coerceArguments(raw: unknown): ApprovalArguments | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  // No prototype, so that an argument NAMED `__proto__` (JSON.parse makes it an ordinary key) is an ordinary entry. On a plain
  // object `out['__proto__'] = 'text'` is silently ignored: the argument would vanish from the card, with nothing to say it did.
  const out: ApprovalArguments = Object.create(null)
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      out[key] = value
      continue
    }
    // JSON cannot carry undefined/functions, but a hand-built object can.
    const rendered = JSON.stringify(value)
    out[key] = rendered === undefined ? String(value) : rendered
  }
  return Object.keys(out).length > 0 ? out : undefined
}


// ── What the card says about what it is NOT showing ─────────────────────────────────────────────────────────────────────────
//
// The arguments are the AGENT's words: a model chose them, possibly steered by something it read. The daemon masks and cuts
// them; it does not make them honest. So the card is written against text that is trying to be misread (the same reasoning as the
// phone's card): a character that cannot be seen is written out; the daemon's own markers are recognised by their exact form and
// nothing else passes for one; and when anything is missing the card says so BEFORE the text. Nothing here masks, cuts or
// re-words a value: only a character that does not draw is changed, and that is shown as what it is.

/** Said above the arguments whenever the daemon cut a value, masked part of one, or left some out. It does not say a secret was
 *  protected: what is missing may be the part that does the thing. */
export const INCOMPLETE_NOTICE =
  'Prometheus cut or hid part of this. You are not seeing the whole call, and what is missing may be the part that matters.'

/** Said above the arguments when a name or a value held a character that does not draw. */
export const INVISIBLES_NOTICE = 'Some of this text had characters that do not show. They are written out here as ⟨U+…⟩.'

// The daemon's own markers (`permissions/argument_view.py`). Read, never written.
/** The key under which the daemon says how many arguments it left out. */
const LEFT_OUT_ROW = '…'
/** What the daemon's redactor writes over what it masks. */
const MASK = '***'
/** "(12 more argument(s) not shown)", exactly. */
const LEFT_OUT_SENTENCE = /^\([0-9]+ more argument\(s\) not shown\)$/
/** " (+1050 more chars)" at the END of a value. The "…" the daemon writes before it is not required: it cuts first and masks second,
 *  and a mask over the end of a cut URL takes the "…" with it ("?q=*** (+189 more chars)"). */
const ENDS_CUT = / \(\+[0-9]+ more chars\)$/

/** Format and control characters, and the line and paragraph separators: the ones that do not draw (direction overrides and
 *  isolates, zero-width spaces and joiners, the byte-order mark, line breaks, NUL). Nothing visible is in this set. */
const INVISIBLE = /[\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/gu

/** The text with every character that does not draw written out as ⟨U+XXXX⟩. */
export function writeOutInvisibles(text: string): string {
  return text.replace(INVISIBLE, (c) => `⟨U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}⟩`)
}

export interface ArgumentLine {
  /** The argument's name, with any character that does not draw written out. */
  key: string
  /** The daemon's text, with any character that does not draw written out, and nothing else changed. */
  value: string
  /** The daemon cut this value short, and says by how much at its end. */
  cut: boolean
  /** The daemon masked part of this value. What is under the mask is not known to be a secret: its redactor matches shapes. */
  masked: boolean
  /** This is the daemon's own "(N more argument(s) not shown)" row. */
  leftOut: boolean
  /** The name or the value held characters that do not draw. */
  invisibles: boolean
}

export interface ArgumentsView {
  /** In the daemon's own order. Every argument is here, including the daemon's own "not shown" row. */
  lines: ArgumentLine[]
  /** The daemon's "left out" sentence is among the lines, in its exact words. */
  leftOut: boolean
  /** The daemon said so itself (`arguments_cut`), where it says. */
  daemonSaysCut: boolean
  /** Is the person NOT seeing the whole call? The daemon says so, or its own markers are in what it sent. */
  incomplete: boolean
  hasInvisibles: boolean
}

/**
 * What the card draws for a request's arguments, or null when there is nothing to show (no arguments, and the daemon does not say
 * it cut any). A request the daemon says it cut (`arguments_cut: true`) shows its notice even with no arguments to list.
 */
export function describeArguments(args: ApprovalArguments | undefined, argumentsCut: boolean | undefined): ArgumentsView | null {
  const entries = Object.entries(args ?? {})
  const daemonSaysCut = argumentsCut === true
  if (entries.length === 0 && !daemonSaysCut) return null
  const lines = entries.map(([rawKey, raw]): ArgumentLine => {
    const key = writeOutInvisibles(rawKey)
    const value = writeOutInvisibles(raw)
    return {
      key,
      value,
      cut: ENDS_CUT.test(raw),
      masked: raw.includes(MASK),
      leftOut: rawKey === LEFT_OUT_ROW && LEFT_OUT_SENTENCE.test(raw),
      invisibles: key !== rawKey || value !== raw
    }
  })
  const leftOut = lines.some((l) => l.leftOut)
  return {
    lines,
    leftOut,
    daemonSaysCut,
    incomplete: daemonSaysCut || leftOut || lines.some((l) => l.cut || l.masked),
    hasInvisibles: lines.some((l) => l.invisibles)
  }
}
