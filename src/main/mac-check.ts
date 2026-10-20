// Can Prometheus be set up on this Mac? — the main-process half (the decision is @shared/mac-check).
//
// Gathers the facts (the chip, macOS, free space where Prometheus would go, memory) and finds out whether a Prometheus
// already answers on this Mac. That second question asks THREE ways, in the order settled with the installer session,
// stopping at the first that says yes, and every ask is the same safe GET discovery uses (no credential, no redirect,
// at most 4 KiB read), on 127.0.0.1 only:
//   1. GET /api/hello             the discovery hello (P5, not built yet);
//   2. GET /api/setup/status      a daemon in setup mode (unauthenticated; carries `version`);
//   3. GET /api/status            a configured daemon answers 401 {"error":"unauthorized ... Bearer ..."}.
import { statfs } from 'node:fs/promises'
import { homedir, totalmem } from 'node:os'
import {
  configuredRunning,
  macFactsOverride,
  setupStatusRunning,
  type MacFacts,
  type RunningHere
} from '@shared/mac-check'
import { mergeSightings } from '@shared/discovery'
import { askHello, fetchSmall } from './discovery'

const json = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Is a Prometheus already answering on this Mac at `port`? */
export async function detectRunningHere(port: number): Promise<RunningHere | null> {
  const endpoint = { host: '127.0.0.1', port }
  const hello = await askHello(endpoint)
  if (typeof hello !== 'string') {
    const [computer] = mergeSightings([{ source: 'loopback', endpoint, hello }])
    return { kind: 'hello', computer }
  }
  const base = `http://127.0.0.1:${port}`
  const setup = await fetchSmall(`${base}/api/setup/status`)
  if (typeof setup !== 'string') {
    const r = setupStatusRunning(setup.status, json(setup.text))
    if (r) return r
  }
  const status = await fetchSmall(`${base}/api/status`)
  if (typeof status !== 'string') return configuredRunning(status.status, json(status.text))
  return null
}

export interface MacCheckDeps {
  port: number
  /** `process.getSystemVersion()`: injected, because it exists only inside Electron. */
  systemVersion: string | null
  /** BEACON_MAC_CHECK, already gated by the build flavour. */
  env: Readonly<Record<string, string | undefined>>
  allowOverride: boolean
  platform?: string
  arch?: string
  home?: string
}

/** The facts of this Mac, with a dev or probe build's overrides laid over them. A fact that cannot be read is null. */
export async function gatherMacFacts(deps: MacCheckDeps): Promise<MacFacts> {
  let freeBytes: number | null = null
  try {
    const s = await statfs(deps.home ?? homedir())
    freeBytes = Number(s.bavail) * Number(s.bsize)
  } catch {
    // Unknown is not "none": it does not block anyone.
  }
  const real: Omit<MacFacts, 'running' | 'port'> = {
    platform: deps.platform ?? process.platform,
    arch: deps.arch ?? process.arch,
    macos: deps.systemVersion,
    freeBytes,
    memoryBytes: totalmem()
  }
  const facts = { ...real, ...macFactsOverride(deps.env, deps.allowOverride) }
  return { ...facts, port: deps.port, running: await detectRunningHere(deps.port) }
}
