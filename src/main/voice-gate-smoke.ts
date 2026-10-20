/**
 * voice-gate smoke: the parts of "no voice without OAra, and never a mic prompt for a broken setup"
 * that can be proven without a window.
 *
 *   1. ONE predicate decides configured, and main's refusal and the renderer's visibility both use it.
 *   2. The pre-microphone checks REFUSE, with a named reason, when OAra Voice is down, silent,
 *      refusing the token, or answering with an error, and PASS when it answers. Both checks, the
 *      bridge's HTTP one and the VAD socket's open, are driven against real sockets this smoke
 *      owns: a refused port, a server that never answers, a 403 handshake, a working server. Every
 *      error below is one Node or `ws` actually raised, not one written to look like it.
 *   3. The Electron IPC wrapper comes off a voice error, and nothing else does.
 *
 * What it cannot prove: that the renderer asks for the mic only AFTER these checks, that the
 * controls are absent on a fresh install, or that the notice paints on Home and clears on a session
 * change. Those are rendered behaviour; scripts/voice-gate-probe.mjs drives the built app for them.
 *
 * The verdict runs on process 'exit' with an exact check count, so an early return or a throw
 * cannot pass for a clean run.
 */
import { createServer, type Server } from 'node:http'
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import {
  OARA_CHECK_PATH,
  VOICE_NOT_CONNECTED,
  ipcErrorMessage,
  oaraEntry,
  unreachableCause
} from '@shared/voice-gate'
import type { IntegrationEntry } from '@shared/integrations'
import { checkOaraBridge } from './oara-check'
import { VadClient } from './vad-socket'
import type { VadClientEvent } from '@shared/hands-free'

const EXPECTED_CHECKS = 39
let checks = 0
let failures = 0
function check(ok: boolean, what: string, detail = ''): void {
  checks += 1
  console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'}  ${what}${detail && !ok ? `\n        ${detail}` : ''}`)
  if (!ok) failures += 1
}
process.on('exit', () => {
  if (checks !== EXPECTED_CHECKS) {
    console.log(`\n[smoke] RESULT: INCOMPLETE — ${checks} checks ran, expected ${EXPECTED_CHECKS}`)
    process.exitCode = 1
    return
  }
  console.log(`\n[smoke] RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks}`)
  process.exitCode = failures === 0 ? 0 : 1
})

/** How a call ended: null when it resolved, else its error message. Bounded from OUTSIDE, so a check
 *  whose own timeout is broken FAILS with a message instead of hanging the run (a hang reports
 *  nothing at all, which reads like nothing wrong). */
async function rejection(p: Promise<unknown>, ms = 5000): Promise<string | null> {
  const bound = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`smoke: no outcome within ${ms} ms`)), ms).unref()
  })
  try {
    await Promise.race([p, bound])
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}
const listen = (s: Server | TcpServer): Promise<number> =>
  new Promise((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)))
/** A port nothing listens on: bind one, note it, close it. */
async function deadPort(): Promise<number> {
  const s = createTcpServer()
  const port = await listen(s)
  await new Promise((r) => s.close(r))
  return port
}

const entry = (over: Partial<IntegrationEntry>): IntegrationEntry => ({
  id: 'oara',
  name: 'OAra Voice',
  baseUrl: 'http://127.0.0.1:8015',
  authRef: 'none',
  enabled: true,
  ...over
})

