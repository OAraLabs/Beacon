import { useEffect, useRef, type RefObject } from 'react'

// Keyboard focus for a modal dialog: it moves into the dialog when it opens, Tab and Shift-Tab cycle only through the dialog's own
// controls, Esc closes it, and focus goes back where it was when it closes. Before this, Tab walked out of Connection Settings into the
// app behind it, and Esc did nothing.

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

export function useDialogFocus(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const items = (): HTMLElement[] => [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((e) => e.getClientRects().length > 0)
    if (!ref.current?.contains(document.activeElement)) (items()[0] ?? ref.current)?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close.current()
        return
      }
      if (e.key !== 'Tab') return
      e.preventDefault()
      const all = items()
      if (all.length === 0) return
      const at = all.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey ? (at <= 0 ? all.length - 1 : at - 1) : at < 0 || at === all.length - 1 ? 0 : at + 1
      all[next].focus()
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      if (before?.isConnected) before.focus()
    }
  }, [ref])
}
