// Made-up fixtures for the Home Assistant screens (docs/HA-UI-DATA-CONTRACT.md). Smokes and probes
// import this; production renderer code does not.
//
// Every value is invented: the rooms and devices below belong to no house. They are in the daemon's
// wire format (snake_case), so a smoke can send them through the same mapper a real payload takes.
// Adding a device name here means adding it to MADE_UP_NAMES, which a smoke checks every fixture against.

export const MADE_UP_NAMES: readonly string[] = [
  'Hall light',
  'Living room lamp',
  'Kitchen plug',
  'Evening scene',
  'Front door lock',
  'Landing light',
  'Stair light',
  'Porch light',
  'Study lamp',
  'Bedroom lamp',
  'Bathroom light',
  'Garden light',
  'Patio light',
  'Movie scene',
  'Thermostat',
  'Kitchen blind',
  'Garage door',
  'Garage light',
  'Spare switch'
]

const EXTENT_ONCE_RESTART = 'ha_control_ordinary on exactly Hall light — until the daemon restarts'
const EXTENT_ALWAYS = 'ha_control_ordinary on exactly Hall light — permanently, until revoked'

type Wire = Record<string, unknown>

function device(id: string, name: string, room: string | null, tier: string, current: string | null, requested: string, relaxed = false): Wire {
  return { id, name, room, tier, relaxed, current, requested, open_url: null }
}

/** One light, Ordinary: the common case. "Always allow" is on offer. */
export const ORDINARY_LIGHT: Wire = {
  request_id: 'home-ordinary',
  tool_name: 'mcp__home__ha_control_ordinary',
  description: 'Turn on Hall light (60%)',
  created_at: 1_790_000_000,
  expires_at: 1_790_001_800,
  extents: { 'until-restart': EXTENT_ONCE_RESTART, always: EXTENT_ALWAYS },
  arguments: { action: 'turn_on', brightness: '60', entity_id: 'light.hall' },
  home: {
    tier: 'ordinary',
    tier_reason: null,
    devices: [device('dev-hall-light', 'Hall light', 'Hall', 'ordinary', 'off', 'on, 60%')]
  }
}

/** A scene: Sensitive, not relaxed. The daemon offers no lasting option. */
export const SENSITIVE_SCENE: Wire = {
  request_id: 'home-sensitive',
  tool_name: 'mcp__home__ha_control_sensitive',
  description: 'Run Evening scene',
  created_at: 1_790_000_000,
  extents: {},
  arguments: { action: 'turn_on', entity_id: 'scene.evening' },
  home: {
    tier: 'sensitive',
    tier_reason: 'Scenes always ask',
    devices: [device('dev-evening-scene', 'Evening scene', 'Living room', 'sensitive', null, 'activated')]
  }
}

/** The same scene after the owner turned "Ask once" on: the daemon now offers a lasting option. */
export const SENSITIVE_RELAXED: Wire = {
  ...SENSITIVE_SCENE,
  request_id: 'home-relaxed',
  extents: {
    always: 'ha_control_sensitive on exactly Evening scene — permanently, until revoked'
  },
  home: {
    tier: 'sensitive',
    tier_reason: 'Scenes always ask',
    devices: [device('dev-evening-scene', 'Evening scene', 'Living room', 'sensitive', null, 'activated', true)]
  }
}

/** Eight lights at once: Sensitive because of the count. */
export const BULK_EIGHT: Wire = {
  request_id: 'home-bulk',
  tool_name: 'mcp__home__ha_control_sensitive',
  description: 'Turn off 8 lights',
  created_at: 1_790_000_000,
  extents: {},
  arguments: { action: 'turn_off' },
  home: {
    tier: 'sensitive',
    tier_reason: 'More than 3 devices',
    devices: [
      device('dev-hall-light', 'Hall light', 'Hall', 'ordinary', 'on', 'off'),
      device('dev-landing-light', 'Landing light', 'Hall', 'ordinary', 'on', 'off'),
      device('dev-stair-light', 'Stair light', 'Hall', 'ordinary', 'on', 'off'),
      device('dev-porch-light', 'Porch light', 'Garden', 'ordinary', 'on', 'off'),
      device('dev-study-lamp', 'Study lamp', 'Study', 'ordinary', 'off', 'off'),
      device('dev-bedroom-lamp', 'Bedroom lamp', 'Bedroom', 'ordinary', 'on', 'off'),
      device('dev-bathroom-light', 'Bathroom light', 'Bathroom', 'ordinary', null, 'off'),
      device('dev-garden-light', 'Garden light', 'Garden', 'ordinary', 'on', 'off')
    ]
  }
}

