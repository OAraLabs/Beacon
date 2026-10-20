import { useEffect, useRef, type ReactElement } from 'react'
import type { ConnectionStatus } from '@shared/ipc'
import { categorize, eventRowTs } from '@shared/gateway-events'
import { nextFrameDelay } from '@shared/armilla-pace'

// Armilla — the Mission landing hero, after Antonio Santucci's armillary sphere (Florence, 1593),
// successor to the flat Orrery. Nested great circles in orthographic 3D line-work: a STATIC stand
// (horizon dial + meridian — Beacon itself) holding a SPINNING celestial sphere (the daemon's sky:
// equator + ecliptic bands, colures, tropics, tilted axis) around the orchestrator core.
//
// MOTION IS TELEMETRY — nothing moves unless something is true:
//   sphere rate   work "heat": chat deltas / tool calls / gateway frames bump it, it decays (~6 s).
//                 Cold: one turn / 3 min. Hot: one turn / 24 s. The spin IS the effort.
//   core pulse    breath quickens with heat; a ripple rings out on every tool call.
//   ecliptic      one node per active session (sessions.list, refreshed each minute) — sanguine if
//     nodes       active in the last 30 min, lapis otherwise; longitude is a stable hash of the id.
//   horizon dial  a 24-hour ring: each signal event (events.recent backfill + live gateway frames)
//                 parks a tick at its hour; a sentinel/dream/skill/memory signal fires a comet lap.
//   link          connection.onStatus — link down freezes and dims the sky inside a crisp stand.
//
// Every colour is a token via .armilla-* classes in styles.css (lint:tokens-safe). One rAF loop
// drives the sky (auto-throttled when hidden), paced by @shared/armilla-pace: every display frame
// only while there is work to show; prefers-reduced-motion renders a static plate.

const TAU = Math.PI * 2
const EPSI = (23.5 * Math.PI) / 180 // obliquity — ecliptic tilt (and the tropics' latitude)
const YAW = 0.34, PITCH = -0.3, LEAN = 0.42 // viewing pose + celestial-axis lean (the classic stance)
const CXs = 450, CYs = 418, S = 252, RH = 1.3 // screen centre, sphere scale, horizon radius (×S)
const cy_ = Math.cos(YAW), sy_ = Math.sin(YAW)
const cp_ = Math.cos(PITCH), sp_ = Math.sin(PITCH)
const ct_ = Math.cos(LEAN), st_ = Math.sin(LEAN)

type P3 = [number, number, number]

/** world → screen [X, Y, depth>0 = toward viewer] (yaw about Y, pitch about X, orthographic). */
function proj(x: number, y: number, z: number): P3 {
  const x1 = x * cy_ + z * sy_
  const z1 = -x * sy_ + z * cy_
  const y2 = y * cp_ - z1 * sp_
  const z2 = y * sp_ + z1 * cp_
  return [CXs + S * x1, CYs - S * y2, z2]
}

/** celestial (axis = local Y) → world: spin about the axis by A, then lean the axis by LEAN. */
function skyP(p: P3, A: number): P3 {
  const [x, y, z] = p
  const xs = x * Math.cos(A) + z * Math.sin(A)
  const zs = -x * Math.sin(A) + z * Math.cos(A)
  return [xs * ct_ - y * st_, xs * st_ + y * ct_, zs]
}

/** Closed ring of projected points → front/back path strings, split by depth (occlusion dimming). */
function ringPath(pts: P3[]): { f: string; b: string } {
  let f = ''
  let b = ''
  let side: boolean | null = null
  for (let i = 0; i <= pts.length; i++) {
    const p = pts[i % pts.length]
    const s = p[2] >= 0
    const cmd = (s === side ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)
    if (s) f += cmd
    else b += cmd
    side = s
  }
  return { f, b }
}

const N = 120
const circle = (fn: (u: number) => P3): P3[] => Array.from({ length: N }, (_, i) => fn((i / N) * TAU))
const rotEps = ([x, y, z]: P3): P3 => [x * Math.cos(EPSI) - y * Math.sin(EPSI), x * Math.sin(EPSI) + y * Math.cos(EPSI), z]

