import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'

// The app's one recovery surface.
//
// BEFORE THIS there was no ErrorBoundary anywhere in src/renderer (verified: zero hits across the
// tree), so any exception thrown during render, in a lifecycle method, or in a constructor of ANY of
// the ~65 components unmounted the entire React tree and left a blank window. No message, no reload
// affordance, and the tray still reported the connection as alive — the app looked running and was
// not. A renderer-process crash had the same ending, since the main window registers no
// `render-process-gone` handler (the browser pane's WebContentsView does; the shell does not).
//
// WHY THIS MATTERS MORE THAN "one bad frame". React's own contract is that an uncaught error in the
// tree is fatal to the tree — this is not a defensive nicety, it is the difference between losing a
// panel and losing the window. Panels here are new and moving: Board, Checkpoints, the Progress pane
// and the plan checklist all landed within the last month, each rendering shapes the daemon decides.
// A frame the renderer does not expect is the ordinary case, not a hypothetical.
//
// SCOPE, deliberately: this is the RENDERER half. The main-process half — reloading the window on
// `render-process-gone`, and reporting it through the watchdog log that already exists — belongs in
// src/main/index.ts and is not in this change.
//
// A class component because there is no hook equivalent: componentDidCatch/getDerivedStateFromError
// are the only API React exposes for catching a child's render error. That is not a style choice.

/** What the boundary shows. Kept tiny on purpose — it has to render when the rest of the app could not. */
interface BoundaryState {
  error: Error | null
}

/**
 * A boundary around one surface.
 *
 * WHERE ITS FALLBACK GOES is the whole design, and it is decided by `scope`:
 *
 *   'panel' (the DEFAULT): the fallback takes the broken subtree's place IN THE LAYOUT. Whatever sits
 *   beside it — the rail, the pill row, the session list, the dock — stays on screen and clickable,
 *   and that is the way out.
 *
 *   'window': the fallback covers the window. Only the root may use it, because only at the root is
 *   there nothing left beside it to keep reachable.
 *
 * The default is the safe one on purpose. The first cut of this file had a single full-window
 * surface, `position: fixed; inset: 0` over an opaque background, and the per-view boundary used it:
 * SubNav was outside that boundary in the tree and under its fallback on screen. A hit test on the
 * rail landed on the alert; a real click did nothing. `probe:error-boundary` measures exactly that.
 */
export class ErrorBoundary extends Component<
  {
    children: ReactNode
    /** What broke, as a noun phrase ("this conversation", "the Mission view"). Heads the fallback. */
    label?: string
    /** One sentence naming the way out ("Pick another conversation from the list."). Panels only. */
    hint?: string
    /** See the class comment. Omit everywhere except the root. */
    scope?: 'panel' | 'window'
    /** A fixed-width slot (the dock). Omitted, a panel fallback fills its slot (`flex: 1`). */
    width?: number
  },
  BoundaryState
> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Console only. This must not reach a daemon endpoint: a client that crashes because it could
    // not handle a frame is not helped by a network call that may also fail, and the crash is
    // recoverable locally. The stack lands where a developer can read it (devtools / the terminal
    // that launched the app), and the watchdog channel stays for decisions rather than exceptions.
    console.error('[beacon] render error caught by ErrorBoundary', error, info.componentStack ?? '')
  }

  /** Clear the captured error so the subtree re-renders from scratch. */
  private readonly reset = (): void => this.setState({ error: null })

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return this.props.scope === 'window' ? (
      <BrokenWindow error={error} onRetry={this.reset} />
    ) : (
      <BrokenPanel error={error} label={this.props.label} hint={this.props.hint} width={this.props.width} onRetry={this.reset} />
    )
  }
}

/*
 * DESIGN TOKENS, NOT LITERAL HEX — and the reason is worth recording because the first cut of this
 * file got it backwards. The argument for literals was "this renders when the app is broken, so it
 * must not depend on a stylesheet or theme that may be part of what failed". That is false here:
 * `theme/tokens.css` is a STATIC import in main.tsx, bundled into the renderer's stylesheet before
 * any component mounts, and no render error can un-load it. NOX's defaults live on `:root` rather
 * than a `[data-theme]` block, so every var resolves even if `loadAndApplyTheme` never ran.
 *
 * What literals actually cost: the codex's pairs are measured across all nine plates by
 * `lint:contrast`, and hand-picked hexes are measured against none. A crash surface in GLAVCVM's
 * grey-stock plate would have been an unreviewed guess at contrast — the one surface where legibility
 * matters most, since it is what someone reads when everything else is gone.
 *
 * Inline styles stay, for the one real reason: a crash surface must not depend on a class that
 * something below could have left half-applied, and these are reached from a state where "the app
 * could not render" is the premise.
 */