/** Never expected in phase 1 (the server has no control tool for a Critical device). */
export const CRITICAL_LOCK: Wire = {
  request_id: 'home-critical',
  tool_name: 'mcp__home__ha_control_sensitive',
  description: 'Unlock Front door lock',
  created_at: 1_790_000_000,
  extents: { always: 'ha_control_sensitive on exactly Front door lock — permanently, until revoked' },
  arguments: { action: 'unlock', entity_id: 'lock.front' },
  home: {
    tier: 'critical',
    tier_reason: null,
    devices: [device('dev-front-door-lock', 'Front door lock', 'Hall', 'critical', 'locked', 'unlocked')]
  }
}

/** The current state could not be read. */
export const UNKNOWN_CURRENT: Wire = {
  ...ORDINARY_LIGHT,
  request_id: 'home-unknown',
  home: {
    tier: 'ordinary',
    tier_reason: null,
    devices: [device('dev-living-lamp', 'Living room lamp', 'Living room', 'ordinary', null, 'on')]
  }
}

export const HOME_APPROVAL_WIRE: Record<string, Wire> = {
  ORDINARY_LIGHT,
  SENSITIVE_SCENE,
  SENSITIVE_RELAXED,
  BULK_EIGHT,
  CRITICAL_LOCK,
  UNKNOWN_CURRENT
}

// GET /api/home/actions/{request_id}
export const RESULT_CONFIRMED: Wire = {
  request_id: 'home-ordinary',
  state: 'done',
  results: [{ device_id: 'dev-hall-light', name: 'Hall light', result: 'confirmed', observed: 'on, 60%', message: 'Hall light is on' }]
}

export const RESULT_UNCONFIRMED: Wire = {
  request_id: 'home-ordinary',
  state: 'done',
  results: [
    {
      device_id: 'dev-hall-light',
      name: 'Hall light',
      result: 'unconfirmed',
      observed: 'off',
      message: 'Home Assistant accepted it, but the light still reports off'
    }
  ]
}

export const RESULT_FAILED: Wire = {
  request_id: 'home-ordinary',
  state: 'done',
  results: [{ device_id: 'dev-hall-light', name: 'Hall light', result: 'failed', observed: null, message: 'Home Assistant did not answer' }]
}

export const RESULT_PENDING: Wire = { request_id: 'home-ordinary', state: 'pending', results: [] }

// ── "What it can touch" (docs/HA-UI-DATA-CONTRACT.md §3.2) ────────────────────────────────────────

const LINK = 'https://home.example.test'

// GET /api/home/status
export const STATUS_CONNECTED: Wire = {
  state: 'connected',
  device_count: 13,
  detail: 'Connected to Home Assistant',
  checked_at: 1_790_000_000,
  open_url: LINK
}
export const STATUS_UNREACHABLE: Wire = {
  state: 'unreachable',
  device_count: null,
  detail: 'Home Assistant did not answer (timed out after 8 seconds)',
  checked_at: 1_790_000_000,
  open_url: LINK
}
export const STATUS_AUTH_FAILED: Wire = {
  state: 'auth_failed',
  device_count: null,
  detail: 'Home Assistant refused the saved access. It needs to be set up again on the Prometheus computer.',
  checked_at: 1_790_000_000,
  open_url: null
}

function listed(id: string, name: string, room: string | null, kind: string, state: string | null, tier: string, source: string, relaxed = false, link = true): Wire {
  return { id, name, room, kind, state, tier, tier_source: source, relaxed, open_url: link ? `${LINK}/device/${id}` : null }
}

