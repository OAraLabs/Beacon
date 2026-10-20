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
 *   * NO SPECIAL-CASING OF THE OVERFLOW ROW. When the whole block overruns its
 *     budget the daemon appends a row keyed "…" whose value reads
 *     "(13 more argument(s) not shown)". That row says what it means IN WORDS;
 *     styling it would make Beacon hardcode the daemon's marker, and a marker
 *     that changed would stop matching silently. Every row renders alike.
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
  const out: ApprovalArguments = {}
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
