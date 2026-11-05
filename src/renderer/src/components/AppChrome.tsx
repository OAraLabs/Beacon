import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from './Icon'
import { InstanceRowButtons } from './InstanceList'
import { useInstances } from '../instances-store'
import { switcherKey, switcherRows, titleSwitches, windowTitle } from '@shared/instance-rows'

// The window's own bar (design handoff, screen 1 chrome): 38px, ink-dark, the traffic lights
// sitting INSIDE it, `Beacon` centred in the display face in brass, and ⌘K on the right.
//
// Before this the window used the platform title bar, which on macOS is a light strip above a
// dark app — the one piece of the window that did not belong to the product. `titleBarStyle:
// 'hiddenInset'` (main/index.ts) keeps the traffic lights and hands us the strip; the 68px of
// left padding is the room they need, and the whole bar is a drag region except the controls.
// `palette={false}` drops the ⌘K button for screens that have no palette to open (first run). With two or more Prometheus it says
// which one Beacon is on, as the window title does ("Home mini — Beacon", docs/MULTI-PROMETHEUS.md §5), and the name is a button
// that opens the switcher from any view (TitleSwitcher).
export function AppChrome({ palette = true }: { palette?: boolean } = {}): React.JSX.Element {
  // The palette lives in MainView, behind the same ⌘K the keyboard uses. Re-dispatching the
  // chord keeps one owner for that state instead of threading a callback through the tree.
  const instances = useInstances()
  const openPalette = (): void => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true })
    )
  }
  return (
    <div className="app-chrome">
      {titleSwitches(instances) ? (
        <TitleSwitcher title={windowTitle(instances)} />
      ) : (
        <div className="app-chrome-brand" data-testid="app-chrome-brand">
          {windowTitle(instances)}
        </div>
      )}
      {palette ? (
        <button
          className="app-chrome-cmdk"
          onClick={openPalette}
          title="Search sessions, files and actions (⌘K)"
          aria-label="Open the command palette"
        >
          <Icon name="search" size={10} />
          <span>⌘K</span>
        </button>
      ) : null}
    </div>
  )
}

/** The name in the title bar, from one Prometheus on ("Beacon" with one, "Home mini — Beacon" with two or more): opens the same rows as the sidebar's list, from any view. Keyboard: Enter or
 *  Space opens it with focus on the one Beacon is on; the arrows, Home and End move; Enter switches; Escape or Tab closes it and gives
 *  focus back to the name. A click outside closes it too. */
function TitleSwitcher({ title }: { title: string }): React.JSX.Element {
  const rows = switcherRows(useInstances())
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const items = (): HTMLButtonElement[] => [...(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  const close = (refocus: boolean): void => {
    setOpen(false)
    if (refocus) button.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    const all = items()
    ;(all.find((b) => b.getAttribute('aria-current') === 'true') ?? all[0])?.focus()
    const outside = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!menu.current?.contains(t) && !button.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const all = items()
    const next = switcherKey(e.key, all.indexOf(document.activeElement as HTMLButtonElement), all.length)
    if (next === null) return
    e.preventDefault()
    e.stopPropagation()
    if (next === 'close') close(true)
    else all[next.focus]?.focus()
  }

  return (
    <div className="app-chrome-brand">
      <button
        ref={button}
        className="app-chrome-switch"
        aria-haspopup="menu"
        aria-expanded={open ? 'true' : 'false'}
        onClick={() => setOpen((o) => !o)}
        title="Switch to another Prometheus"
        data-testid="app-chrome-brand"
      >
        {title}
        <Icon name="chevron-down" size={11} />
      </button>
      {open && rows ? (
        <div ref={menu} className="app-chrome-switcher" role="menu" aria-label="Your Prometheus" onKeyDown={onKey} data-testid="title-switcher">
          <InstanceRowButtons rows={rows} menu onDone={() => close(true)} />
        </div>
      ) : null}
    </div>
  )
}