// GET /api/home/devices
export const DEVICES_LIST: Wire = {
  updated_at: 1_790_000_000,
  devices: [
    listed('dev-hall-light', 'Hall light', 'Hall', 'Light', 'on', 'ordinary', 'rule'),
    listed('dev-landing-light', 'Landing light', 'Hall', 'Light', 'off', 'ordinary', 'rule'),
    listed('dev-front-door-lock', 'Front door lock', 'Hall', 'Lock', 'locked', 'critical', 'rule'),
    listed('dev-living-lamp', 'Living room lamp', 'Living room', 'Light', 'off', 'ordinary', 'rule'),
    listed('dev-evening-scene', 'Evening scene', 'Living room', 'Scene', 'idle', 'sensitive', 'rule'),
    listed('dev-movie-scene', 'Movie scene', 'Living room', 'Scene', 'idle', 'sensitive', 'override', true),
    listed('dev-thermostat', 'Thermostat', 'Living room', 'Thermostat', '19 °C', 'ordinary', 'rule'),
    listed('dev-kitchen-plug', 'Kitchen plug', 'Kitchen', 'Plug', 'on', 'ordinary', 'rule'),
    listed('dev-kitchen-blind', 'Kitchen blind', 'Kitchen', 'Blind', 'open', 'critical', 'rule'),
    listed('dev-garage-door', 'Garage door', 'Garage', 'Garage door', 'closed', 'critical', 'rule'),
    listed('dev-garage-light', 'Garage light', 'Garage', 'Light', 'off', 'ordinary', 'rule'),
    listed('dev-bedroom-lamp', 'Bedroom lamp', 'Bedroom', 'Light', 'on', 'ordinary', 'rule'),
    listed('dev-spare-switch', 'Spare switch', null, 'Switch', null, 'sensitive', 'unclassified', false, false)
  ]
}

// GET /api/approvals/grants (as the daemon serves it today, plus the optional `home` on Home rows)
export const GRANTS_LIST: Wire[] = [
  {
    kind: 'tool',
    value: '',
    tool: 'mcp__home__ha_control_ordinary',
    scope: 'persistent',
    id: 'grant-hall',
    created_at: 1_789_900_000,
    request_id: 'home-ordinary',
    describes: 'ha_control_ordinary on exactly Hall light — permanently, until revoked',
    home: { tier: 'ordinary', devices: [{ id: 'dev-hall-light', name: 'Hall light', room: 'Hall' }] }
  },
  {
    kind: 'tool',
    value: '',
    tool: 'mcp__home__ha_control_ordinary',
    scope: 'until_restart',
    id: 'grant-ordinary-all',
    created_at: 1_789_950_000,
    request_id: 'home-ordinary-2',
    describes: 'ha_control_ordinary on any Ordinary device — until the daemon restarts',
    home: { tier: 'ordinary', devices: 'all_in_tier' }
  },
  {
    kind: 'tool',
    value: '',
    tool: 'mcp__home__ha_control_sensitive',
    scope: 'persistent',
    id: 'grant-movie',
    created_at: 1_789_960_000,
    request_id: 'home-sensitive-2',
    describes: 'ha_control_sensitive on exactly Movie scene — permanently, until revoked',
    home: { tier: 'sensitive', devices: [{ id: 'dev-movie-scene', name: 'Movie scene', room: 'Living room' }] }
  },
  {
    kind: 'tool',
    value: '',
    tool: 'mcp__home__ha_control_ordinary',
    scope: 'persistent',
    id: 'grant-old',
    created_at: 1_789_000_000,
    request_id: 'home-old',
    describes: 'ha_control_ordinary on exactly Garage light — permanently, until revoked'
  },
  {
    kind: 'path_prefix',
    value: '/home/demo/notes.txt',
    tool: 'write_file',
    scope: 'persistent',
    id: 'grant-file',
    created_at: 1_789_000_000,
    request_id: 'file-1',
    describes: 'write_file on exactly /home/demo/notes.txt — permanently, until revoked'
  }
]
