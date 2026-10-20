import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { byGroup, capGroups, GROUP_CHIP, rankCommands, searchRowLabel, shouldOfferSearch, type PaletteEntry } from '@shared/commands'
import { Icon } from './Icon'

// Command palette (Makeover Slice 5) — ⌘K/Ctrl+K. Views, sessions, and actions in one ranked
// list; ↑/↓ + Enter to run, Esc to dismiss. Glass scrim per the design language (overlays only).

export interface PaletteCommand extends PaletteEntry {
  run: () => void
}

// Caps-and-mono group labels, per the match spec. The row no longer carries a per-group ICON:
// a glyph and a mono KIND CHIP saying the same thing twice is the redundancy the spec's row
// anatomy removes, and the chip is the one that survives at 9.5px.
const GROUP_LABEL: Record<PaletteEntry['group'], string> = {
  view: 'VIEWS',
  session: 'SESSIONS',
  action: 'ACTIONS',
  file: 'FILES'
}

const scrim: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 'var(--z-palette)' as unknown as number,
  background: 'var(--c-scrim)',
  backdropFilter: 'blur(8px)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  paddingTop: 96
}
const panel: CSSProperties = {
  width: 'min(520px, 92vw)',
  maxHeight: '58vh',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--c-raise)',
  border: '1px solid var(--c-line-bright)',
  borderRadius: 'var(--r-4)',
  boxShadow: 'var(--elev-3)',
  overflow: 'hidden'
}
const inputRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '12px 14px',
  borderBottom: '1px solid var(--line3)'
}
const inputStyle: CSSProperties = {
  flex: 1,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  color: 'var(--ink2)',
  // The CARET is the accent, not the text: a 1.5px sang bar says "type here" without spending
  // the region's one accent on a whole line of query text (R6).
  caretColor: 'var(--sang)',
  font: 'inherit',
  fontSize: 14
}
const list: CSSProperties = { overflowY: 'auto', padding: 6 }
const groupHead: CSSProperties = {
  padding: '0 14px 4px',
  marginTop: 8,
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  letterSpacing: '0.16em',
  color: 'var(--ink4)'
}
/** The KIND chip — mono, so `SESS` reads as a label rather than a truncated word. */
const kindChip: CSSProperties = {
  flex: 'none',
  padding: '1px 5px',
  borderRadius: 4,
  background: 'var(--line3)',
  color: 'var(--ink3)',
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  lineHeight: 1.5
}
const rowLabel: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}
const rowHint: CSSProperties = {
  flex: 'none',
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  color: 'var(--ink4)'
}
const row = (active: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  padding: '7px 14px',
  borderRadius: 'var(--r-1)',
  border: 'none',
  background: active ? 'var(--sang-soft)' : 'transparent',
  color: active ? 'var(--sang-text)' : 'var(--ink5)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 12.5,
  textAlign: 'left'
})

export function CommandPalette({
  commands,
  onClose,
  onSearch
}: {
  commands: PaletteCommand[]
  onClose: () => void
  /** Hand off to conversation search (⌘⇧F) carrying the typed query. Absent → row is not offered. */
  onSearch?: (query: string) => void
}) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Rank, then regroup so each group's header appears once, then cap each group at five. The cap
  // is what keeps this a palette rather than a scrolling list of 182 sessions — see capGroups.
  const ranked = useMemo(() => capGroups(byGroup(rankCommands(commands, query))), [commands, query])
  // Pinned LAST, deliberately: a row at the top would take Enter away from the best-ranked command
  // and change what a keystroke people already have in their fingers does. Fixed position either
  // way — it never reorders on what the query happens to match.
  const searchRow = onSearch && shouldOfferSearch(query) ? searchRowLabel(query) : null
  const rowCount = ranked.length + (searchRow ? 1 : 0)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  useEffect(() => {
    setCursor(0)
  }, [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const run = (cmd: PaletteCommand | undefined): void => {
    if (!cmd) return
    onClose()
    cmd.run()
  }

  /** Activate whatever the cursor is on — the pinned row lives one past the ranked commands. */
  const activate = (i: number): void => {
    if (searchRow && i === ranked.length) {
      onSearch?.(query.trim())
      return
    }
    run(ranked[i])
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, rowCount - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activate(cursor)
    }
  }

  // Group headers appear at each group's first ranked row (ranking can interleave groups).
  let lastGroup: PaletteEntry['group'] | null = null

  return (
    <div style={scrim} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div style={inputRow}>
          <span style={{ color: 'var(--c-arc)', display: 'inline-flex' }} aria-hidden>
            <Icon name="search" size={15} />
          </span>
          <input
            ref={inputRef}
            style={inputStyle}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Go to view, open session, run action…"
            spellCheck={false}
            aria-label="Search commands"
          />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--ink4)' }}>esc</span>
        </div>
        <div style={list} ref={listRef}>
          {rowCount === 0 ? (
            <div style={{ padding: '18px 12px', color: 'var(--c-text-dim)', fontSize: 13, textAlign: 'center' }}>
              No matches
            </div>
          ) : (
            ranked.map((cmd, i) => {
              const head = cmd.group !== lastGroup ? <div style={groupHead}>{GROUP_LABEL[cmd.group]}</div> : null
              lastGroup = cmd.group
              return (
                <div key={cmd.id}>
                  {head}
                  <button
                    style={row(i === cursor)}
                    data-idx={i}
                    onClick={() => run(cmd)}
                    onMouseEnter={() => setCursor(i)}
                  >
                    <span style={kindChip} aria-hidden>{GROUP_CHIP[cmd.group]}</span>
                    <span style={rowLabel}>{cmd.label}</span>
                    {cmd.hint ? <span style={rowHint}>{cmd.hint}</span> : null}
                  </button>
                </div>
              )
            })
          )}
          {searchRow ? (
            <div>
              <div style={groupHead}>CONVERSATIONS</div>
              <button
                style={row(cursor === ranked.length)}
                data-idx={ranked.length}
                onClick={() => activate(ranked.length)}
                onMouseEnter={() => setCursor(ranked.length)}
              >
                <span style={kindChip} aria-hidden>FIND</span>
                <span style={rowLabel}>{searchRow}</span>
                <span style={rowHint}>⌘⇧F</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
