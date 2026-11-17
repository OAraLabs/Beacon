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
  'Patio light'
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
