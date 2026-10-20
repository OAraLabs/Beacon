import { successPct, rateColor } from '@shared/daemon-api'
import { useState, type CSSProperties } from 'react'
import { useGateway } from '../gateway-store'
import { fmtLatency, type ToolCallRecord } from '@shared/gateway-events'

// Tool Call Feed (Phase 5a) — ported from the web ToolCallFeed: the tool_call_start/end frames the
// store already pairs → name, inputs, success/error, latency, expandable. Inline-styled (no Tailwind,
// no lucide). gemma's sessions_list circuit-breaker errors show up here as failed rows.

const MONO = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'

function safeJson(v: unknown): string {
  try {
    return v == null ? '' : JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}
function summarizeInputs(inputs: unknown): string {
  if (inputs == null) return '(no inputs)'
  if (typeof inputs !== 'object') return String(inputs)
  const entries = Object.entries(inputs as Record<string, unknown>)
  if (entries.length === 0) return '(no inputs)'
  return entries
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v)
      return `${k}: ${s.length > 50 ? `${s.slice(0, 50)}…` : s}`
    })
    .join(', ')
}

const panel: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }
const head: CSSProperties = {
  padding: '10px 16px',
  borderBottom: '1px solid var(--c-line)',
  background: 'var(--c-raise)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexShrink: 0
}
const input: CSSProperties = {
  fontSize: 12,
  padding: '5px 9px',
  borderRadius: 6,
  border: '1px solid var(--c-line)',
  background: 'var(--c-base)',
  color: 'var(--c-text)',
  outline: 'none',
  width: 180
}
const detail = (isError?: boolean): CSSProperties => ({
  margin: 0,
  fontFamily: MONO,
  fontSize: 12,
  padding: 10,
  borderRadius: 8,
  overflow: 'auto',
  maxHeight: 200,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  background: isError ? 'var(--c-err-soft)' : 'var(--c-base)',
  color: isError ? 'var(--c-err)' : 'var(--c-text-dim)',
  border: `1px solid ${isError ? 'var(--c-err)' : 'var(--c-line)'}`
})

function Detail({ label, content, isError }: { label: string; content: string; isError?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--c-text-faint)', marginBottom: 4 }}>{label}</div>
      <pre style={detail(isError)}>{content}</pre>
    </div>
  )
}

function ToolCallRow({ tc }: { tc: ToolCallRecord }) {
  const [open, setOpen] = useState(false)
  const pending = tc.success === undefined
  const color = pending ? 'var(--c-arc)' : tc.success ? 'var(--c-ok)' : 'var(--c-err)'
  return (
    <div style={{ borderBottom: '1px solid var(--c-line)' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 16px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', font: 'inherit' }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: color,
            boxShadow: pending ? 'var(--glow-arc)' : 'none',
            animation: pending ? 'pulse 1.2s ease-in-out infinite' : undefined,
            flexShrink: 0
          }}
          aria-label={pending ? 'running' : tc.success ? 'ok' : 'failed'}
        />
        <span style={{ flex: 1, fontFamily: MONO, fontSize: 13, color: 'var(--c-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {tc.toolName}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--c-text-dim)', flexShrink: 0 }}>{fmtLatency(tc.latencyMs)}</span>
        <span style={{ fontSize: 10, color: 'var(--c-text-faint)', flexShrink: 0 }}>{open ? '▾' : '▸'}</span>
      </button>
      <div style={{ padding: '0 16px 6px 38px' }}>
        <div style={{ fontSize: 11, color: 'var(--c-text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summarizeInputs(tc.inputs)}
        </div>
      </div>
      {open ? (
        <div style={{ padding: '0 16px 12px 38px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Detail label="Inputs" content={safeJson(tc.inputs)} />
          {tc.result ? <Detail label="Result" content={tc.result} /> : null}
          {tc.error ? <Detail label="Error" content={tc.error} isError /> : null}
        </div>
      ) : null}
    </div>
  )
}

export function ToolCallFeed() {
  const { toolCalls } = useGateway()
  const [filter, setFilter] = useState('')
  const filtered = filter ? toolCalls.filter((tc) => tc.toolName.toLowerCase().includes(filter.toLowerCase())) : toolCalls
  const ok = toolCalls.filter((tc) => tc.success === true).length
  const err = toolCalls.filter((tc) => tc.success === false).length
  const running = toolCalls.filter((tc) => tc.success === undefined).length

  const done = ok + err
  const okPct = successPct(ok, done)

  // HUD stat cell (Slice 4): caps label over a mono tabular value.
  const stat = (label: string, value: string, color = 'var(--c-text)') => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 'var(--track-caps)', color: 'var(--c-text-faint)' }}>
        {label}
      </span>
      <span style={{ fontFamily: MONO, fontSize: 14, fontVariantNumeric: 'tabular-nums', color }}>{value}</span>
    </div>
  )

  return (
    <div style={panel}>
      <div style={head}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                    {stat('calls', String(toolCalls.length))}
          {stat('ok', String(ok), 'var(--c-ok)')}
          {stat('err', String(err), err > 0 ? 'var(--c-err)' : 'var(--c-text)')}
          {running > 0 ? stat('live', String(running), 'var(--c-arc)') : null}
          {okPct !== null ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 90 }}>
              <span style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 'var(--track-caps)', color: 'var(--c-text-faint)' }}>
                success {okPct}%
              </span>
              <div style={{ height: 2, borderRadius: 1, background: 'var(--c-line)', overflow: 'hidden' }}>
                <div style={{ width: `${okPct}%`, height: '100%', background: rateColor(okPct) }} />
              </div>
            </div>
          ) : null}
        </div>
        <input style={input} placeholder="Filter tools…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '64px 16px', color: 'var(--c-text-dim)', fontSize: 13 }}>
            {toolCalls.length === 0 ? 'No tool calls yet — waiting for Prometheus events' : 'No matches'}
          </div>
        ) : (
          filtered.map((tc) => <ToolCallRow key={tc.callId} tc={tc} />)
        )}
      </div>
    </div>
  )
}
