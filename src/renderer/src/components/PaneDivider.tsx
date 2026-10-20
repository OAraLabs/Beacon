import { useEffect, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { moveBoundary } from '@shared/split-panes'

// The line between two split panes (@shared/split-panes). Same contract as the dock's divider and the
// sessions list's: drag (pointer capture), ←/→ on focus (Shift for bigger steps), Home or a
// double-click to make every pane equal again.
//
// DURING A DRAG ONLY THE TWO PANES MOVE, AND REACT DOES NOT RE-RENDER. Each move writes flex-grow onto
// the two neighbouring pane elements directly; the layout (and so every ChatShell's render) changes once,
// on release. A conversation hundreds of messages long would otherwise re-render on every pointer move.

/** The rendered widths of the panes, left to right (CSS px). */
function paneWidths(container: HTMLElement): number[] {
  return [...container.querySelectorAll<HTMLElement>(':scope > .pane')].map((el) => el.getBoundingClientRect().width)
}

function applyWidths(container: HTMLElement, widths: number[]): void {
  const els = [...container.querySelectorAll<HTMLElement>(':scope > .pane')]
  widths.forEach((w, i) => {
    if (els[i]) els[i].style.flexGrow = String(w)
  })
}

export function PaneDivider({
  index,
  container,
  onCommit,
  onReset
}: {
  /** The boundary between pane `index` and pane `index + 1`. */
  index: number
  container: RefObject<HTMLDivElement | null>
  onCommit: (widths: number[]) => void
  onReset: () => void
}) {
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    if (!dragging) return
    document.body.classList.add('is-resizing-panel')
    return () => document.body.classList.remove('is-resizing-panel')
  }, [dragging])

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    const box = container.current
    if (e.button !== 0 || !box) return
    e.preventDefault()
    const div = e.currentTarget
    const startX = e.clientX
    const start = paneWidths(box)
    let latest = start
    setDragging(true)
    try {
      div.setPointerCapture(e.pointerId)
    } catch {
      /* a synthetic pointer (a probe) has no capture; the listeners below still work */
    }
    const move = (ev: globalThis.PointerEvent): void => {
      latest = moveBoundary(start, index, ev.clientX - startX)
      applyWidths(box, latest)
    }
    const up = (ev: globalThis.PointerEvent): void => {
      div.removeEventListener('pointermove', move)
      div.removeEventListener('pointerup', up)
      div.removeEventListener('pointercancel', up)
      try {
        div.releasePointerCapture(ev.pointerId)
      } catch {
        /* already released */
      }
      setDragging(false)
      onCommit(latest)
    }
    div.addEventListener('pointermove', move)
    div.addEventListener('pointerup', up)
    div.addEventListener('pointercancel', up)
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const box = container.current
    if (!box) return
    const step = e.shiftKey ? 64 : 16
    if (e.key === 'ArrowRight') onCommit(moveBoundary(paneWidths(box), index, step))
    else if (e.key === 'ArrowLeft') onCommit(moveBoundary(paneWidths(box), index, -step))
    else if (e.key === 'Home') onReset()
    else return
    e.preventDefault()
  }

  return (
    <>
      <div
        className={`pane-divider${dragging ? ' is-dragging' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize panes ${index + 1} and ${index + 2}`}
        title="Drag to resize · double-click to make the panes equal"
        tabIndex={0}
        data-boundary={index}
        onPointerDown={onPointerDown}
        onDoubleClick={onReset}
        onKeyDown={onKey}
      />
      {/* The browser pane is a separate native surface that would swallow the pointer mid-drag. */}
      {dragging ? <div className="side-panel-drag-shield" aria-hidden /> : null}
    </>
  )
}
