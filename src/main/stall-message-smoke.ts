/**
 * stall-message-smoke — Beacon says only what its evidence supports.
 *
 * THE REGRESSION. ChatShell's watchdog witnesses one thing: silence in the
 * session on screen. It announced "the turn itself may have died" from that —
 * a claim about the DAEMON drawn from evidence about one conversation. On
 * 2026-08-16 it was wrong three times in a row while the daemon emitted 36
 * progress pulses at an exact 3s cadence, every one for a session the view was
 * not showing and every one dropped at the session filter.
 *
 * Wording IS the defect here, so wording is what these assert.
 *
 * Run: npm run smoke:stall-message
 */
import { stallCause, stallMessage } from '@shared/stall-message'

let failures = 0
function check(cond: boolean, label: string): void {
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}`)
    failures += 1
  }
}

console.log('\n=== cause selection ===')
check(
  stallCause({ droppedInWindow: true, gatewaySpokeElsewhere: false }) === 'socket-dropped',
  'our own socket drop wins — the most specific fact, and ours'
)
check(
  stallCause({ droppedInWindow: true, gatewaySpokeElsewhere: true }) === 'socket-dropped',
  'a drop still wins when the gateway was also busy elsewhere'
)
check(
  stallCause({ droppedInWindow: false, gatewaySpokeElsewhere: true }) === 'session-quiet',
  'gateway active elsewhere → THIS SESSION is quiet, not the daemon'
)
check(
  stallCause({ droppedInWindow: false, gatewaySpokeElsewhere: false }) === 'gateway-silent',
  'nothing heard from anywhere → the alarming reading, earned'
)

console.log('\n=== what each line is allowed to claim ===')
const quiet = stallMessage({ droppedInWindow: false, gatewaySpokeElsewhere: true })
const silent = stallMessage({ droppedInWindow: false, gatewaySpokeElsewhere: false })
const dropped = stallMessage({ droppedInWindow: true, gatewaySpokeElsewhere: false })

// THE REGRESSION ASSERTION. This is the exact case that fired three times.
check(
  !/turn itself may have died|check the daemon/i.test(quiet),
  'session-quiet NEVER blames the turn or sends the operator to the daemon — the 2026-08-16 defect'
)
check(/this session/i.test(quiet), 'session-quiet scopes its claim to this session, explicitly')
check(/other sessions/i.test(quiet), 'and says why it knows: the gateway was active elsewhere')
check(/approval/i.test(quiet), 'it names the likely cause an operator can act on')

check(/on any session/i.test(silent), 'gateway-silent states the scope that earns the alarm')
check(/check the daemon/i.test(silent), 'only gateway-silent sends anyone to the daemon')

check(/dropped and reconnected/i.test(dropped), 'socket-dropped says what Beacon itself did')
check(!/may have died/i.test(dropped), 'socket-dropped does not blame the turn either')

console.log('\n=== the three are distinct ===')
check(new Set([quiet, silent, dropped]).size === 3, 'three causes, three different lines')
check(
  [quiet, silent, dropped].every((m) => m.length > 40 && !/undefined|NaN/.test(m)),
  'every line is a complete sentence, no placeholder leakage'
)

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`)
process.exit(failures === 0 ? 0 : 1)
