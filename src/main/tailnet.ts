// Tailnet peers for the terminal pane — the main-process half: shell out to the `tailscale` CLI and
// to `ssh-add -l`, parse with the pure model, return a description. No Electron import; the
// headless smoke drives this with the real binaries (and reports, not fails, when they are absent).
//
// Beacon never handles a credential here: it reads how many identities the agent holds, not what
// they are; it never reads ~/.ssh; it writes nothing.
import { execFile } from 'node:child_process'
import { parseAgentIdentities, parseTailscaleStatus, type TailnetStatus } from '@shared/tailscale'
import { resolveProgram } from './terminal-sessions'

/** Where the CLI lives when the app was launched from Finder (a minimal PATH without /usr/local/bin). */
const TAILSCALE_FALLBACKS = ['/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale']

export function findTailscale(env: NodeJS.ProcessEnv, home: string): string | null {
  return resolveProgram('tailscale', env.PATH, home) ?? TAILSCALE_FALLBACKS.find((p) => resolveProgram(p, env.PATH, home)) ?? null
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : err ? 127 : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? (err?.message ?? '')) })
    })
  })
}

/** The peers `tailscale status --json` lists, and nothing else: no ssh-agent, no other command. Discovery
 *  uses this, because asking "who is on my private network" has no business reading the user's ssh-agent. */
export async function tailnetPeers(env: NodeJS.ProcessEnv, home: string): Promise<Omit<TailnetStatus, 'agentIdentities'>> {
  const bin = findTailscale(env, home)
  if (!bin) {
    return { available: false, backendState: null, peers: [], error: 'tailscale CLI not found (PATH, /usr/local/bin, or Tailscale.app)' }
  }
  const r = await run(bin, ['status', '--json'], env)
  if (r.code !== 0) {
    return { available: false, backendState: null, peers: [], error: `tailscale status failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 200)}` }
  }
  try {
    const parsed = parseTailscaleStatus(JSON.parse(r.stdout))
    return { available: true, backendState: parsed.backendState, peers: parsed.peers }
  } catch (e) {
    return { available: false, backendState: null, peers: [], error: `tailscale status: unreadable JSON (${e instanceof Error ? e.message : String(e)})` }
  }
}

export async function tailnetStatus(env: NodeJS.ProcessEnv, home: string): Promise<TailnetStatus> {
  const agent = await run('ssh-add', ['-l'], env)
  const agentIdentities = parseAgentIdentities(agent.stdout + agent.stderr, agent.code)
  return { ...(await tailnetPeers(env, home)), agentIdentities }
}
