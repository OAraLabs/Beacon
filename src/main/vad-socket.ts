/**
 * The VAD WebSocket itself (hands-free mode, item 8). Its IPC half is ./vad-client.
 *
 * A module of its own so voice-gate-smoke can drive it against real sockets under
 * ELECTRON_RUN_AS_NODE, where there is no Electron API. Keep this file free of Electron and of
 * ./shell-windows. (Importing ./shell-windows from a smoke used to break the app: it moved the sender
 * check into a shared chunk, where it named the wrong page. That is fixed, and smoke:shell-url tests
 * it.)
 */

import WebSocket from 'ws'
import { VAD_PING_MESSAGE, VAD_RESET_MESSAGE, parseVadEvent, vadAudioMessage, type VadClientEvent } from '@shared/hands-free'
import { VOICE_CHECK_TIMEOUT_MS, badAnswerNotice, notAnsweringNotice, unreachableCause } from '@shared/voice-gate'

const PING_INTERVAL_MS = 20_000

export class VadClient {
  private ws: WebSocket | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private closedByUs = false

  constructor(
    private readonly url: string,
    private readonly onEvent: (ev: VadClientEvent) => void
  ) {}

  /**
   * Open the socket. Resolves once it is OPEN; rejects with a named reason if it closes first or has
   * not opened within `timeoutMs` (an offline tailnet host never refuses, it just never answers).
   *
   * A failure BEFORE open travels in the rejection only, never also as a `closed` event, so the
   * renderer sees ONE named failure. After open, a close is a `closed` event, as it always was.
   */
  connect(timeoutMs: number = VOICE_CHECK_TIMEOUT_MS): Promise<void> {
    // Never log this.url — it carries the token. `host` is host:port only.
    const host = new URL(this.url).host
    const ws = new WebSocket(this.url, { handshakeTimeout: timeoutMs })
    this.ws = ws
    let opened = false
    let timedOut = false
    return new Promise<void>((resolve, reject) => {
      // ws's handshakeTimeout should cover this; the timer makes the bound not depend on it.
      const timer = setTimeout(() => {
        if (opened) return
        timedOut = true
        ws.terminate()
      }, timeoutMs)
      ws.on('open', () => {
        opened = true
        clearTimeout(timer)
        this.onEvent({ type: 'open' })
        this.pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(VAD_PING_MESSAGE)
        }, PING_INTERVAL_MS)
        resolve()
      })
      ws.on('message', (data) => {
        const ev = parseVadEvent(data.toString())
        if (ev) this.onEvent({ type: 'event', event: ev })
      })
      ws.on('error', (err) => {
        // 'close' follows; carry the message there so the renderer sees ONE named failure.
        this.lastError = err instanceof Error ? err.message : String(err)
        this.lastErrorCause = err
      })
      ws.on('close', (code, reasonBuf) => {
        clearTimeout(timer)
        this.stopPing()
        // Verified live 2026-09-02: a wrong token is refused at the HANDSHAKE (HTTP 403 → 'ws' reports
        // "Unexpected server response: 403" and closes 1006), not with the 4401 close the service's
        // docstring describes. Both are the same fact to the user — name it once, the same way.
        const rejected = code === 4401 || /\b403\b/.test(this.lastError)
        if (!opened) {
          if (this.closedByUs) reject(new Error('hands-free was turned off before OAra Voice answered'))
          else if (rejected) reject(new Error(badAnswerNotice('listener', host, 403)))
          else {
            const cause = timedOut ? { name: 'TimeoutError' } : this.lastErrorCause ?? { message: `socket closed (${code})` }
            reject(new Error(notAnsweringNotice('listener', host, unreachableCause(cause, timeoutMs))))
          }
          return
        }
        if (this.closedByUs) return
        const reason = reasonBuf?.toString() || this.lastError || `socket closed (${code})`
        this.onEvent({ type: 'closed', code, reason: rejected ? 'token rejected — check the oara integration token' : reason })
      })
    })
  }
  private lastErrorCause: unknown = null
  private lastError = ''

  sendAudio(chunk: Float32Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(vadAudioMessage(chunk))
  }

  reset(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(VAD_RESET_MESSAGE)
  }

  close(): void {
    this.closedByUs = true
    this.stopPing()
    try {
      this.ws?.close(1000, 'hands-free off')
    } catch {
      /* already gone */
    }
    this.ws = null
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }
}