// ── celestial features (unit sphere, axis = local Y) — constructed once, spun per frame ──
const EQ_A = circle((u) => [Math.cos(u), 0.03, Math.sin(u)])
const EQ_B = circle((u) => [Math.cos(u), -0.03, Math.sin(u)])
const ECL_A = circle((u) => rotEps([Math.cos(u), 0.03, Math.sin(u)]))
const ECL_B = circle((u) => rotEps([Math.cos(u), -0.03, Math.sin(u)]))
const TROP_N = circle((u) => [Math.cos(EPSI) * Math.cos(u), Math.sin(EPSI), Math.cos(EPSI) * Math.sin(u)])
const TROP_S = circle((u) => [Math.cos(EPSI) * Math.cos(u), -Math.sin(EPSI), Math.cos(EPSI) * Math.sin(u)])
const COL_1 = circle((u) => [Math.cos(u), Math.sin(u), 0])
const COL_2 = circle((u) => [0, Math.sin(u), Math.cos(u)])
const EQ_RUNGS: [P3, P3][] = Array.from({ length: 36 }, (_, i) => {
  const u = (i / 36) * TAU
  return [[Math.cos(u), 0.03, Math.sin(u)], [Math.cos(u), -0.03, Math.sin(u)]]
})
const ECL_TICKS: [P3, P3][] = Array.from({ length: 12 }, (_, i) => {
  const u = (i / 12) * TAU
  return [rotEps([0.94 * Math.cos(u), 0, 0.94 * Math.sin(u)]), rotEps([1.06 * Math.cos(u), 0, 1.06 * Math.sin(u)])]
})

// ── the stand (world frame — never moves) — projected ONCE at module load ──
const hourU = (h: number): number => (h / 24) * TAU
const STAND = ((): { f: string; b: string } => {
  const hor = ringPath(circle((u) => [RH * Math.cos(u), 0, RH * Math.sin(u)]).map((p) => proj(...p)))
  const mer = ringPath(circle((u) => [0, RH * Math.cos(u), RH * Math.sin(u)]).map((p) => proj(...p)))
  let tf = ''
  let tb = ''
  for (let i = 0; i < 48; i++) {
    const u = (i / 48) * TAU
    const o = i % 4 === 0 ? 0.055 : 0.028
    const A = proj(RH * Math.cos(u), 0, RH * Math.sin(u))
    const B = proj((RH + o) * Math.cos(u), 0, (RH + o) * Math.sin(u))
    const seg = `M${A[0].toFixed(1)} ${A[1].toFixed(1)}L${B[0].toFixed(1)} ${B[1].toFixed(1)}`
    if ((A[2] + B[2]) / 2 >= 0) tf += seg
    else tb += seg
  }
  return { f: hor.f + mer.f + tf, b: hor.b + mer.b + tb }
})()

/** Stable session-id → ecliptic longitude (nodes must not jump between refreshes). djb2. */
function longitudeOf(id: string): number {
  let h = 5381
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0
  return ((h >>> 0) % 3600) / 3600 * TAU
}

const SVGNS = 'http://www.w3.org/2000/svg'
const HOT_MS = 30 * 60 * 1000 // session "hot" window → sanguine node
const RATE_IDLE = TAU / 180, RATE_WORK = TAU / 24, RATE_LINKING = TAU / 300

