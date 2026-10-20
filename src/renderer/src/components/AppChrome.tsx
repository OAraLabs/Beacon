import { Icon } from './Icon'

// The window's own bar (design handoff, screen 1 chrome): 38px, ink-dark, the traffic lights
// sitting INSIDE it, `Beacon` centred in the display face in brass, and ⌘K on the right.
//
// Before this the window used the platform title bar, which on macOS is a light strip above a
// dark app — the one piece of the window that did not belong to the product. `titleBarStyle:
// 'hiddenInset'` (main/index.ts) keeps the traffic lights and hands us the strip; the 68px of
// left padding is the room they need, and the whole bar is a drag region except the controls.
// `palette={false}` drops the ⌘K button for screens that have no palette to open (first run).
export function AppChrome({ palette = true }: { palette?: boolean } = {}): React.JSX.Element {
  // The palette lives in MainView, behind the same ⌘K the keyboard uses. Re-dispatching the
  // chord keeps one owner for that state instead of threading a callback through the tree.
  const openPalette = (): void => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true })
    )
  }
  return (
    <div className="app-chrome">
      <div className="app-chrome-brand">Beacon</div>
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
