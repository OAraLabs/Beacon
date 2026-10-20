import { useEffect, type RefObject } from 'react'

// The browser's web contents are a native WebContentsView owned by main; the renderer draws chrome
// around a HOLE and tells main where the hole is. This hook reports the placeholder's rect (CSS px —
// main scales by the shell's zoom factor) whenever it moves, resizes, or gets covered.
//
// Covered: a native view paints OVER every DOM element, so a modal (palette, search, settings) would
// otherwise appear underneath the page. Rather than teach every overlay about the browser, the hook
// asks the DOM what is at the hole's centre; if it is not the hole, the view is hidden until it is.

export function useViewBounds(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const b = window.beacon
    const el = ref.current
    if (!b || !el || !enabled) {
      b?.browser.bounds(null)
      return
    }
    let raf = 0
    let last = ''
    const report = (): void => {
      raf = 0
      const r = el.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const top = document.elementFromPoint(cx, cy)
      const covered = !top || (top !== el && !el.contains(top))
      const rect = r.width < 8 || r.height < 8 || covered || document.hidden ? null : { x: r.left, y: r.top, width: r.width, height: r.height }
      const key = JSON.stringify(rect)
      if (key === last) return
      last = key
      b.browser.bounds(rect)
    }
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(report)
    }
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    // Overlays mount as siblings/ancestors somewhere under #root; any structural change is a reason
    // to re-check what is on top. rAF-coalesced, so a streaming reply costs one check per frame at most.
    const mo = new MutationObserver(schedule)
    mo.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', schedule)
    document.addEventListener('scroll', schedule, true)
    document.addEventListener('visibilitychange', schedule)
    schedule()
    return () => {
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', schedule)
      document.removeEventListener('scroll', schedule, true)
      document.removeEventListener('visibilitychange', schedule)
      if (raf) cancelAnimationFrame(raf)
      b.browser.bounds(null)
    }
  }, [ref, enabled])
}