export function Armilla() {
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const el = (k: string): SVGElement => svg.querySelector(`[data-k="${k}"]`) as SVGElement
    const pairs = ['eqA', 'eqB', 'eclA', 'eclB', 'tN', 'tS', 'c1', 'c2', 'eqR', 'eclT', 'ax'] as const
    const F: Record<string, SVGElement> = {}
    const B: Record<string, SVGElement> = {}
    pairs.forEach((k) => {
      F[k] = el(`${k}-f`)
      B[k] = el(`${k}-b`)
    })
    const core = el('core')
    const halo1 = el('halo1')
    const halo2 = el('halo2')
    const rippleG = el('ripples')
    const marksG = el('marks')
    const cronG = el('cron')
    const cometG = el('comet')
    const nodesFG = el('nodes-f')
    const nodesBG = el('nodes-b')

    // ── sim state (refs only — this component never re-renders) ──
    let A = 0.6
    let omega = RATE_IDLE
    let heat = 0
    let link: ConnectionStatus['state'] = 'idle'
    let limited = false // an approved device, not the owner (ConnectionStatus.role)
    let ripples: { t0: number; el: SVGCircleElement }[] = []
    let comet: { t0: number; u0: number } | null = null
    let dialHours: number[] = []
    let nodes: { p: P3; kind: 'a' | 'b'; dot: SVGCircleElement; halo: SVGCircleElement; g: SVGGElement }[] = []
    let flareIdx = 0
    let flareT = 0
    let lastT: number | null = null
    let raf = 0
    let pace: ReturnType<typeof setTimeout> | undefined
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

    const bump = (x: number): void => {
      heat = Math.min(1, heat + x)
    }
    const ripple = (): void => {
      if (reduced || ripples.length > 5) return
      const c = document.createElementNS(SVGNS, 'circle')
      c.setAttribute('class', 'armilla-ripple')
      c.setAttribute('cx', String(CXs))
      c.setAttribute('cy', String(CYs))
      rippleG.appendChild(c)
      ripples.push({ t0: performance.now(), el: c })
    }
    const hourOf = (ts: number): number => {
      const d = new Date(ts)
      return d.getHours() + d.getMinutes() / 60
    }

    /** Rebuild the horizon-dial signal ticks (stand frame — static screen positions). */
    const drawMarks = (): void => {
      let d = ''
      dialHours.forEach((h) => {
        const u = hourU(h)
        const a = proj(RH * 0.985 * Math.cos(u), 0, RH * 0.985 * Math.sin(u))
        const b = proj(RH * 1.015 * Math.cos(u), 0, RH * 1.015 * Math.sin(u))
        d += `M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}`
      })
      marksG.setAttribute('d', d)
    }

    /** Armed loops (harness sprint — /api/cron next_run) parked as diamonds at their firing hour.
     * The dial finally tells the truth it was designed for: schedules, not just history. */
    const drawCron = (hours: number[]): void => {
      cronG.innerHTML = hours
        .slice(0, 12)
        .map((h) => {
          const u = hourU(h)
          const P = proj(RH * Math.cos(u), 0, RH * Math.sin(u))
          const o = P[2] >= 0 ? 0.9 : 0.35
          return `<rect class="armilla-cronmark" x="${(P[0] - 4.5).toFixed(1)}" y="${(P[1] - 4.5).toFixed(1)}" width="9" height="9" transform="rotate(45 ${P[0].toFixed(1)} ${P[1].toFixed(1)})" opacity="${o}"/>`
        })
        .join('')
    }

    /** next_run arrives as ISO text or epoch (s or ms) depending on daemon vintage — accept all. */
    const cronTs = (raw: unknown): number => {
      if (typeof raw === 'number') return raw > 1e12 ? raw : raw * 1000
      if (typeof raw === 'string') {
        const t = Date.parse(raw)
        return Number.isFinite(t) ? t : 0
      }
      return 0
    }
    const loadCron = (): void => {
      const bb = window.beacon
      // An approved device may not read the schedule (Prometheus refuses /api/cron): no diamonds, and nothing asked.
      if (!bb || limited) return
      void bb.daemon
        .get('/api/cron')
        .then((d) => {
          const raw = Array.isArray(d) ? d : ((d as { jobs?: unknown[] } | null)?.jobs ?? [])
          const hours = (raw as { next_run?: unknown; enabled?: boolean }[])
            .filter((j) => j.enabled !== false)
            .map((j) => cronTs(j.next_run))
            .filter((t) => t > 0)
            .map(hourOf)
          drawCron(hours)
        })
        .catch(() => drawCron([]))
    }

    /** Rebuild session nodes (data change only; positions ride the sphere in draw()). */
    const setSessions = (rows: { id: string; lastActive?: number }[]): void => {
      nodes.forEach((n) => n.g.remove())
      const cutoff = Date.now() - HOT_MS
      nodes = rows
        .slice()
        .sort((a, b2) => (b2.lastActive ?? 0) - (a.lastActive ?? 0))
        .slice(0, 8)
        .map((s) => {
          const kind: 'a' | 'b' = (s.lastActive ?? 0) >= cutoff ? 'a' : 'b'
          const g = document.createElementNS(SVGNS, 'g')
          const halo = document.createElementNS(SVGNS, 'circle')
          halo.setAttribute('class', `armilla-nhalo-${kind}`)
          const dot = document.createElementNS(SVGNS, 'circle')
          dot.setAttribute('class', `armilla-node-${kind}`)
          g.appendChild(halo)
          g.appendChild(dot)
          nodesFG.appendChild(g)
          const L = longitudeOf(s.id)
          return { p: rotEps([Math.cos(L), 0, Math.sin(L)]), kind, dot, halo, g }
        })
      if (reduced) draw(performance.now())
    }

    const setPath = (k: string, pts: P3[]): void => {
      const { f, b } = ringPath(pts)
      F[k].setAttribute('d', f)
      B[k].setAttribute('d', b)
    }
    const setSegs = (k: string, segs: [P3, P3][]): void => {
      let f = ''
      let b = ''
      segs.forEach(([a, c]) => {
        const P = proj(...skyP(a, A))
        const Q = proj(...skyP(c, A))
        const seg = `M${P[0].toFixed(1)} ${P[1].toFixed(1)}L${Q[0].toFixed(1)} ${Q[1].toFixed(1)}`
        if ((P[2] + Q[2]) / 2 >= 0) f += seg
        else b += seg
      })
      F[k].setAttribute('d', f)
      B[k].setAttribute('d', b)
    }

    const draw = (now: number): void => {
      setPath('eqA', EQ_A.map((p) => proj(...skyP(p, A))))
      setPath('eqB', EQ_B.map((p) => proj(...skyP(p, A))))
      setPath('eclA', ECL_A.map((p) => proj(...skyP(p, A))))
      setPath('eclB', ECL_B.map((p) => proj(...skyP(p, A))))
      setPath('tN', TROP_N.map((p) => proj(...skyP(p, A))))
      setPath('tS', TROP_S.map((p) => proj(...skyP(p, A))))
      setPath('c1', COL_1.map((p) => proj(...skyP(p, A))))
      setPath('c2', COL_2.map((p) => proj(...skyP(p, A))))
      setSegs('eqR', EQ_RUNGS)
      setSegs('eclT', ECL_TICKS)
      {
        // axis + pole finials
        const P = proj(...skyP([0, 1.26, 0], A))
        const Q = proj(...skyP([0, -1.26, 0], A))
        const fin = (p: P3): string => `M${p[0] + 5} ${p[1]}A5 5 0 1 0 ${p[0] - 5} ${p[1]}A5 5 0 1 0 ${p[0] + 5} ${p[1]}`
        F.ax.setAttribute('d', `M${P[0].toFixed(1)} ${P[1].toFixed(1)}L${Q[0].toFixed(1)} ${Q[1].toFixed(1)}` + fin(P) + fin(Q))
      }
      // session nodes ride the ecliptic; while hot, a flare walks them
      nodes.forEach((n, i) => {
        const P = proj(...skyP(n.p, A))
        const front = P[2] >= 0
        const flared = heat > 0.5 && i === flareIdx
        ;(front ? nodesFG : nodesBG).appendChild(n.g)
        n.dot.setAttribute('cx', String(P[0]))
        n.dot.setAttribute('cy', String(P[1]))
        n.dot.setAttribute('r', String((front ? 4.5 : 3.2) + (flared ? 1.2 : 0)))
        n.dot.setAttribute('opacity', front ? '0.95' : '0.4')
        n.halo.setAttribute('cx', String(P[0]))
        n.halo.setAttribute('cy', String(P[1]))
        n.halo.setAttribute('r', String((front ? 8.5 : 6.5) + (flared ? 2.4 : 0)))
        n.halo.setAttribute('opacity', String((front ? 0.4 : 0.18) + (flared ? 0.35 : 0)))
      })
      // core breath — cadence follows heat; frozen when the link is down
      const down = link === 'failed' || link === 'idle'
      const w = down || reduced ? 0 : 0.09 * Math.sin((now / 1000) * (0.75 + 1.15 * heat) * TAU)
      core.setAttribute('r', String(10 * (1 + w)))
      halo1.setAttribute('r', String(19 * (1 + w * 0.7)))
      halo2.setAttribute('r', String(29 * (1 + w * 0.45)))
      // tool-call ripples
      ripples = ripples.filter((rp) => {
        const r = ((now - rp.t0) / 1000) * 120
        if (r > 230) {
          rp.el.remove()
          return false
        }
        rp.el.setAttribute('r', String(10 + r))
        rp.el.setAttribute('opacity', (0.45 * (1 - r / 230)).toFixed(3))
        return true
      })
      // comet lap on the horizon dial (a signal event just landed)
      if (comet) {
        const k = (now - comet.t0) / 2400
        if (k >= 1) {
          comet = null
          cometG.innerHTML = ''
        } else {
          let d = ''
          const u = comet.u0 + k * TAU
          for (let j = 0; j < 14; j++) {
            const uu = u - j * 0.035
            const P = proj(RH * Math.cos(uu), 0, RH * Math.sin(uu))
            const r = Math.max(0.6, 4.5 - j * 0.32)
            d += `<circle class="armilla-comet" cx="${P[0].toFixed(1)}" cy="${P[1].toFixed(1)}" r="${r.toFixed(1)}" opacity="${((P[2] >= 0 ? 1 : 0.45) * (1 - j / 15)).toFixed(2)}"/>`
          }
          cometG.innerHTML = d
        }
      }
    }

    const tick = (now: number): void => {
      if (lastT == null) lastT = now
      // A resting frame comes ~IDLE_FRAME_MS after the last; the cap only stops a jump after the
      // window was hidden.
      const dt = Math.min(0.25, (now - lastT) / 1000)
      lastT = now
      heat = Math.max(0, heat - dt / 6)
      const down = link === 'failed' || link === 'idle'
      const target = down ? 0 : link === 'connected' ? RATE_IDLE + (RATE_WORK - RATE_IDLE) * heat : RATE_LINKING
      omega += (target - omega) * Math.min(1, dt * 1.6)
      A += omega * dt
      svg.classList.toggle('down', down)
      if (heat > 0.5 && now - flareT > 800) {
        flareT = now
        flareIdx = nodes.length ? (flareIdx + 1) % nodes.length : 0
      }
      draw(now)
      const delay = nextFrameDelay({ heat, transients: ripples.length > 0 || comet !== null, focused: document.hasFocus() })
      if (delay === 0) raf = requestAnimationFrame(tick)
      // Still through rAF after the wait, so the write lands on a frame and a hidden window draws nothing.
      else pace = setTimeout(() => (raf = requestAnimationFrame(tick)), delay)
    }

    // ── telemetry bindings (window.beacon may be absent in a bare-web preview → static idle sky) ──
    const b = window.beacon
    const unsubs: (() => void)[] = []
    if (b) {
      // The schedule is read once the role is known (an approved device is not asked), then every 5 minutes.
      void b.connection.status().then((s) => {
        link = s.state
        limited = s.role === 'limited'
        loadCron()
      }).catch(() => undefined)
      unsubs.push(
        b.connection.onStatus((s) => {
          link = s.state
          const was = limited
          limited = s.role === 'limited'
          if (was && !limited) loadCron() // made an owner: the schedule is its to see now
        })
      )
      unsubs.push(
        b.chat.onStream((f) => {
          if (f.kind === 'delta') bump(0.25)
          else if (f.kind === 'tool_start') {
            bump(0.5)
            ripple()
          } else if (f.kind === 'done') bump(0.1)
        })
      )
      unsubs.push(
        b.events.onGateway((ev) => {
          bump(0.35)
          const cat = categorize(ev.type)
          if (cat === 'tool') ripple()
          if (cat === 'signal') comet = { t0: performance.now(), u0: hourU(hourOf(ev.ts)) }
          dialHours.push(hourOf(ev.ts))
          if (dialHours.length > 40) dialHours = dialHours.slice(-40)
          drawMarks()
        })
      )
      void b.events
        .recent(48)
        .then((rows) => {
          const dayAgo = Date.now() - 24 * 3600 * 1000
          dialHours = rows
            .map((r) => eventRowTs(r.timestamp))
            .filter((t) => t >= dayAgo)
            .map(hourOf)
          drawMarks()
        })
        .catch(() => undefined)
      const loadSessions = (): void => {
        void b.sessions
          .list()
          .then(setSessions)
          .catch(() => undefined)
      }
      loadSessions()
      const iv = setInterval(loadSessions, 60_000)
      unsubs.push(() => clearInterval(iv))
      const cronIv = setInterval(loadCron, 300_000) // schedules move slowly — 5 min is honest enough
      unsubs.push(() => clearInterval(cronIv))
    }

    if (reduced) draw(performance.now())
    else raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(pace)
      unsubs.forEach((u) => u())
    }
  }, [])

  const pairPaths = (k: string, cls: string): ReactElement[] => [
    <path key={`${k}-b`} data-k={`${k}-b`} className={`armilla-b ${cls}`} />,
    <path key={`${k}-f`} data-k={`${k}-f`} className={`armilla-f ${cls}`} />
  ]

  return (
    <div style={{ padding: '16px 18px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
      <div className="armilla-head">ARMILLA — DAEMON TELEMETRY</div>
      <div className="armilla-cap">
        After Santucci, 1593. The stand is Beacon; the spinning sky is the daemon — its rate is live work, the
        horizon dial carries the day's signals and its armed loops. Nothing moves unless something is true.
      </div>
      <svg ref={svgRef} className="armilla-svg" viewBox="0 0 900 860" role="img" aria-label="Armilla — telemetry-driven armillary sphere">
        <path className="armilla-stand-b" d={STAND.b} />
        <g data-k="sky" className="armilla-sky">
          <g>
            {pairPaths('eqA', '')}
            {pairPaths('eqB', '')}
            {pairPaths('eqR', 'faint')}
            {pairPaths('eclA', 'strong')}
            {pairPaths('eclB', 'strong')}
            {pairPaths('eclT', 'strong')}
            {pairPaths('tN', 'faint')}
            {pairPaths('tS', 'faint')}
            {pairPaths('c1', '')}
            {pairPaths('c2', '')}
            {pairPaths('ax', 'strong')}
          </g>
          <g data-k="nodes-b" />
        </g>
        <g data-k="ripples" />
        <circle data-k="halo2" className="armilla-halo" cx={CXs} cy={CYs} opacity={0.22} />
        <circle data-k="halo1" className="armilla-halo" cx={CXs} cy={CYs} opacity={0.55} />
        <circle data-k="core" className="armilla-core" cx={CXs} cy={CYs} />
        <text className="armilla-label" x={CXs} y={CYs + 78} textAnchor="middle">
          ORCHESTRATOR
        </text>
        <g data-k="nodes-f" />
        <path className="armilla-stand-f" d={STAND.f} />
        <path data-k="marks" className="armilla-mark" />
        <g data-k="cron" />
        <g data-k="comet" />
      </svg>
    </div>
  )
}
