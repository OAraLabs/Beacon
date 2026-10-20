// Headless Slice-5 smoke (ELECTRON_RUN_AS_NODE electron out/main/palette-smoke.js).
// Proves the pure palette ranking (prefix > word-boundary > substring > subsequence, non-matches
// drop, empty query = original order) and window-state sanitization (size floors, offscreen
// position dropped, maximized carried).

import { isSubsequence, rankCommands, SHORTCUTS } from '@shared/commands'
import { DEFAULT_WINDOW_STATE, sanitizeWindowState } from './window-state'

let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}

console.log('rankCommands:')
const items = [
  { label: 'Go to Chat' },
  { label: 'Go to Activity' },
  { label: 'Open desktop:smoke' },
  { label: 'Reconnect to gateway' },
  { label: 'Open Connection Settings' }
]
{
  const r = rankCommands(items, '')
  check('empty query → original order', r.length === 5 && r[0].label === 'Go to Chat')
}
{
  const r = rankCommands(items, 'go')
  check('prefix beats substring', r[0].label === 'Go to Chat' && r[1].label === 'Go to Activity')
}
{
  const r = rankCommands(items, 'chat')
  check('word-boundary match found', r.some((x) => x.label === 'Go to Chat'))
}
{
  const r = rankCommands(items, 'recon')
  check('substring/word match', r[0].label === 'Reconnect to gateway')
}
{
  const r = rankCommands(items, 'ocs')
  check('subsequence matches (ocs → Open Connection Settings)', r.some((x) => x.label === 'Open Connection Settings'))
}
{
  const r = rankCommands(items, 'zzz9')
  check('non-matches drop', r.length === 0)
}
check('isSubsequence basics', isSubsequence('act', 'Go to Activity') && !isSubsequence('xyz', 'chat'))
check('shortcut sheet has entries', SHORTCUTS.length >= 6)

console.log('sanitizeWindowState:')
const display = { x: 0, y: 0, width: 1920, height: 1080 }
{
  const s = sanitizeWindowState({ x: 100, y: 80, width: 1200, height: 800 }, [display])
  check('valid state kept', s.x === 100 && s.y === 80 && s.width === 1200 && s.height === 800)
}
{
  const s = sanitizeWindowState({ x: 5000, y: 80, width: 1200, height: 800 }, [display])
  check('offscreen x → position dropped, size kept', s.x === undefined && s.width === 1200)
}
{
  const s = sanitizeWindowState({ width: 10, height: 10 }, [display])
  check('tiny size → defaults', s.width === DEFAULT_WINDOW_STATE.width && s.height === DEFAULT_WINDOW_STATE.height)
}
{
  const s = sanitizeWindowState('garbage', [display])
  check('garbage → defaults', s.width === DEFAULT_WINDOW_STATE.width)
}
{
  const s = sanitizeWindowState({ x: 50, y: 50, width: 900, height: 700, maximized: true }, [display])
  check('maximized carried', s.maximized === true)
}

if (failures > 0) {
  console.error(`\n[palette-smoke] FAILED — ${failures} check(s)`)
  process.exit(1)
}
console.log('\n[palette-smoke] PASS')
process.exit(0)
