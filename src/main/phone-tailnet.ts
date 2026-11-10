// This Mac's tailnet, for "Add a phone" (@shared/phone-join): `tailscale status --json` from the Tailscale CLI on this Mac (found the
// way the terminal pane finds it, ./tailnet). Local only: nothing is sent anywhere. A Mac without Tailscale, or with it stopped,
// answers null and the join code says what to do. A non-release build can read a fixture instead (BEACON_TAILNET_STATUS_FILE), as
// BEACON_PAIR_TLS_PORTS does, for the app probe.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { parseTailnet, type Tailnet } from '@shared/phone-join'
import { findTailscale } from './tailnet'

export async function readTailnet(env: NodeJS.ProcessEnv, debuggable: boolean): Promise<Tailnet | null> {
  const fixture = debuggable ? env.BEACON_TAILNET_STATUS_FILE : undefined
  if (fixture) {
    try {
      return parseTailnet(JSON.parse(readFileSync(fixture, 'utf8')))
    } catch {
      return null
    }
  }
  const bin = findTailscale(env, homedir())
  if (!bin) return null
  const out = await new Promise<string | null>((resolve) =>
    execFile(bin, ['status', '--json'], { env, timeout: 4_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout))
  )
  try {
    return out === null ? null : parseTailnet(JSON.parse(out))
  } catch {
    return null
  }
}
