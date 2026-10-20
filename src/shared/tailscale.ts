// Tailnet peers for the terminal pane — the pure model (no Electron, no child_process).
//
// The host list is DERIVED from `tailscale status --json` every time it is asked for. It is not a
// fourth registry of remote boxes beside backends, Devices and Integrations; nothing here is stored.
//
// Auth is never Beacon's: a peer that advertises Tailscale SSH host keys is reachable because the
// tailnet's ACLs say so; otherwise the local ssh-agent's identities are the only fallback. Beacon
// shells out to `ssh` and never sees, stores, or prompts for a credential — the command it builds
// forbids password and keyboard-interactive auth so the pane can never turn into a password field.

export interface TailnetPeer {
  hostName: string
  /** MagicDNS name without the trailing dot — what `ssh` is given. */
  dnsName: string
  os: string
  online: boolean
  /** The peer runs Tailscale SSH (it advertises SSH host keys in the netmap). */
  tailscaleSsh: boolean
  /** Its Tailscale addresses, as the CLI lists them (at most four). Used to ask a peer who it is without
   *  depending on name resolution. */
  ips?: string[]
}

export interface TailnetStatus {
  /** `tailscale` CLI found and answered. */
  available: boolean
  /** BackendState from the CLI ('Running', 'Stopped', 'NeedsLogin', …). */
  backendState: string | null
  peers: TailnetPeer[]
  /** Identities the local ssh-agent holds (ssh-add -l). -1 = no agent reachable. */
  agentIdentities: number
  /** Why `available` is false, in the CLI's or the OS's own words. */
  error?: string
}

/** Operating systems worth an ssh button. Phones and tablets are peers too, but not shells. */
const SSH_CAPABLE_OS = new Set(['linux', 'macos', 'freebsd', 'openbsd', 'windows'])

/** Parse `tailscale status --json`. Tolerant: an unexpected shape yields an empty list, not a throw. */
export function parseTailscaleStatus(json: unknown): { backendState: string | null; peers: TailnetPeer[] } {
  if (!json || typeof json !== 'object') return { backendState: null, peers: [] }
  const d = json as { BackendState?: unknown; Peer?: Record<string, unknown> | null }
  const backendState = typeof d.BackendState === 'string' ? d.BackendState : null
  const peers: TailnetPeer[] = []
  for (const raw of Object.values(d.Peer ?? {})) {
    if (!raw || typeof raw !== 'object') continue
    const p = raw as { HostName?: unknown; DNSName?: unknown; OS?: unknown; Online?: unknown; SSH_HostKeys?: unknown; TailscaleIPs?: unknown }
    const hostName = typeof p.HostName === 'string' ? p.HostName : ''
    const dns = typeof p.DNSName === 'string' ? p.DNSName.replace(/\.$/, '') : ''
    if (!hostName && !dns) continue
    const os = typeof p.OS === 'string' ? p.OS.toLowerCase() : ''
    if (!SSH_CAPABLE_OS.has(os)) continue
    peers.push({
      hostName: hostName || dns,
      dnsName: dns || hostName,
      os,
      online: p.Online === true,
      tailscaleSsh: Array.isArray(p.SSH_HostKeys) && p.SSH_HostKeys.length > 0,
      ips: Array.isArray(p.TailscaleIPs) ? p.TailscaleIPs.filter((x): x is string => typeof x === 'string').slice(0, 4) : []
    })
  }
  peers.sort((a, b) => Number(b.online) - Number(a.online) || a.hostName.localeCompare(b.hostName))
  return { backendState, peers }
}

/** Count identities from `ssh-add -l` output; -1 when the agent could not be reached. */
export function parseAgentIdentities(stdout: string, exitCode: number): number {
  if (exitCode === 1 || /no identities/i.test(stdout)) return 0
  if (exitCode !== 0) return -1
  return stdout.split('\n').filter((l) => /^\d+ /.test(l.trim())).length
}

export type SshReadiness =
  | { ok: true; mode: 'tailscale-ssh' | 'agent' }
  | { ok: false; reason: string }

/** Can this peer be opened without Beacon ever touching a credential? If not, say exactly why. */
export function sshReadiness(peer: TailnetPeer, status: Pick<TailnetStatus, 'agentIdentities'>): SshReadiness {
  if (!peer.online) return { ok: false, reason: `${peer.hostName} is offline on the tailnet` }
  if (peer.tailscaleSsh) return { ok: true, mode: 'tailscale-ssh' }
  if (status.agentIdentities > 0) return { ok: true, mode: 'agent' }
  const agent =
    status.agentIdentities === 0
      ? 'the local ssh-agent holds no identities (ssh-add --apple-use-keychain ~/.ssh/<key>)'
      : 'no ssh-agent is reachable'
  return {
    ok: false,
    reason: `Tailscale SSH is not enabled on ${peer.hostName} (run \`tailscale up --ssh\` there, and allow it in the tailnet ACLs) and ${agent}. Beacon will not ask for a password.`
  }
}

/** The argv for a peer: ssh with every interactive credential path switched OFF. A failure is ssh's
 *  own message in the pane followed by its exit code — never a prompt. */
export function sshCommand(peer: TailnetPeer): string[] {
  return [
    'ssh',
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ConnectTimeout=10',
    peer.dnsName
  ]
}
