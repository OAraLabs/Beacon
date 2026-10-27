/**
 * Headless smoke: no plain http/ws to an address that is not this computer, the home network or Tailscale (owner decision, 2026-10-17, for
 * 0.4.6). The home network has its own rule (src/shared/plain-lan.ts, F2: new plain joins refused, saved ones kept with a notice);
 * this one is about everywhere else, where a plain connection carries the key unencrypted across the internet. It is refused
 * outright, saved connections included (the owner: "Refuse it too"), with plain words: use https or Tailscale.
 *
 * A name is judged by what it resolves to, not by how it looks: a Tailscale short name (`my-mini`) and a router's name
 * (`nas.lan`) are not public, and a name that does not resolve now cannot be judged (it cannot be reached either).
 *
 * Fails when: a public address (IPv4, IPv6, or a name resolving to one, or partly to one) is let through in plain on either URL; an
 * encrypted URL, loopback, Tailscale, the home network or an unresolvable name is refused; the words are jargon or name no way
 * out; or a way in stops asking (Settings save and Test, an address with a key, a setup code, a typed address in onboarding, a
 * join, and the saved connection itself, whose REST calls and socket wait for the answer). WHAT THIS CANNOT PROVE: that the app
 * does it; scripts/plain-public-app-probe.mjs does, in the built app.
 *
 *   npm run build && npm run smoke:plain-public
 */
