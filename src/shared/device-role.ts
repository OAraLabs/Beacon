// Is this Beacon the owner of the Prometheus it is connected to, or an approved (scoped) device? Prometheus lets a scoped device chat
// and manage its own sessions and device; everything else (status, models, the board, files, documents, the wiki, usage, cron, …) is
// the owner's, refused 403 operator_only (Prometheus web/route_access.py, default-deny since #692). The 0.4.5 sweep found Beacon reading
// those routes anyway on an approved device and printing the refusals raw, or a wrong reason ("too old", "unreachable"), or empty
// readings ("— · — · —", "up 0s"). So Beacon asks once, at GET /api/devices (allowed to every device): its own row (is_self) says
// owner: true or false. No row of its own means the global API token (not a device), which is the operator.
//
// No Node/Electron imports (same rule as the rest of src/shared).

export type DeviceRole = 'owner' | 'limited'
export const DEVICES_PATH = '/api/devices'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The role from GET /api/devices' answer, or null when it cannot say (Beacon then shows everything, as before). */
export function roleFromDevices(status: number, body: unknown): DeviceRole | null {
  if (status !== 200 || !Array.isArray(body)) return null
  const own = body.filter((d) => isObj(d) && d.is_self === true)
  // The global token is no device: every row, none of them its own.
  if (own.length === 0) return 'owner'
  const row = own[0] as Record<string, unknown>
  if (own.length > 1 || typeof row.owner !== 'boolean') return null
  return row.owner ? 'owner' : 'limited'
}

/** The views (MainView) and Config tabs that read only owner routes: everything outside Prometheus's SCOPED_ALLOWED (its device, chat,
 *  its own sessions and their fork, events and activity, search, its own approvals). On an approved device each is the note instead,
 *  and never mounts, so nothing is asked that would be refused. */
export const OWNER_ONLY_VIEWS: readonly string[] = ['artifacts', 'board', 'checkpoints', 'coding', 'documents', 'files', 'loop-manager', 'skills', 'status', 'wiki']
export const OWNER_ONLY_CONFIG_TABS: readonly string[] = [
  'config',
  'connectors',
  'cron',
  'grants',
  'memory',
  'models',
  'profiles',
  'sentinel',
  'skills',
  'telemetry',
  'usage',
  'wiki'
]

export const isOwnerOnlyView = (view: string): boolean => OWNER_ONLY_VIEWS.includes(view)
export const isOwnerOnlyConfigTab = (tab: string): boolean => OWNER_ONLY_CONFIG_TABS.includes(tab)

export const OWNER_ONLY_COPY = {
  button: 'Make this Beacon an owner'
} as const

/** What each area is, and what an approved device does not get to see there. */
const AREAS: Record<string, { name: string; what: string }> = {
  mission: { name: 'The rest of Mission', what: "what Prometheus is running, its models, schedules and plans" },
  enrol: { name: 'Adding a phone or another computer', what: 'new devices' },
  coding: { name: 'Coding', what: 'coding runs on that computer' },
  'loop-manager': { name: 'Loop Manager', what: 'coding runs on that computer' },
  files: { name: 'Files', what: 'the files on that computer' },
  artifacts: { name: 'Artifacts', what: 'the files your assistant has made' },
  board: { name: 'The board', what: 'its projects and plans' },
  documents: { name: 'Documents', what: "your assistant's documents" },
  wiki: { name: 'The wiki', what: 'what your assistant has written down' },
  checkpoints: { name: 'Checkpoints', what: 'saved points in a conversation' },
  skills: { name: 'Skills', what: "your assistant's skills" },
  status: { name: 'Status', what: "what Prometheus is running and how it's set up" },
  models: { name: 'Models', what: 'which models Prometheus uses, or their keys' },
  connectors: { name: 'Connectors', what: 'the tools Prometheus is connected to' },
  profiles: { name: 'Profiles', what: "your assistant's profiles" },
  grants: { name: 'Grants', what: 'the permissions your assistant keeps' },
  telemetry: { name: 'Telemetry', what: 'how Prometheus has been doing' },
  usage: { name: 'Usage', what: 'what Prometheus has used and spent' },
  memory: { name: 'Memory', what: 'what your assistant remembers' },
  sentinel: { name: 'Sentinel', what: 'what Prometheus does in the background' },
  cron: { name: 'Cron', what: 'scheduled jobs' },
  config: { name: 'Config', what: "Prometheus's settings" }
}

/** The note shown in place of an owner-only view or tab on an approved device. */
export function ownerOnlyText(area: string): string {
  const a = AREAS[area] ?? { name: 'This', what: 'it' }
  if (area === 'enrol')
    return `${a.name} is for the owner of this Prometheus. This Beacon is an approved device: it can chat and keep its own conversations, and sign itself out here.`
  return `${a.name} is for the owner of this Prometheus. This Beacon is an approved device: it can chat and keep its own conversations, but it can't see ${a.what}.`
}
