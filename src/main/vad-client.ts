/**
 * VAD client — main half of hands-free mode (item 8).
 *
 * THE PROCESS SPLIT IS THE SAME HARD CONSTRAINT AS VOICE TURNS: the mic lives in the renderer,
 * but the VAD service's URL carries the oara bearer (`?token=` — the service's own convention,
 * close 4401 on mismatch), and the renderer must never see that token. So main owns the
 * WebSocket to `ws://<oara-host>:<vadPort>/vad/stream` (8012 unless the oara entry names one); the renderer streams 512-sample float32
 * chunks over IPC (fire-and-forget, ~31 messages/s), main forwards them, and the service's
 * `speech_start` / `speech_end` come back to the renderer as VAD_EVENT.
 *
 * One client per renderer window. Loud-failure law: a close (any code, incl. 4401) is reported
 * with its code and reason; nothing here reconnects silently — the renderer decides.
 *
 * VAD_START RESOLVES ONLY ONCE THE SOCKET IS OPEN. The renderer awaits it before it asks for the
 * microphone, so a listener that is down, silent, or refusing the token is named without the OS mic
 * prompt ever appearing (see @shared/voice-gate).
 */

import type { WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import { vadUrl } from '@shared/hands-free'
import { resolveOaraEndpoint } from './voice'
import { handleFromShell, onFromShell } from './shell-windows'
import { VadClient } from './vad-socket'

const clients = new Map<number, VadClient>() // webContents.id → client

export function registerHandsFreeHandlers(): void {
  handleFromShell(IPC.VAD_START, async (e) => {
    const sender: WebContents = e.sender
    clients.get(sender.id)?.close()
    const { baseUrl, token, vadPort } = resolveOaraEndpoint() // throws a NAMED error when oara is not connected
    const client = new VadClient(vadUrl(baseUrl, token, vadPort), (ev) => {
      if (!sender.isDestroyed()) sender.send(IPC.VAD_EVENT, ev)
      if (ev.type === 'closed') clients.delete(sender.id)
    })
    clients.set(sender.id, client)
    try {
      await client.connect()
    } catch (err) {
      if (clients.get(sender.id) === client) clients.delete(sender.id)
      throw err
    }
    return true
  })
  handleFromShell(IPC.VAD_STOP, async (e) => {
    clients.get(e.sender.id)?.close()
    clients.delete(e.sender.id)
    return true
  })
  handleFromShell(IPC.VAD_RESET, async (e) => {
    clients.get(e.sender.id)?.reset()
    return true
  })
  // Audio is fire-and-forget: ~31 chunks/s, an invoke round-trip per chunk would be waste.
  onFromShell(IPC.VAD_AUDIO, (e, chunk: ArrayBuffer | Uint8Array | Float32Array) => {
    const client = clients.get(e.sender.id)
    if (!client) return
    const f32 =
      chunk instanceof Float32Array
        ? chunk
        : chunk instanceof Uint8Array
          ? new Float32Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 4))
          : new Float32Array(chunk)
    client.sendAudio(f32)
  })
}
