import WebSocket from 'ws'
import { openGatewayWebSocket } from '../tls-pin'
import type { WsTestResult } from '@shared/ipc'
import { wsAuthFrame, WS_CLOSE_UNAUTHORIZED } from '@shared/daemon-api'

const PROBE_TIMEOUT_MS = 6_000

/**
 * One-shot WebSocket first-frame-auth probe for the Connection-Settings "Test" button — the socket
 * counterpart to the REST `GET /api/status` probe. Opens `wsUrl`, sends `{type:"auth",token}` if a
 * token is given, and resolves to:
 *   - 'ok'           — the daemon's `{type:"connected"}` welcome arrived (auth accepted, or auth off)
 *   - 'unauthorized' — the daemon closed the socket 4401 (token missing/rejected)
 *   - 'unreachable'  — connect error or timeout (wrong URL / daemon down)
 *
 * Standalone (not GatewaySocket) so it has no reconnect/backoff and can't disturb the live link.
 * Always resolves once and tears the socket down — never rejects.
 */
export function probeWsAuth(
  wsUrl: string,
  token: string | null,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<WsTestResult> {
  return new Promise<WsTestResult>((resolve) => {
    let settled = false
    let ws: WebSocket
    try {
      ws = openGatewayWebSocket(wsUrl)
    } catch (e) {
      const refused = /^refused:/.test((e as Error)?.message ?? '')
      resolve({ ok: false, state: 'unreachable', label: refused ? 'WS: refused (this Prometheus is reached by its pinned key)' : 'WS: bad URL' })
      return
    }

    const finish = (r: WsTestResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.removeAllListeners()
        // Closing a socket that is still connecting makes `ws` emit 'error' ("closed before the connection was established"), and an
        // emitter with no 'error' listener throws: on a timeout that took the main process down to a native error dialog. Detached
        // from the probe, not from Node's error contract (the live socket's retire() does the same).
        ws.on('error', () => undefined)
        ws.close()
      } catch {
        /* already closing */
      }
      resolve(r)
    }

    const timer = setTimeout(
      () => finish({ ok: false, state: 'unreachable', label: 'WS: no response (timeout)' }),
      timeoutMs
    )

    ws.on('open', () => {
      if (token) {
        try {
          ws.send(JSON.stringify(wsAuthFrame(token)))
        } catch {
          finish({ ok: false, state: 'unreachable', label: 'WS: send failed' })
        }
      }
      // No token: the daemon either has auth off (welcome arrives) or will close 4401 — both
      // are handled by the message/close listeners below.
    })

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as { type?: string }
        if (msg.type === 'connected') finish({ ok: true, state: 'ok', label: 'WS: authenticated ✓' })
      } catch {
        /* ignore non-JSON */
      }
    })

    ws.on('close', (code: number) => {
      if (code === WS_CLOSE_UNAUTHORIZED) {
        finish({ ok: false, state: 'unauthorized', label: 'WS: 4401 — token rejected' })
      } else {
        finish({ ok: false, state: 'unreachable', label: 'WS: closed before auth' })
      }
    })

    ws.on('error', () => finish({ ok: false, state: 'unreachable', label: 'WS: could not connect' }))
  })
}