const primaryButton: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  padding: '8px 16px',
  borderRadius: 6,
  border: 'none',
  background: 'var(--sang)',
  color: 'var(--on-sang)',
  cursor: 'pointer',
  fontFamily: 'inherit'
}

const secondaryButton: CSSProperties = {
  fontSize: 13,
  padding: '8px 16px',
  borderRadius: 6,
  border: '1px solid var(--c-line-bright)',
  background: 'transparent',
  color: 'var(--c-text)',
  cursor: 'pointer',
  fontFamily: 'inherit'
}

/**
 * "Reload Beacon", asked of MAIN and never done with `window.location.reload()`. In a built app the
 * shell is a file:// page. A reload the renderer starts raises will-navigate, and the shell's
 * navigation guard (src/main/index.ts) refuses every non-web URL, so both Reload buttons did nothing,
 * including the one on the root fallback, where Reload is the way out. `webContents.reload()` in
 * main does not raise that event, so the guard stays as strict as it was. `probe:error-boundary`
 * presses both buttons with a real click and requires a new document.
 */
const reloadBeacon = (): void => window.beacon.reloadWindow()

/** The message is shown, not hidden. "Something went wrong" with no detail is what turns a
 *  reportable bug into an unreportable one: the person who hit it has nothing to paste. */
function ErrorDetail({ error }: { error: Error }): ReactNode {
  return (
    <pre
      style={{
        fontSize: 11,
        maxWidth: 620,
        maxHeight: 120,
        overflow: 'auto',
        margin: 0,
        padding: '8px 10px',
        background: 'var(--c-inset)',
        border: '1px solid var(--c-line)',
        borderRadius: 6,
        color: 'var(--c-text-dim)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: 'var(--font-mono)',
        textAlign: 'left'
      }}
    >
      {String(error?.message ?? error)}
    </pre>
  )
}

/**
 * A panel's fallback: in the flow, in the broken subtree's slot, and nothing more. No `position`,
 * no z-index — it must not be able to reach over its neighbours, because its neighbours are the way
 * out. `flex: 1` fills a flex slot (the conversation column, the view below the pill row); `width`
 * pins it for the dock.
 */
function BrokenPanel({
  error,
  label,
  hint,
  width,
  onRetry
}: {
  error: Error
  label?: string
  hint?: string
  width?: number
  onRetry: () => void
}): ReactNode {
  const what = label ? label.charAt(0).toUpperCase() + label.slice(1) : 'This part of Beacon'
  return (
    <div
      role="alert"
      style={{
        ...(width ? { flex: `0 0 ${width}px`, width } : { flex: 1 }),
        minWidth: 0,
        minHeight: 0,
        alignSelf: 'stretch',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 24,
        overflow: 'auto',
        background: 'var(--paper)',
        color: 'var(--ink)',
        fontFamily: 'var(--font-body)',
        textAlign: 'center'
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 600, fontFamily: 'var(--font-display)' }}>{what} couldn’t be displayed.</div>
      {hint ? <div style={{ fontSize: 13, lineHeight: 1.5, maxWidth: 460, color: 'var(--c-text-dim)' }}>{hint}</div> : null}
      <ErrorDetail error={error} />
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button onClick={onRetry} style={primaryButton}>
          Try again
        </button>
        <button onClick={reloadBeacon} style={secondaryButton}>
          Reload Beacon
        </button>
      </div>
    </div>
  )
}

/**
 * The root's fallback: the whole window, because at the root there is nothing left to keep.
 *
 * The copy says only what is true. Conversations live on the daemon and in the local cache, so a
 * reload does not lose them. Unsent text is a different claim — an open conversation's draft is
 * saved on a short debounce and the new-chat box is not saved at all — so it is not promised.
 */
function BrokenWindow({ error, onRetry }: { error: Error; onRetry: () => void }): ReactNode {
  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        padding: 32,
        background: 'var(--paper)',
        color: 'var(--ink)',
        fontFamily: 'var(--font-body)',
        textAlign: 'center'
      }}
    >
      <div style={{ fontSize: 17, fontWeight: 600, fontFamily: 'var(--font-display)' }}>Beacon hit an error and stopped rendering.</div>
      <div style={{ fontSize: 14, lineHeight: 1.55, maxWidth: 540, color: 'var(--c-text-dim)' }}>
        Your conversations are kept on the daemon and in the local cache, so reloading does not lose them. Text you had not
        sent yet may not survive.
      </div>
      <ErrorDetail error={error} />
      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={reloadBeacon} style={primaryButton}>
          Reload Beacon
        </button>
        <button onClick={onRetry} style={secondaryButton}>
          Try again without reloading
        </button>
      </div>
    </div>
  )
}
