import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  GYM_POLL_MS,
  GYM_READ_COPY,
  along,
  barAt,
  barWords,
  codeWords,
  defaultRoundsFilter,
  deltaDomain,
  fmtAgo,
  fmtBig,
  fmtCount,
  fmtDuration,
  fmtGib,
  fmtPts,
  fmtShare,
  groupScorecards,
  isReferenceCard,
  roundsOptions,
  gapStarts,
  isStale,
  linePoints,
  mountWords,
  nightHeadline,
  serviceLine,
  servicesSummary,
  share,
  type GymCount,
  type GymCriterion,
  type GymGenWindow,
  type GymHost,
  type GymRead,
  type GymRoundsFilter,
  type GymScorecard,
  type GymSettings,
  type GymStatus,
  type GymTone,
  type GymUsage
} from '@shared/gym'

// Activity › Gym: a fine-tuning gym's status, read-only (@shared/gym). Four sections: Now, Rounds, Data, Hosts.
//
// This file draws a GymStatus and nothing else. It does not know where the status came from (main's transport does,
// src/main/gym-transport.ts) or what the document looked like on the wire (the parser does, @shared/gym).
//
// Nothing here changes anything on the gym: the only things it keeps are where the gym is and this computer's token for it,
// both kept by main on this computer; the token is given to main and never comes back. Every word on screen is Beacon's; from
// the gym come numbers, times and identifiers only (the parser drops the rest), so there is no place a trace, a prompt or a
// task's text could be drawn.

type Section = 'now' | 'rounds' | 'data' | 'hosts'
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'now', label: 'Now' },
  { id: 'rounds', label: 'Rounds' },
  { id: 'data', label: 'Data' },
  { id: 'hosts', label: 'Hosts' }
]

const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const day = (at: number): string => new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })
const dayClock = (at: number): string => `${day(at)}, ${clock(at)}`
const NOT = 'Not reported'
const n0 = (n: number | null, f: (x: number) => string = fmtCount): string => (n === null ? NOT : f(n))

function Card({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`gym-card${wide ? ' is-wide' : ''}`}>
      <h3 className="gym-card-title">{title}</h3>
      {children}
    </section>
  )
}
function KV({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="gym-kv">
      <span className="gym-k">{label}</span>
      <span className="gym-v">{children}</span>
    </div>
  )
}
/** A state said in a word with a mark beside it: never by colour alone. */
function State({ tone, children }: { tone: GymTone; children: ReactNode }) {
  const mark = tone === 'ok' ? '✓' : tone === 'err' ? '✕' : tone === 'warn' ? '!' : '·'
  return (
    <span className={`gym-state is-${tone}`}>
      <span aria-hidden="true" className="gym-state-mark">
        {mark}
      </span>
      {children}
    </span>
  )
}
function Meter({ percent, label }: { percent: number; label: string }) {
  return (
    <div className="gym-meter" role="img" aria-label={label}>
      <div className="gym-meter-fill" style={{ width: `${percent}%` }} />
    </div>
  )
}
const Empty = ({ children }: { children: ReactNode }) => <p className="gym-empty">{children}</p>

/** One series over one axis. The line is the only coloured mark; the ends of the y scale and of the x range are written beside
 *  it, and moving over the chart reads out the nearest point. */
function LineChart({ series, label, fmtX, fmtY, short }: { series: readonly (readonly [number, number])[]; label: string; fmtX: (x: number) => string; fmtY: (y: number) => string; short?: boolean }) {
  const W = 600
  const H = 120
  const geo = useMemo(() => linePoints(series, W, H, 4), [series])
  const [hover, setHover] = useState<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  if (!geo) return <Empty>Not enough readings to draw yet.</Empty>
  const gaps = gapStarts(series) // no line across a stretch with no readings
  const path = geo.points.map((p, i) => `${i === 0 || gaps.has(i) ? 'M' : 'L'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
  const onMove = (clientX: number): void => {
    const r = box.current?.getBoundingClientRect()
    if (!r || r.width === 0) return
    const x = ((clientX - r.left) / r.width) * W
    let best = 0
    for (let i = 1; i < geo.points.length; i++) if (Math.abs(geo.points[i][0] - x) < Math.abs(geo.points[best][0] - x)) best = i
    setHover(best)
  }
  const h = hover !== null && hover < series.length ? { left: (geo.points[hover][0] / W) * 100, top: (geo.points[hover][1] / H) * 100, x: series[hover][0], y: series[hover][1] } : null
  const last = series[series.length - 1]
  return (
    <div className={`gym-chart${short ? ' is-short' : ''}`}>
      <div className="gym-chart-y">
        <span>{fmtY(geo.max)}</span>
        <span>{fmtY(geo.min)}</span>
      </div>
      <div className="gym-chart-plot" ref={box} onMouseMove={(e) => onMove(e.clientX)} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label}: ${fmtY(series[0][1])} at ${fmtX(series[0][0])}, ${fmtY(last[1])} at ${fmtX(last[0])}`}>
          <path d={path} className="gym-line" vectorEffect="non-scaling-stroke" />
        </svg>
        {h ? (
          <>
            <div className="gym-cross" style={{ left: `${h.left}%` }} />
            <div className="gym-dot" style={{ left: `${h.left}%`, top: `${h.top}%` }} />
            <div className={`gym-tip${h.left > 60 ? ' is-left' : ''}`} style={{ left: `${h.left}%` }}>
              <strong>{fmtY(h.y)}</strong> {fmtX(h.x)}
            </div>
          </>
        ) : null}
      </div>
      <div className="gym-chart-x">
        <span>{fmtX(series[0][0])}</span>
        <span>{fmtX(last[0])}</span>
      </div>
    </div>
  )
}

