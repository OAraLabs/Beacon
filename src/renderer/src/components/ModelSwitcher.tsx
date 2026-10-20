import { Fragment, useEffect, useRef, useState, type ReactElement } from 'react'
import {
  backendHealthBadge,
  composerModelLabel,
  currentOption,
  groupByVendor,
  groupOptions,
  optionKind,
  optionUnavailableReason,
  vendorHeadingsHelp,
  type ModelOption
} from '@shared/composer-controls'
import { authBadgeText, authTitleSuffix, coerceAuthMode } from '@shared/model-auth'
import { Icon } from './Icon'

// Per-session model switcher (Composer-controls sprint). UI over the live model REST
// (Prometheus #71): the current effective model for the session + a dropdown of the catalog;
// selecting drives POST/DELETE upstream. Rendered in BOTH the top bar and the composer, bound to
// ONE state in ChatShell — changing either updates both. When the catalog is unavailable it
// degrades to a read-only label (the honest fallback), never a broken dropdown.

export function ModelSwitcher({
  variant,
  models,
  currentKey,
  defaultKey = 'local',
  onSelect,
  error,
  fallbackLabel
}: {
  variant: 'topbar' | 'composer'
  models: ModelOption[]
  currentKey: string | null
  /** The catalog's default key — tells a backend row from a cloud row (Prometheus PR 390). */
  defaultKey?: string
  onSelect: (key: string) => void
  /** Catalog/current fetch failed — show read-only + a quiet offline hint. */
  error?: boolean
  /** Read-only label when there's no catalog (e.g. the process model from /api/status). */
  fallbackLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const cur = currentOption(models, currentKey)
  // The TOPBAR chip names the model the way the catalog does. The COMPOSER chip is the last
  // thing you read before Send, so it carries the host too — `local · qwen2.5-32b`.
  const label = variant === 'composer' ? composerModelLabel(cur, fallbackLabel) : (cur?.label ?? fallbackLabel ?? '—')
  // "How it's connected" tooltip add-on (Prometheus PR 102) — '' on old daemons/local.
  const authSuffix = cur ? authTitleSuffix(cur.auth, cur.provider) : ''
  const interactive = models.length > 0

  if (!interactive) {
    return (
      <span className={`model-switcher model-switcher-${variant} is-readonly`} title={error ? 'Model list unavailable — showing current model' : `Model: ${label}${authSuffix}`}>
        <Icon name="code" size={12} />
        <span className="model-switcher-label">{label}</span>
        {error ? <span className="model-switcher-warn">· offline</span> : null}
      </span>
    )
  }

  return (
    <div className={`model-switcher model-switcher-${variant}`} ref={ref}>
      <button
        className="model-switcher-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Model: ${label}${authSuffix} — click to switch (this session)`}
      >
        <Icon name="code" size={12} />
        <span className="model-switcher-label">{label}</span>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
      </button>
      {open ? (
        <div className="model-switcher-menu" role="listbox">
          {(() => {
            // Local boxes first (the default + every configured backend row, Prometheus PR 390),
            // then cloud. Headers only when there is something on both sides to tell apart.
            const groups = groupOptions(models, defaultKey)
            const headed = groups.local.length > 0 && groups.cloud.length > 0
            const render = (o: ModelOption): ReactElement => {
              const kind = optionKind(o, defaultKey)
              // Why it cannot be picked: a down BACKEND names the probe's error; a cloud row
              // without a credential still says "key missing". Never the wrong reason.
              const reason = optionUnavailableReason(o, defaultKey)
              // Backend rows badge their reported window / vision / latency; cloud rows say how
              // the provider is connected (Prometheus PR 102). Neither shows beside a reason.
              const badge =
                kind === 'backend' ? backendHealthBadge(o) : authBadgeText(coerceAuthMode(o.auth), o.provider)
              return (
                <button
                  key={o.key}
                  role="option"
                  aria-selected={o.key === currentKey}
                  className={`model-switcher-opt${o.key === currentKey ? ' is-active' : ''}${o.available === false ? ' is-unavailable' : ''}`}
                  title={o.detail ?? undefined}
                  onClick={() => {
                    setOpen(false)
                    if (o.key !== currentKey) onSelect(o.key)
                  }}
                >
                  <span className="opt-main">
                    <span className="opt-label">{o.label}</span>
                    {o.model ? <span className="opt-sub">{o.model}</span> : null}
                  </span>
                  {reason ? <span className="opt-warn">{reason}</span> : null}
                  {!reason && badge ? (
                    <span className={kind === 'backend' ? 'opt-health' : 'opt-auth'}>{badge}</span>
                  ) : null}
                  {o.key === currentKey ? <Icon name="check" size={12} /> : null}
                </button>
              )
            }
            // Inside each section, group by VENDOR. Prometheus PR 542 gave every preset its
            // own versions, so "Cloud" became a ~28-row flat scroll with each vendor's models
            // adjacent but unmarked — finding "the Qwen ones" meant reading every line. The
            // daemon's order is preserved, so each vendor still leads with its default.
            const section = (options: ModelOption[]): ReactElement => {
              const vendors = groupByVendor(options)
              if (!vendorHeadingsHelp(vendors)) return <>{options.map(render)}</>
              return (
                <>
                  {vendors.map((v) => (
                    <Fragment key={v.id}>
                      <div className="model-switcher-vendor">{v.label}</div>
                      {v.options.map(render)}
                    </Fragment>
                  ))}
                </>
              )
            }
            return (
              <>
                {headed ? <div className="model-switcher-group">Local</div> : null}
                {section(groups.local)}
                {headed ? <div className="model-switcher-group">Cloud</div> : null}
                {section(groups.cloud)}
                <div className="menu-foot">Manage in Config → Models</div>
              </>
            )
          })()}
        </div>
      ) : null}
    </div>
  )
}