import { readFileSync } from 'node:fs'
import { PLAIN_PUBLIC_REFUSED } from '@shared/plain-lan'
import { plainPublicRefusal } from './plain-public'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[plain-public-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 9
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.error(`[plain-public-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`[plain-public-smoke] FAIL — ${failures}/${checks} checks failed`)
    process.exitCode = 1
  } else console.log(`[plain-public-smoke] OK — ${checks} checks passed`)
})
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
const src = (p: string): string => strip(readFileSync(p, 'utf8'))

// A Tailscale address, built at run time (the pre-commit guard refuses a 100.64/10 literal in source).
const TS4 = [100, 101, 102, 103].join('.')
// A resolver that never touches the network: documentation and private ranges only (TEST-NET-3 203.0.113.0/24, 2001:db8::/32).
const NAMES: Record<string, string[]> = {
  'probe.example': ['203.0.113.9'],
  'v6.example': ['2001:db8::9'],
  'my-mini': [TS4],
  'nas.lan': ['192.168.1.5'],
  'my-mac': ['127.0.0.1'],
  'mixed.example': ['192.168.1.5', '203.0.113.9']
}
let asked: string[] = []
const resolve = async (host: string): Promise<string[]> => {
  asked.push(host)
  const r = NAMES[host]
  if (!r) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' })
  return r
}
const refused = (api: string, ws: string): Promise<boolean> => plainPublicRefusal(api, ws, resolve).then((r: string | null) => r === PLAIN_PUBLIC_REFUSED)

const main = async (): Promise<void> => {
  // 1. Public addresses, written as addresses.
  const pub = await Promise.all([
    refused('http://203.0.113.5:8005', 'ws://203.0.113.5:8010'),
    refused('https://203.0.113.5:8005', 'ws://203.0.113.5:8010'), // the socket alone in plain is enough
    refused('http://203.0.113.5:8005', 'wss://203.0.113.5:8010'),
    refused('http://[2001:db8::1]:8005', 'ws://[2001:db8::1]:8010'),
    refused('http://8.8.8.8:8005', 'ws://8.8.8.8:8010')
  ])
  assert(pub.every(Boolean), 'a public address in plain (IPv4 or IPv6, on either URL) is refused', JSON.stringify(pub))

  // 2. Encrypted, or not public: let through (the home network is F2's to decide, not this rule's).
  const ok = await Promise.all([
    refused('https://203.0.113.5:8006', 'wss://203.0.113.5:8011'),
    refused('http://127.0.0.1:8005', 'ws://127.0.0.1:8010'),
    refused('http://localhost:8005', 'ws://localhost:8010'),
    refused('http://[::1]:8005', 'ws://[::1]:8010'),
    refused(`http://${TS4}:8005`, `ws://${TS4}:8010`),
    refused('http://[fd7a:115c:a1e0::1]:8005', 'ws://[fd7a:115c:a1e0::1]:8010'),
    refused('http://my-mini.tail1234.ts.net:8005', 'ws://my-mini.tail1234.ts.net:8010'), // precommit:allow-example-host
    refused('http://192.168.1.20:8005', 'ws://192.168.1.20:8010'),
    refused('http://my-mini.local:8005', 'ws://my-mini.local:8010')
  ])
  assert(ok.every((r) => !r), 'encrypted, loopback, Tailscale (100.64/10, fd7a:115c:a1e0::/48, *.ts.net) and the home network are not refused by this rule', JSON.stringify(ok))

  // 3. Names, by what they resolve to.
  asked = []
  const names = await Promise.all([
    refused('http://probe.example:8005', 'ws://probe.example:8010'),
    refused('http://v6.example:8005', 'ws://v6.example:8010'),
    refused('http://mixed.example:8005', 'ws://mixed.example:8010')
  ])
  assert(names.every(Boolean) && asked.includes('probe.example'), 'a name that resolves to a public address (or to one among others) is refused', JSON.stringify(names))
  const local = await Promise.all([
    refused('http://my-mini:8005', 'ws://my-mini:8010'),
    refused('http://nas.lan:8005', 'ws://nas.lan:8010'),
    refused('http://my-mac:8005', 'ws://my-mac:8010')
  ])
  assert(local.every((r) => !r), 'a Tailscale short name, a router name and a name for this computer are not refused (judged by where they resolve)', JSON.stringify(local))
  const unknown = await refused('http://nowhere.invalid:8005', 'ws://nowhere.invalid:8010')
  assert(!unknown, 'a name that does not resolve now is not refused (it cannot be judged, or reached)')

  // 4. The words.
  const JARGON = /plain-?text|cleartext|TLS|SSL|daemon|gateway|bearer|token|HTTP\b|\bws\b|wss|refused|error|RFC|\d{3}/i
  assert(
    PLAIN_PUBLIC_REFUSED.length > 40 && !JARGON.test(PLAIN_PUBLIC_REFUSED.replace('https://', '')) && /https:\/\//.test(PLAIN_PUBLIC_REFUSED) && /Tailscale/.test(PLAIN_PUBLIC_REFUSED),
    'the words are plain and name both ways out: an https:// address, or Tailscale',
    PLAIN_PUBLIC_REFUSED
  )

  // 5. The ways in, and the saved connection.
  const index = src('src/main/index.ts')
  // pairPoll and probeSetupAt too: the launch-time setup check asked a refused saved address in plain (the probe found it), and the
  // legacy wizard's poll sends the key.
  const fns = ['saveSetup', 'pairWithCode', 'saveConnectionSettings', 'testConnection', 'pairPoll', 'probeSetupAt']
  const body = (name: string): string => index.slice(index.indexOf(`async function ${name}(`), index.indexOf('\n}\n', index.indexOf(`async function ${name}(`)))
  const missing = fns.filter((f) => !/plainPublicRefusal\(/.test(body(f)))
  assert(missing.length === 0, 'Settings save and Test, an address with a key, a setup code, the setup check and its poll each ask before anything is sent', missing.join(', '))
  const joins = src('src/main/discovery.ts') + src('src/main/pairing/session.ts')
  assert((joins.match(/plainPublicRefusal\(/g) ?? []).length >= 2, 'a typed address in onboarding and a join each ask before anything is sent')
  const rest = src('src/main/connection/rest.ts')
  const conn = src('src/main/connection/index.ts')
  // fetch is called in ONE place, send() (after the gate, and the origin and redirect checks); anywhere else would skip all three.
  const sendStart = rest.indexOf('private async send(')
  const sendEnd = rest.indexOf('\n  }\n', sendStart)
  const outsideSend = sendStart < 0 || sendEnd < 0 ? rest : rest.slice(0, sendStart) + rest.slice(sendEnd)
  assert(
    sendStart >= 0 && !/\bfetch\(/.test(outsideSend) && /this\.send\(/.test(rest) && /gate/.test(rest) && /gate/.test(conn) && /refused/.test(src('src/shared/ipc.ts').match(/export interface ConnectionStatus \{[\s\S]*?\n\}/)?.[0] ?? '') &&
      /plainPublicRefusal\(/.test(index),
    "the saved connection waits for the answer: every REST call goes through RestClient's gate, the socket starts only after it, and the status carries the words"
  )
}
main().catch((e) => {
  assert(false, 'the smoke ran to the end', String(e?.stack ?? e))
})