async function main(): Promise<void> {
  // The first version of this smoke imported VadClient and checkOaraBridge from the IPC modules,
  // which moved ./shell-windows into a shared chunk and broke the sender check (the app sat on
  // "Loading…"). Its section 0 then guarded the build output for that. The check no longer depends
  // on which chunk it lands in, and smoke:shell-url tests it from one on every build.

  // ── 1. configured is one predicate ────────────────────────────────────────────────────────────
  console.log('\n[smoke] === 1. configured ===')
  check(oaraEntry([]) === null, 'no integrations.json (an empty registry) → not configured')
  check(oaraEntry([entry({})])?.id === 'oara', 'an enabled oara entry → configured')
  check(oaraEntry([entry({ enabled: false })]) === null, 'a disabled oara entry → not configured')
  check(oaraEntry([entry({ id: 'other' })]) === null, 'an entry with another id → not configured')

  // Both callers go through it. Comments stripped: the comment explaining a predicate names it.
  const code = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const voiceSrc = code(readFileSync(join(process.cwd(), 'src/main/voice.ts'), 'utf8'))
  const resolveBody = voiceSrc.slice(voiceSrc.indexOf('export function resolveOaraEndpoint'), voiceSrc.indexOf('export function registerVoiceHandlers'))
  check(/oaraEntry\(registry\(\)\)/.test(resolveBody) && /throw new Error\(VOICE_NOT_CONNECTED\)/.test(resolveBody), "main's refusal (resolveOaraEndpoint) decides with oaraEntry")
  check(/handleFromShell\(IPC\.VOICE_CONFIGURED,[^\n]*oaraEntry\(registry\(\)\) !== null/.test(voiceSrc), "the renderer's visibility answer (VOICE_CONFIGURED) decides with the same oaraEntry")
  check(!/\.id === ['"]oara['"]/.test(voiceSrc), 'main has no second copy of the id test')

  // ── 2a. the bridge check (HTTP), BEFORE the mic ──────────────────────────────────────────────
  console.log('\n[smoke] === 2a. the bridge check ===')
  const refused = await deadPort()
  const r1 = await rejection(checkOaraBridge(`http://127.0.0.1:${refused}`, null, 1000))
  check(r1 !== null, 'a bridge that is down → the check refuses')
  check(r1 === `OAra Voice is not answering at 127.0.0.1:${refused} (bridge: connection refused) — the microphone was not opened`, 'it names the host and the cause, and says the mic stayed shut', String(r1))

  // A server that accepts and never answers — an offline tailnet host behaves like this, not like a
  // refused port. The check must end on its own bound.
  const silent = createServer(() => undefined)
  const silentPort = await listen(silent)
  const t0 = Date.now()
  const r2 = await rejection(checkOaraBridge(`http://127.0.0.1:${silentPort}`, null, 1000))
  const took = Date.now() - t0
  check(r2 === `OAra Voice is not answering at 127.0.0.1:${silentPort} (bridge: no answer within 1 s) — the microphone was not opened`, 'a bridge that never answers → refused as a timeout', String(r2))
  check(took >= 900 && took < 3000, `…and the check ends at its bound (${took} ms for a 1000 ms bound)`)
  silent.closeAllConnections()
  silent.close()

  const seen: { path?: string; auth?: string }[] = []
  let status = 200
  const bridge = createServer((req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization })
    res.statusCode = status
    res.end('{}')
  })
  const bridgePort = await listen(bridge)
  const up = `http://127.0.0.1:${bridgePort}`
  check((await rejection(checkOaraBridge(up, 'tkn', 1000))) === null, 'a bridge that answers 200 → the check passes')
  check(seen[0]?.path === OARA_CHECK_PATH, `…having asked ${OARA_CHECK_PATH}, the discovery endpoint`, JSON.stringify(seen[0]))
  check(seen[0]?.auth === 'Bearer tkn', '…with the stored bearer')
  await checkOaraBridge(up, null, 1000)
  check(seen[1]?.auth === undefined, 'no token → no Authorization header')
  status = 401
  const r3 = await rejection(checkOaraBridge(up, 'bad', 1000))
  check(r3 !== null && /refused the token/.test(r3) && /HTTP 401/.test(r3) && /microphone was not opened/.test(r3), 'a 401 → refused, naming the token', String(r3))
  status = 404
  const r4 = await rejection(checkOaraBridge(up, null, 1000))
  check(r4 === `OAra Voice answered HTTP 404 (bridge at 127.0.0.1:${bridgePort}) — the microphone was not opened`, 'a 404 (not an OAra bridge) → refused, naming the status', String(r4))
  status = 503
  check((await rejection(checkOaraBridge(up, null, 1000))) !== null, 'a 503 → refused')
  bridge.close()

  // ── 2b. the listener check (the VAD socket must OPEN), BEFORE the mic ────────────────────────
  console.log('\n[smoke] === 2b. the listener check ===')
  const connectTo = (url: string): { events: VadClientEvent[]; client: VadClient; done: Promise<string | null> } => {
    const events: VadClientEvent[] = []
    const client = new VadClient(url, (ev) => events.push(ev))
    return { events, client, done: rejection(client.connect(1000)) }
  }
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150))

  const deadVad = await deadPort()
  const a = connectTo(`ws://127.0.0.1:${deadVad}/vad/stream?token=secret-token`)
  const aErr = await a.done
  await settle()
  check(aErr !== null, 'a listener that is down → connect() REJECTS (it used to return at once and report later)')
  check(aErr === `OAra Voice is not answering at 127.0.0.1:${deadVad} (listener: connection refused) — the microphone was not opened`, '…with the host, the cause, and the mic left shut', String(aErr))
  check(!String(aErr).includes('secret-token'), '…and never the URL, which carries the token')
  check(a.events.length === 0, 'the failure travels ONCE, in the rejection — no `closed` event as well', JSON.stringify(a.events))

  const forbid = createServer((_req, res) => {
    res.statusCode = 404
    res.end()
  })
  forbid.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
  })
  const forbidPort = await listen(forbid)
  const b = connectTo(`ws://127.0.0.1:${forbidPort}/vad/stream?token=wrong`)
  const bErr = await b.done
  check(bErr !== null && /refused the token/.test(bErr) && /listener at 127\.0\.0\.1:/.test(bErr), 'a listener that refuses the token (403 at the handshake) → refused, naming the token', String(bErr))
  forbid.close()

  const hang = createTcpServer(() => undefined) // accepts TCP, never answers the upgrade
  const hangPort = await listen(hang)
  const t1 = Date.now()
  const c = connectTo(`ws://127.0.0.1:${hangPort}/vad/stream`)
  const cErr = await c.done
  const cTook = Date.now() - t1
  check(cErr === `OAra Voice is not answering at 127.0.0.1:${hangPort} (listener: no answer within 1 s) — the microphone was not opened`, 'a listener that never answers → refused as a timeout', String(cErr))
  check(cTook >= 900 && cTook < 3000, `…at its bound (${cTook} ms for a 1000 ms bound)`)
  hang.close()

  const vad = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((r) => vad.once('listening', r))
  const vadPort = (vad.address() as AddressInfo).port
  const d = connectTo(`ws://127.0.0.1:${vadPort}/vad/stream`)
  check((await d.done) === null, 'a listener that accepts → connect() resolves')
  check(d.events.length === 1 && d.events[0].type === 'open', '…having reported `open` before resolving', JSON.stringify(d.events))
  // After open, a close is a `closed` event as it always was (the renderer's live path).
  for (const s of vad.clients) s.close(1011, 'service restarting')
  await settle()
  const closed = d.events.find((e) => e.type === 'closed') as Extract<VadClientEvent, { type: 'closed' }> | undefined
  check(closed?.reason === 'service restarting', 'a close AFTER open still arrives as a `closed` event with its reason', JSON.stringify(d.events))
  const e2 = connectTo(`ws://127.0.0.1:${vadPort}/vad/stream`)
  await e2.done
  e2.client.close()
  await settle()
  check(!e2.events.some((e) => e.type === 'closed'), 'a close WE make (hands-free off) is not reported as a failure')
  vad.close()

  // ── 2c. the causes, from real errors ─────────────────────────────────────────────────────────
  console.log('\n[smoke] === 2c. causes ===')
  const realRefused = await fetch(`http://127.0.0.1:${await deadPort()}/`).then(() => null, (err: unknown) => err)
  check(unreachableCause(realRefused) === 'connection refused', "Node fetch's refusal (cause.code) → connection refused", String((realRefused as { cause?: { code?: string } })?.cause?.code))
  const quiet = createServer(() => undefined)
  const quietPort = await listen(quiet)
  const realTimeout = await fetch(`http://127.0.0.1:${quietPort}/`, { signal: AbortSignal.timeout(200) }).then(() => null, (err: unknown) => err)
  check(unreachableCause(realTimeout, 4000) === 'no answer within 4 s', "AbortSignal.timeout's TimeoutError → no answer within N s", String((realTimeout as Error)?.name))
  quiet.closeAllConnections()
  quiet.close()
  const realDns = await fetch('http://voice-gate-smoke.invalid/').then(() => null, (err: unknown) => err)
  check(unreachableCause(realDns) === 'host not found', 'a name that does not resolve → host not found', String((realDns as { cause?: { code?: string } })?.cause?.code))
  check(unreachableCause({ message: 'socket hang up' }) === 'socket hang up', 'an unrecognised failure keeps its own words')

  // ── 3. the IPC wrapper comes off ─────────────────────────────────────────────────────────────
  console.log('\n[smoke] === 3. the IPC wrapper ===')
  // The exact shape Electron's ipcRenderer.invoke rejects with (lib/renderer/api/ipc-renderer.ts:
  // `Error invoking remote method '${channel}': ${error}`, where error is main's err.toString()).
  // voice-gate-probe reads the live one off a real invoke and holds this function to it.
  const wrapped = new Error(`Error invoking remote method 'vad:start': Error: ${VOICE_NOT_CONNECTED}`)
  check(ipcErrorMessage(wrapped, 'x') === VOICE_NOT_CONNECTED, "the wrapper and main's `Error: ` are stripped", ipcErrorMessage(wrapped, 'x'))
  const typed = new Error("Error invoking remote method 'voice:preflight': TypeError: fetch failed")
  check(ipcErrorMessage(typed, 'x') === 'fetch failed', 'a TypeError from main is unwrapped the same way')
  const plain = new Error('Microphone unavailable: Error: nested words stay')
  check(ipcErrorMessage(plain, 'x') === plain.message, 'an error that did not cross IPC is left exactly as it is')
  check(ipcErrorMessage('not an Error', 'fallback') === 'fallback', 'a non-Error → the fallback')
  check(ipcErrorMessage(new Error("Error invoking remote method 'vad:start': Error: "), 'fallback') === 'fallback', 'a wrapper around nothing → the fallback, never an empty notice')
  check(ipcErrorMessage(new DOMException('Permission denied', 'NotAllowedError'), 'x') === 'Permission denied', "a denied mic's DOMException keeps its message")
}

// Exit explicitly: a socket left open by a failing check must not keep the run (and verify) alive.
main().then(
  () => process.exit(),
  (err) => {
    console.log(`[smoke] FAIL  threw: ${err instanceof Error ? err.stack : String(err)}`)
    failures += 1
    process.exit()
  }
)