function Ranked({ rows, fmt = fmtCount }: { rows: GymCount[]; fmt?: (n: number) => string }) {
  const top = Math.max(...rows.map((r) => r.n), 1)
  const total = rows.reduce((n, r) => n + r.n, 0)
  return (
    <div className="gym-ranked">
      {rows.map((r) => (
        <div className="gym-ranked-row" key={r.id} title={`${codeWords(r.id)}: ${fmt(r.n)} (${Math.round(share(r.n, total))}%)`}>
          <span className="gym-ranked-name">{codeWords(r.id)}</span>
          <div className="gym-ranked-track">
            <div className="gym-ranked-fill" style={{ width: `${share(r.n, top)}%` }} />
          </div>
          <span className="gym-ranked-n">{fmt(r.n)}</span>
        </div>
      ))}
    </div>
  )
}

// ── Now ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function NowSection({ s, now }: { s: GymStatus; now: number }) {
  const r = s.round
  const t = s.training
  const p = s.postTrain
  const ln = s.lastNight
  const sv = servicesSummary(s.hosts)
  const upcoming = s.schedule.filter((w) => w.at >= now)
  const failed = s.sources.filter((x) => !x.ok)
  const pct = t && t.step !== null && t.total ? share(t.step, t.total) : null
  const head = ln ? nightHeadline(ln) : null
  return (
    <div className="gym-grid">
      <Card title="Where it stands">
        <div className="gym-hero">
          <span className="gym-hero-n">{r?.id ?? 'No round'}</span>
          <span className="gym-hero-sub">{r ? codeWords(r.phase) : NOT}</span>
        </div>
        {r ? (
          <>
            {r.phaseSince !== null ? <KV label="In this phase since">{dayClock(r.phaseSince)}</KV> : null}
            <KV label="Decision">{r.decision ? codeWords(r.decision) : NOT}</KV>
            {r.base ? <KV label="Base model">{r.base}</KV> : null}
            {r.trainRows !== null ? <KV label="Training examples">{fmtCount(r.trainRows)}</KV> : null}
            {r.stopAfter ? <KV label="If it fails">Last round on this base</KV> : null}
          </>
        ) : null}
        {sv.total > 0 ? (
          <KV label="Services">
            {sv.unexpected > 0 ? (
              <State tone="err">
                {sv.unexpected} down unexpectedly{sv.planned > 0 ? `, ${sv.planned} down as planned` : ''}
              </State>
            ) : sv.planned > 0 ? (
              <State tone="idle">{sv.planned} down as planned, nothing unexpected</State>
            ) : (
              <State tone="ok">All {sv.total} up</State>
            )}
          </KV>
        ) : null}
      </Card>

      <Card title="Last night">
        {ln && head ? (
          <>
            <div className="gym-hero">
              <State tone={head.tone}>{head.text}</State>
            </div>
            {ln.windows.map((w, i) => (
              <KV key={i} label={w.host ? `${codeWords(w.host)}’s window` : 'Window'}>
                {w.openedAt !== null ? clock(w.openedAt) : '?'} to {w.closedAt !== null ? clock(w.closedAt) : 'still open'}
                {w.restoreOk === true ? ', restored' : w.restoreOk === false ? ', restore failed' : ''}
              </KV>
            ))}
            {ln.training && ln.training.stepFrom !== null && ln.training.stepTo !== null ? (
              <KV label="Training steps">
                {fmtCount(ln.training.stepFrom)} to {fmtCount(ln.training.stepTo)} ({fmtCount(ln.training.stepTo - ln.training.stepFrom)})
              </KV>
            ) : null}
            {ln.teacher ? <KV label="Teacher examples kept">{n0(ln.teacher.rows)}</KV> : null}
            {ln.gpu ? (
              <KV label="GPU at most">
                {n0(ln.gpu.maxTempC, (x) => `${x.toFixed(0)} °C`)}, {n0(ln.gpu.maxPowerW, (x) => `${x.toFixed(0)} W`)}
              </KV>
            ) : null}
            <KV label="Alerts overnight">{n0(ln.alerts)}</KV>
          </>
        ) : (
          <Empty>The gym hasn’t reported on last night.</Empty>
        )}
      </Card>

      <Card title="Training" wide>
        {t ? (
          <>
            <div className="gym-hero">
              <span className="gym-hero-n">{pct !== null ? `${Math.round(pct)}%` : codeWords(t.status)}</span>
              <span className="gym-hero-sub">
                {pct !== null ? `${codeWords(t.status)} · ` : ''}
                {t.step !== null && t.total !== null ? `step ${fmtCount(t.step)} of ${fmtCount(t.total)}` : ''}
                {t.epoch !== null && t.epochs !== null ? ` · epoch ${t.epoch.toFixed(2)} of ${t.epochs}` : ''}
              </span>
            </div>
            {pct !== null ? <Meter percent={pct} label={`Training ${Math.round(pct)}% done`} /> : null}
            <div className="gym-facts">
              <KV label="Expected to finish">{t.eta !== null ? `${dayClock(t.eta)}${t.eta > now ? ` (in ${fmtDuration((t.eta - now) / 1000)})` : ''}` : NOT}</KV>
              <KV label="Must stop by">{t.windowStopAt !== null ? dayClock(t.windowStopAt) : NOT}</KV>
              <KV label="Speed">{n0(t.tokensPerS, (x) => `${fmtCount(x)} tokens a second`)}</KV>
              <KV label="Last heard from">{t.updatedAt !== null ? fmtAgo(t.updatedAt, now) : NOT}</KV>
            </div>
            <div className="gym-multiples">
              {(
                [
                  ['Validation loss', t.valLoss],
                  ['Probe loss', t.probeLoss],
                  ['Training loss', t.trainLoss]
                ] as const
              ).map(([name, series]) =>
                series.length > 0 ? (
                  <div key={name}>
                    <h4 className="gym-sub">{name}, by step</h4>
                    <LineChart short series={series} label={name} fmtX={(x) => `step ${fmtCount(x)}`} fmtY={(y) => y.toFixed(3)} />
                  </div>
                ) : null
              )}
            </div>
          </>
        ) : (
          <Empty>The gym hasn’t reported on training.</Empty>
        )}
      </Card>

      {p ? (
        <Card title="After-training checks">
          <KV label="Status">{codeWords(p.status)}</KV>
          {p.stepsDone !== null && p.stepsTotal ? (
            <>
              <KV label="Steps">
                {p.stepsDone} of {p.stepsTotal}
              </KV>
              <Meter percent={share(p.stepsDone, p.stepsTotal)} label={`${p.stepsDone} of ${p.stepsTotal} steps done`} />
            </>
          ) : null}
          {p.currentStep ? <KV label="Now on">{p.currentStep}</KV> : null}
          {p.outcome ? <KV label="Outcome">{codeWords(p.outcome)}</KV> : null}
          {p.candidates.map((c) => (
            <KV key={c.id} label={`Candidate ${c.id}`}>
              {c.valLoss !== null ? `validation loss ${c.valLoss.toFixed(3)}` : NOT}
            </KV>
          ))}
        </Card>
      ) : null}

      <Card title="Coming up">
        {upcoming.length > 0 ? (
          <ul className="gym-list">
            {upcoming.slice(0, 12).map((w, i) => (
              <li key={i}>
                <span className="gym-when">{dayClock(w.at)}</span>
                <span>
                  {codeWords(w.kind)}
                  {w.host ? <span className="gym-on"> · {codeWords(w.host)}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Nothing is scheduled.</Empty>
        )}
      </Card>

      <Card title="Alerts">
        {s.alerts.length > 0 ? (
          <ul className="gym-list">
            {s.alerts.map((a, i) => (
              <li key={i}>
                <span className="gym-when">{a.since !== null ? `since ${dayClock(a.since)}` : ''}</span>
                <State tone={a.severity === 'critical' ? 'err' : a.severity === 'warn' ? 'warn' : 'idle'}>
                  {codeWords(a.kind)}
                  {a.service ? `: ${codeWords(a.service).toLowerCase()}` : ''}
                  {a.host ? ` · ${codeWords(a.host)}` : ''}
                  {a.count !== null && a.count > 1 ? ` (${a.count})` : ''}
                </State>
              </li>
            ))}
          </ul>
        ) : (
          <State tone="ok">Nothing is wrong right now</State>
        )}
      </Card>

      {failed.length > 0 ? (
        <Card title="What the gym couldn’t read">
          <ul className="gym-list">
            {failed.map((x, i) => (
              <li key={i}>
                <span className="gym-when">{x.host ? codeWords(x.host) : ''}</span>
                <span>
                  {codeWords(x.id)}: {x.error ? codeWords(x.error) : 'not read'}
                </span>
              </li>
            ))}
          </ul>
          <p className="gym-note">Anything that depends on these shows as not reported.</p>
        </Card>
      ) : null}

      <Card title="What happened" wide>
        {s.timeline.length > 0 ? (
          <ul className="gym-list">
            {s.timeline.slice(0, 40).map((e, i) => (
              <li key={i}>
                <span className="gym-when">{dayClock(e.at)}</span>
                <span>
                  {codeWords(e.kind)}
                  {e.value !== null ? ` (${fmtCount(e.value)})` : ''}
                  {e.host || e.round ? <span className="gym-on"> · {[e.host ? codeWords(e.host) : null, e.round].filter(Boolean).join(' · ')}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Nothing has been recorded.</Empty>
        )}
      </Card>
    </div>
  )
}

// ── Rounds ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const STATUS_TONE: Record<GymCriterion['status'], GymTone> = { pass: 'ok', fail: 'err', underpowered: 'warn', info: 'idle', other: 'idle' }
const STATUS_WORD: Record<GymCriterion['status'], string> = { pass: 'Pass', fail: 'Fail', underpowered: 'Too few samples', info: 'For information', other: 'Other' }

/** One criterion in one scorecard: the change against the base model as a dot on the row's shared scale, its confidence interval
 *  as a band, the bar it has to clear as a tick, and zero as a hairline. Pass or fail is said in words beside the number. */
function GateCell({ c, domain }: { c: GymCriterion; domain: { min: number; max: number } }) {
  const bar = barAt(c.bar)
  const said = `${c.deltaPts !== null ? fmtPts(c.deltaPts) : 'no change measured'} against the base model${c.ciLowPts !== null && c.ciHighPts !== null ? `, likely between ${fmtPts(c.ciLowPts)} and ${fmtPts(c.ciHighPts)}` : ''}; ${barWords(c.bar)}; ${STATUS_WORD[c.status].toLowerCase()}${c.candidatePts !== null && c.basePts !== null ? `. Candidate ${c.candidatePts.toFixed(1)}, base ${c.basePts.toFixed(1)}` : ''}${c.n !== null ? `, ${fmtCount(c.n)} samples` : ''}`
  return (
    <div className="gym-gate" title={said}>
      <div className="gym-gate-top">
        <span className="gym-gate-n">{c.deltaPts !== null ? fmtPts(c.deltaPts) : '—'}</span>
        <State tone={STATUS_TONE[c.status]}>{STATUS_WORD[c.status]}</State>
      </div>
      <div className="gym-gate-track" role="img" aria-label={said}>
        <div className="gym-gate-zero" style={{ left: `${along(0, domain)}%` }} />
        {c.ciLowPts !== null && c.ciHighPts !== null ? <div className="gym-gate-ci" style={{ left: `${along(c.ciLowPts, domain)}%`, width: `${along(c.ciHighPts, domain) - along(c.ciLowPts, domain)}%` }} /> : null}
        {bar !== null ? <div className="gym-gate-bar" style={{ left: `${along(bar, domain)}%` }} /> : null}
        {c.deltaPts !== null ? <div className="gym-gate-dot" style={{ left: `${along(c.deltaPts, domain)}%` }} /> : null}
      </div>
      <div className="gym-gate-sub">{c.candidatePts !== null && c.basePts !== null ? `${c.candidatePts.toFixed(1)} vs ${c.basePts.toFixed(1)}` : ''}</div>
    </div>
  )
}

const colKey = (c: GymScorecard): string => [c.round, c.candidate, c.quant, c.vs].join('/')
const quantWords = (q: string): string => q.toUpperCase().replace(/_/g, ' ')

function FilterRow({ label, value, options, onPick }: { label: string; value: string; options: { id: string; label: string }[]; onPick: (id: string) => void }) {
  return (
    <div className="gym-filter" role="group" aria-label={label}>
      <span className="gym-filter-label">{label}</span>
      {options.map((o) => (
        <button key={o.id} className={`pill${o.id === value ? ' is-active' : ''}`} aria-pressed={o.id === value} onClick={() => onPick(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function RoundsSection({ s }: { s: GymStatus }) {
  const all = s.scorecards
  const options = useMemo(() => roundsOptions(all), [all])
  // What you picked is kept while the status refreshes; null means "the default slice", which follows what the gym serves.
  const [picked, setPicked] = useState<GymRoundsFilter | null>(null)
  const filter = picked ?? defaultRoundsFilter(all)
  const set = (part: Partial<GymRoundsFilter>): void => setPicked({ ...filter, ...part })
  const groups = groupScorecards(all, filter)
  const cards = groups.flatMap((g) => g.cards)
  const ids: string[] = []
  const bars = new Map<string, GymCriterion['bar']>()
  for (const c of cards)
    for (const k of c.criteria)
      if (!bars.has(k.id)) {
        ids.push(k.id)
        bars.set(k.id, k.bar)
      }
  const sets = [...new Set(cards.flatMap((c) => c.replay.map((r) => r.set)))]
  if (all.length === 0) return <Empty>The gym hasn’t reported any gate results.</Empty>
  return (
    <div className="gym-rounds-wrap">
      <div className="gym-filters" data-testid="gym-rounds-filters">
        <FilterRow label="Quantisation" value={filter.quant} onPick={(quant) => set({ quant })} options={[...options.quants.map((q) => ({ id: q, label: quantWords(q) })), { id: 'all', label: 'All' }]} />
        <FilterRow label="Compared" value={filter.vs} onPick={(vs) => set({ vs })} options={[...options.vs.map((v) => ({ id: v, label: codeWords(v) })), { id: 'all', label: 'All' }]} />
        <FilterRow label="Candidate" value={filter.candidate} onPick={(candidate) => set({ candidate })} options={[{ id: 'kept', label: 'Kept' }, ...options.candidates.map((c) => ({ id: c, label: c })), { id: 'all', label: 'All' }]} />
      </div>
      {cards.length === 0 ? (
        <Empty>No gate result matches these three choices.</Empty>
      ) : (
        <>
          <div className="gym-legend" aria-hidden="true">
            <span>
              <i className="gym-key is-dot" /> Change against the base model
            </span>
            <span>
              <i className="gym-key is-ci" /> Where it likely lies
            </span>
            <span>
              <i className="gym-key is-bar" /> Bar to clear
            </span>
            <span>
              <i className="gym-key is-zero" /> No change
            </span>
          </div>
          <table className="gym-rounds">
            <thead>
              <tr>
                <th scope="col" rowSpan={2}>
                  Gate
                </th>
                {groups.map((g) => (
                  <th scope="colgroup" colSpan={g.cards.length} key={g.round} className="gym-round-head">
                    <span className="gym-round-id">{g.round}</span>
                    {g.noneKept ? <span className="gym-round-state">no candidate was kept: showing all</span> : null}
                  </th>
                ))}
              </tr>
              <tr>
                {groups.map((g) =>
                  g.cards.map((c, i) => (
                    <th scope="col" key={colKey(c)} className={i === 0 ? 'gym-round-first' : undefined}>
                      <span className="gym-cand">{isReferenceCard(c) ? codeWords(c.candidate) : c.candidate}</span>
                      {isReferenceCard(c) ? (
                        <State tone="idle">Reference only</State>
                      ) : (
                        <State tone={c.verdict === 'pass' ? 'ok' : c.verdict === 'fail' ? 'err' : 'idle'}>
                          {c.verdict === 'pass' ? 'Pass' : c.verdict === 'fail' ? 'Fail' : 'No verdict'}
                          {c.outcome && c.outcome !== c.verdict ? ` · ${codeWords(c.outcome)}` : ''}
                        </State>
                      )}
                      <span className="gym-round-state">{[c.quant ? quantWords(c.quant) : null, c.promoted ? 'promoted' : c.selected ? 'kept' : null].filter(Boolean).join(' · ')}</span>
                      {c.vs && !isReferenceCard(c) && filter.vs === 'all' ? <span className="gym-round-state">{codeWords(c.vs)}</span> : null}
                    </th>
                  ))
                )}
              </tr>
            </thead>
            <tbody>
              {ids.map((id) => {
                const row = cards.map((c) => c.criteria.find((k) => k.id === id))
                const domain = deltaDomain(row)
                return (
                  <tr key={id}>
                    <th scope="row">
                      {codeWords(id)}
                      <span className="gym-round-state">{barWords(bars.get(id) as GymCriterion['bar'])}</span>
                    </th>
                    {cards.map((c, i) => (
                      <td key={colKey(c)}>{row[i] ? <GateCell c={row[i] as GymCriterion} domain={domain} /> : <span className="gym-none">not measured</span>}</td>
                    ))}
                  </tr>
                )
              })}
              {sets.map((set1) => (
                <tr key={`replay/${set1}`}>
                  <th scope="row">
                    Replay: {codeWords(set1)}
                    <span className="gym-round-state">final answers right; tool choices right</span>
                  </th>
                  {cards.map((c) => {
                    const r = c.replay.find((x) => x.set === set1)
                    return (
                      <td key={colKey(c)}>
                        {r ? (
                          <div className="gym-replay">
                            {r.faPass !== null && r.faN ? (
                              <span>
                                {r.faPass} of {r.faN} ({Math.round(share(r.faPass, r.faN))}%)
                              </span>
                            ) : (
                              <span className="gym-none">not measured</span>
                            )}
                            {r.tcPass !== null && r.tcN ? (
                              <span>
                                {r.tcPass} of {r.tcN} ({Math.round(share(r.tcPass, r.tcN))}%)
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <span className="gym-none">not measured</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

// ── Data ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function GenCard({ title, w }: { title: string; w: GymGenWindow }) {
  return (
    <Card title={title}>
      <KV label="Examples kept">{n0(w.rows)}</KV>
      <KV label="An hour">{n0(w.rowsPerHour)}</KV>
      <KV label="Kept, of what was made">{n0(w.keepRate, fmtShare)}</KV>
      {w.byTeacherPerHour.length > 0 ? (
        <>
          <h4 className="gym-sub">By teacher, an hour</h4>
          <Ranked rows={w.byTeacherPerHour} fmt={(x) => (x >= 10 ? fmtCount(x) : x.toFixed(1))} />
        </>
      ) : null}
    </Card>
  )
}
function UsageRows({ label, u }: { label: string; u: GymUsage }) {
  return (
    <>
      <KV label={`Calls, ${label}`}>
        {n0(u.ok)} of {n0(u.attempts)} worked{u.errors > 0 ? `, ${fmtCount(u.errors)} errors` : ''}
      </KV>
      <KV label={`Tokens in, ${label}`}>
        {n0(u.inputTokens, fmtBig)}
        {u.cachedInputTokens !== null && u.inputTokens ? ` (${Math.round(share(u.cachedInputTokens, u.inputTokens))}% cached)` : ''}
      </KV>
      <KV label={`Tokens out, ${label}`}>{n0(u.outputTokens, fmtBig)}</KV>
    </>
  )
}

function DataSection({ s }: { s: GymStatus }) {
  const d = s.data
  const g = s.generation
  const tp = s.tokenPlan
  if (!d && !g && !tp) return <Empty>The gym hasn’t reported on its data.</Empty>
  const ds = d?.dataset
  const history: GymCount[] = (d?.history ?? []).filter((h) => h.trainRows !== null).map((h) => ({ id: h.round, n: h.trainRows as number }))
  return (
    <div className="gym-grid">
      {d?.pool ? (
        <Card title="Pool" wide={d.poolGrowth.length > 1}>
          <div className="gym-hero">
            <span className="gym-hero-n">{n0(d.pool.rowsTotal)}</span>
            <span className="gym-hero-sub">examples in the pool{d.pool.updatedAt !== null ? `, as of ${dayClock(d.pool.updatedAt)}` : ''}</span>
          </div>
          {d.poolGrowth.length > 1 ? (
            <>
              <h4 className="gym-sub">Examples in the pool, day by day</h4>
              <LineChart series={d.poolGrowth} label="Examples in the pool" fmtX={day} fmtY={fmtCount} />
            </>
          ) : null}
          <div className={d.poolGrowth.length > 1 ? 'gym-facts' : undefined}>
            {d.pool.bySource.length > 0 ? (
              <div>
                <h4 className="gym-sub">All of it, by source</h4>
                <Ranked rows={d.pool.bySource} />
              </div>
            ) : null}
            {d.poolAdded.length > 0 ? (
              <div>
                <h4 className="gym-sub">Added over these days, by source</h4>
                <Ranked rows={d.poolAdded} />
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}
      {history.length > 0 ? (
        <Card title="Training examples, round by round">
          <Ranked rows={history} />
        </Card>
      ) : null}
      {ds ? (
        <Card title={`This round’s dataset${ds.name ? ` · ${ds.name}` : ''}`}>
          <KV label="Training examples">{n0(ds.trainRows)}</KV>
          <KV label="Held out for validation">{n0(ds.valRows)}</KV>
          <KV label="With a tool call">{n0(ds.toolCallShare, fmtShare)}</KV>
          <KV label="Length, typical and long">{ds.tokensP50 !== null && ds.tokensP90 !== null ? `${fmtCount(ds.tokensP50)} and ${fmtCount(ds.tokensP90)} tokens` : NOT}</KV>
          <KV label="Most examples from one seed">{n0(ds.perSeedCap)}</KV>
          <KV label="Seeds over that cap">{ds.seedsOverCap === null ? NOT : ds.seedsOverCap === 0 ? <State tone="ok">None</State> : <State tone="warn">{fmtCount(ds.seedsOverCap)}</State>}</KV>
          {ds.parts.map((p) => (
            <KV key={p.name} label={`Part ${p.name}`}>
              {n0(p.trainRows)}
            </KV>
          ))}
        </Card>
      ) : null}
      {ds && ds.bySource.length > 0 ? (
        <Card title="Dataset by source">
          <Ranked rows={ds.bySource} />
        </Card>
      ) : null}
      {ds && ds.byArea.length > 0 ? (
        <Card title="Dataset by area">
          <Ranked rows={ds.byArea} />
        </Card>
      ) : null}
      {ds && ds.byCategory.length > 0 ? (
        <Card title="Dataset by category">
          <Ranked rows={ds.byCategory} />
        </Card>
      ) : null}
      {d && d.tasksets.length > 0 ? (
        <Card title="Written task sets and their variety" wide>
          <table className="gym-table">
            <thead>
              <tr>
                <th scope="col">Set</th>
                <th scope="col">Tasks</th>
                <th scope="col">Sameness</th>
                <th scope="col">With earlier sets</th>
                <th scope="col">Repeats of earlier</th>
                <th scope="col">Seeds</th>
                <th scope="col">Most from one seed</th>
              </tr>
            </thead>
            <tbody>
              {d.tasksets.map((t) => (
                <tr key={t.name}>
                  <th scope="row">
                    {t.name}
                    {t.held ? <span className="gym-on"> · held out</span> : null}
                  </th>
                  <td>{n0(t.rows)}</td>
                  <td>{n0(t.selfBleu4, (x) => x.toFixed(3))}</td>
                  <td>{n0(t.selfBleu4WithEarlier, (x) => x.toFixed(3))}</td>
                  <td>{n0(t.dupOfEarlierShare, fmtShare)}</td>
                  <td>{n0(t.seedsUsed)}</td>
                  <td>{n0(t.perSeedMax)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="gym-note">Sameness is self-BLEU-4 over a sample of the set: lower means more varied.</p>
        </Card>
      ) : null}
      {g?.last24h ? <GenCard title="Teachers, last 24 hours" w={g.last24h} /> : null}
      {g?.sinceRoundStart ? <GenCard title="Teachers, since the round started" w={g.sinceRoundStart} /> : null}
      {g && (g.activeRuns.length > 0 || g.judge24h) ? (
        <Card title="Running now, and the judge">
          {g.activeRuns.map((r, i) => (
            <div key={i}>
              <KV label={`${codeWords(r.teacher)}${r.taskset ? ` on ${r.taskset}` : ''}`}>
                {n0(r.tasksDone)} of {n0(r.tasksTotal)} tasks{r.tasksPerHour !== null ? `, ${fmtCount(r.tasksPerHour)} an hour` : ''}
              </KV>
              {r.tasksDone !== null && r.tasksTotal ? <Meter percent={share(r.tasksDone, r.tasksTotal)} label={`${Math.round(share(r.tasksDone, r.tasksTotal))}% of tasks done`} /> : null}
            </div>
          ))}
          {g.activeRuns.length === 0 ? <KV label="Teacher runs">None running</KV> : null}
          {g.judge24h ? (
            <KV label="Judge, last 24 hours">
              {n0(g.judge24h.calls)} calls: {n0(g.judge24h.pass)} passed, {n0(g.judge24h.fail)} failed
            </KV>
          ) : null}
        </Card>
      ) : null}
      {tp ? (
        <Card title="Token plan">
          <KV label="State">
            <State tone={tp.state === 'ok' ? 'ok' : tp.state === 'stopped' ? 'err' : tp.state === 'paused' ? 'warn' : 'idle'}>
              {tp.state === 'ok' ? 'Accepting requests' : tp.state === 'paused' ? 'Paused: out of quota until it resets' : tp.state === 'stopped' ? 'Stopped: refused, needs you' : codeWords(tp.state)}
              {tp.since !== null ? ` since ${dayClock(tp.since)}` : ''}
            </State>
          </KV>
          {tp.usage24h ? <UsageRows label="24 hours" u={tp.usage24h} /> : null}
          {tp.usage7d ? <UsageRows label="7 days" u={tp.usage7d} /> : null}
          {tp.concurrency ? (
            <KV label="At once">
              up to {n0(tp.concurrency.limit)}
              {tp.concurrency.max !== null ? `, most seen ${tp.concurrency.max}` : ''}
            </KV>
          ) : null}
        </Card>
      ) : null}
    </div>
  )
}

// ── Hosts ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function HostCard({ h, now }: { h: GymHost; now: number }) {
  const g = h.gpu
  const w = h.window
  return (
    <Card title={codeWords(h.id)} wide>
      <div className="gym-host">
        <div className="gym-host-facts">
          <KV label="Reachable">{h.reachable === true ? <State tone="ok">Yes</State> : h.reachable === false ? <State tone="err">No</State> : NOT}</KV>
          {h.services.map((sv) => {
            const line = serviceLine(sv, dayClock)
            return (
              <KV key={sv.id} label={codeWords(sv.id)}>
                <State tone={line.tone}>{line.text}</State>
              </KV>
            )
          })}
          {w ? (
            <KV label="Gym’s window">
              {w.open ? `Open${w.job && w.job !== 'none' ? `: ${codeWords(w.job).toLowerCase()}` : w.mode && w.mode !== 'none' ? `: ${codeWords(w.mode).toLowerCase()}` : ''}${w.endsAt !== null ? `, until ${dayClock(w.endsAt)}` : ''}` : 'Closed'}
            </KV>
          ) : null}
          {w?.noSwapsFlag ? (
            <KV label="No-swaps flag">
              <State tone="err">Set</State>
            </KV>
          ) : null}
          {h.lastRestoreAt !== null ? (
            <KV label="Last restore">
              {dayClock(h.lastRestoreAt)}
              {h.lastRestoreOk === true ? ', worked' : h.lastRestoreOk === false ? ', failed' : ''}
            </KV>
          ) : null}
          {h.bootAt !== null ? (
            <KV label="Running since">
              {h.bootExplained === false ? <State tone="warn">{`${dayClock(h.bootAt)}, restarted unexpectedly`}</State> : `${day(h.bootAt)} (${fmtAgo(h.bootAt, now)})`}
            </KV>
          ) : null}
          {h.gpuRole ? <KV label="GPU is serving">{codeWords(h.gpuRole)}</KV> : null}
          {h.disk.map((d) =>
            d.freeGib !== null && d.totalGib ? (
              <div key={d.mount}>
                <KV label={`Disk free, ${mountWords(d.mount)}`}>
                  {fmtGib(d.freeGib)} of {fmtGib(d.totalGib)}
                </KV>
                <Meter percent={share(d.freeGib, d.totalGib)} label={`Disk (${mountWords(d.mount)}) ${Math.round(share(d.freeGib, d.totalGib))}% free`} />
              </div>
            ) : null
          )}
          {g ? (
            <>
              <KV label="GPU now">
                {n0(g.tempC, (x) => `${x.toFixed(0)} °C`)}, {n0(g.utilPct, (x) => `${x.toFixed(0)}% busy`)}
              </KV>
              <KV label="GPU power">
                {n0(g.powerW, (x) => `${x.toFixed(0)} W`)}
                {g.powerLimitW !== null ? ` of ${g.powerLimitW.toFixed(0)} W` : ''}
              </KV>
              {g.vramUsedMib !== null && g.vramTotalMib ? (
                <KV label="GPU memory">
                  {(g.vramUsedMib / 1024).toFixed(1)} of {(g.vramTotalMib / 1024).toFixed(1)} GiB
                </KV>
              ) : null}
            </>
          ) : (
            <KV label="GPU">{NOT}</KV>
          )}
          {h.failedUnits !== null ? <KV label="Failed background jobs">{h.failedUnits === 0 ? <State tone="ok">None</State> : <State tone="warn">{h.failedUnits}</State>}</KV> : null}
          {h.watchdog ? (
            <KV label="Watchdog">
              {h.watchdog.lastOk === false ? (
                <State tone="err">{`Failing${h.watchdog.consecutiveFails ? ` (${h.watchdog.consecutiveFails} in a row)` : ''}`}</State>
              ) : h.watchdog.lastCheck !== null ? (
                `OK, checked ${fmtAgo(h.watchdog.lastCheck, now)}`
              ) : (
                NOT
              )}
            </KV>
          ) : null}
        </div>
        {h.gpuTemp.length > 1 || h.gpuPower.length > 1 ? (
          <div className="gym-host-charts">
            <h4 className="gym-sub">GPU temperature, °C, last 24 hours</h4>
            <LineChart series={h.gpuTemp} label="GPU temperature" fmtX={dayClock} fmtY={(y) => `${y.toFixed(0)} °C`} />
            <h4 className="gym-sub">GPU power, W, last 24 hours</h4>
            <LineChart series={h.gpuPower} label="GPU power" fmtX={dayClock} fmtY={(y) => `${y.toFixed(0)} W`} />
          </div>
        ) : null}
      </div>
    </Card>
  )
}

// ── where the gym is, and this computer's token for it ──────────────────────────────────────────────────────────────────────
function SettingsForm({ settings, onSaved }: { settings: GymSettings; onSaved: () => void }) {
  const [address, setAddress] = useState(settings.address)
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => setAddress(settings.address), [settings.address])
  const save = async (): Promise<void> => {
    const b = window.beacon
    if (!b) return
    setBusy(true)
    try {
      const a = await b.gym.setAddress(address)
      if (!a.ok) return setError(a.reason)
      // An empty token field leaves the kept token alone; only something typed replaces it.
      if (token.trim() !== '') {
        const t = await b.gym.setToken(token)
        if (!t.ok) return setError(t.reason)
        setToken('')
      }
      setError(null)
      onSaved()
    } finally {
      setBusy(false)
    }
  }
  const forget = async (): Promise<void> => {
    const b = window.beacon
    if (!b) return
    await b.gym.setToken('')
    onSaved()
  }
  return (
    <form
      className="gym-address"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <label htmlFor="gym-address">Where the gym’s status is</label>
      <input id="gym-address" data-testid="gym-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="http://name-of-the-computer:18097" spellCheck={false} autoComplete="off" />
      <label htmlFor="gym-token">This computer’s token for the gym</label>
      <input
        id="gym-token"
        data-testid="gym-token"
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder={settings.hasToken ? 'A token is kept. Paste a new one to replace it.' : 'Paste the token the gym’s computer made for this one'}
        spellCheck={false}
        autoComplete="off"
      />
      <div className="gym-address-row">
        <button type="submit" className="pill" disabled={busy}>
          Save
        </button>
        {settings.hasToken ? (
          <button type="button" className="gym-link" onClick={() => void forget()}>
            Forget the token
          </button>
        ) : null}
      </div>
      <p className="gym-address-note">
        Beacon only reads the gym, and only over Tailscale. The token is kept encrypted on this computer, with a key your keychain holds. It is sent to the gym and nowhere else, and Beacon never shows it
        again.
      </p>
      {error ? (
        <p className="gym-address-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  )
}

function problemOf(read: GymRead): string | null {
  switch (read.kind) {
    case 'shown':
      return null
    case 'unset':
      return GYM_READ_COPY.unset
    case 'refused':
      return read.reason
    case 'unreachable':
      return GYM_READ_COPY.unreachable
    case 'no-token':
      return GYM_READ_COPY.noToken
    case 'denied':
      return read.why === 'token' ? GYM_READ_COPY.deniedToken : read.why === 'device' ? GYM_READ_COPY.deniedDevice : GYM_READ_COPY.deniedRate
    case 'unreadable':
      return read.detail
  }
}

export function GymPanel() {
  const [read, setRead] = useState<GymRead | null>(null)
  const [section, setSection] = useState<Section>('now')
  const [settings, setSettings] = useState<GymSettings>({ address: '', hasToken: false })
  const [editing, setEditing] = useState(false)
  const [tick, setTick] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const b = window.beacon
    if (!b) return
    let alive = true
    const poll = (): void => {
      void b.gym.read().then(
        (r) => {
          if (!alive) return
          setRead(r)
          setNow(Date.now())
        },
        () => {
          if (alive) setRead({ kind: 'unreachable' })
        }
      )
    }
    void b.gym.settings().then(
      (v) => alive && setSettings(v),
      () => undefined
    )
    poll()
    const id = setInterval(poll, GYM_POLL_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [tick])

  const status = read?.kind === 'shown' ? read.status : null
  const problem = read ? problemOf(read) : null
  const showForm = editing || (read !== null && read.kind !== 'shown' && !(read.kind === 'denied' && read.why === 'rate'))

  return (
    <div className="gym" data-testid="gym-panel">
      <div className="gym-head">
        <nav className="gym-tabs" aria-label="Gym sections">
          {SECTIONS.map((t) => (
            <button key={t.id} className={`pill${section === t.id ? ' is-active' : ''}`} aria-current={section === t.id ? 'page' : undefined} onClick={() => setSection(t.id)} data-testid={`gym-tab-${t.id}`}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="gym-fresh" data-testid="gym-fresh">
          {read?.kind === 'shown' && status ? (
            <>
              {read.sample ? <State tone="warn">{GYM_READ_COPY.sample}</State> : null}
              {isStale(status, now) ? <State tone="warn">Old: reported {fmtAgo(status.generatedAt, now)}</State> : <span>Reported {fmtAgo(status.generatedAt, now)}</span>}
              {!read.sample ? (
                <button className="gym-link" onClick={() => setEditing((v) => !v)}>
                  {editing ? 'Done' : 'Connection…'}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      <div className="gym-body">
        {problem ? (
          <p className="gym-problem" role="status" data-testid="gym-problem">
            {problem}
          </p>
        ) : null}
        {showForm ? (
          <SettingsForm
            settings={settings}
            onSaved={() => {
              setEditing(false)
              setRead(null)
              setTick((n) => n + 1)
            }}
          />
        ) : null}
        {read === null ? <Empty>Reading the gym’s status…</Empty> : null}
        {status ? (
          section === 'now' ? (
            <NowSection s={status} now={now} />
          ) : section === 'rounds' ? (
            <RoundsSection s={status} />
          ) : section === 'data' ? (
            <DataSection s={status} />
          ) : status.hosts.length > 0 ? (
            <div className="gym-grid">
              {status.hosts.map((h) => (
                <HostCard key={h.id} h={h} now={now} />
              ))}
            </div>
          ) : (
            <Empty>The gym hasn’t reported on its computers.</Empty>
          )
        ) : null}
      </div>
    </div>
  )
}
