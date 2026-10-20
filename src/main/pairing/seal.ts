// The cryptography of joining a Prometheus (docs/PAIRING-APPROVAL-API.md on Prometheus #697/#698, sections 4.3 and 4.4),
// the requesting device's half. The recipe, and the test vectors this is held to (smoke:request-join):
//
//   * the device makes an X25519 key pair and sends the public half; the private half stays in this process;
//   * the daemon seals the new device's token to that public key: an ephemeral X25519 key, HKDF-SHA256 (salt = the
//     request id as ASCII, info = "prometheus-pair-v1/seal") for a 32-byte key, ChaCha20-Poly1305 with a 12-byte nonce
//     and the request id as associated data, the 16-byte tag appended to the ciphertext;
//   * the 4-digit match code is SHA-256("prometheus-pair-v1" 0x00 device_public instance_public_der request_id), the
//     first four bytes as a big-endian number, modulo 10000. The device computes it itself and compares it with the
//     one the daemon sent, so a relay that swapped the key shows up.
//
// ChaCha20-Poly1305 is NOT taken from node:crypto. Beacon's main process runs in Electron, whose Node is built on
// BoringSSL and has no such cipher (`getCiphers()` lacks it; createDecipheriv says "Unknown cipher"), although plain
// Node has it. The contract calls it "native in Node crypto"; that holds for the daemon's side, not ours. It comes from
// @noble/ciphers, bundled into the main process (a devDependency, so nothing extra ships in node_modules), and
// the contract's vectors hold it to the byte inside the real bundle (smoke:request-join runs under Electron's Node).
//
// Nothing here talks to a network, and nothing here throws on hostile input: `unseal` answers null.
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject
} from 'node:crypto'

export const SEAL_ALG = 'x25519-hkdf-sha256-chacha20poly1305'
const HKDF_INFO = 'prometheus-pair-v1/seal'
const MATCH_DOMAIN = 'prometheus-pair-v1'
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex')
const REQUEST_ID = /^[0-9a-f]{32}$/
const MAX_CIPHERTEXT = 4096

export interface Sealed {
  alg: string
  ephemeral_public_key: string
  nonce: string
  ciphertext: string
}
export interface RequesterKeys {
  privateKey: KeyObject
  publicRaw: Buffer
  publicB64: string
}
export interface Unsealed {
  token: string
  deviceId: string
  name: string
}

/** Strict unpadded base64url: only that alphabet, and only the canonical spelling of its bytes. */
export function decodeB64url(s: unknown): Buffer | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return null
  const b = Buffer.from(s, 'base64url')
  return b.toString('base64url') === s ? b : null
}

export function privateKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error('an X25519 private key is 32 bytes')
  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' })
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error('an X25519 public key is 32 bytes')
  return createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' })
}

export function newRequesterKeys(): RequesterKeys {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const publicRaw = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32))
  return { privateKey, publicRaw, publicB64: publicRaw.toString('base64url') }
}

export function matchCode(devicePublic: Buffer, instancePublicDer: Buffer, requestId: string): string {
  if (!REQUEST_ID.test(requestId)) throw new Error('a request id is 32 lower-case hex characters')
  const digest = createHash('sha256')
    .update(MATCH_DOMAIN, 'ascii')
    .update(Buffer.from([0]))
    .update(devicePublic)
    .update(instancePublicDer)
    .update(requestId, 'ascii')
    .digest()
  return String(digest.readUInt32BE(0) % 10000).padStart(4, '0')
}

export function sharedSecret(privateKey: KeyObject, peerPublicRaw: Buffer): Buffer {
  const secret = diffieHellman({ privateKey, publicKey: publicKeyFromRaw(peerPublicRaw) })
  // A low-order public key gives an all-zero secret that anyone can compute: refuse it.
  if (secret.every((b) => b === 0)) throw new Error('a weak public key')
  return secret
}

export function sealKey(shared: Buffer, requestId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.from(requestId, 'ascii'), HKDF_INFO, 32))
}

/** The sealed token, opened; null for anything that is not exactly what the contract describes. */
export function unseal(sealed: unknown, privateKey: KeyObject, requestId: string): Unsealed | null {
  try {
    if (!REQUEST_ID.test(requestId) || !sealed || typeof sealed !== 'object') return null
    const s = sealed as Record<string, unknown>
    if (s.alg !== SEAL_ALG) return null
    const ephemeral = decodeB64url(s.ephemeral_public_key)
    const nonce = decodeB64url(s.nonce)
    const body = decodeB64url(s.ciphertext)
    if (!ephemeral || ephemeral.length !== 32 || !nonce || nonce.length !== 12 || !body || body.length <= 16 || body.length > MAX_CIPHERTEXT) return null
    const key = sealKey(sharedSecret(privateKey, ephemeral), requestId)
    // The library checks the tag (the last 16 bytes) in constant time and throws if it does not match.
    const plain = Buffer.from(chacha20poly1305(key, nonce, Buffer.from(requestId, 'ascii')).decrypt(body)).toString('utf8')
    const v = JSON.parse(plain) as Record<string, unknown>
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const { token, device_id: deviceId, name } = v
    if (typeof token !== 'string' || token.length < 1 || token.length > 1024) return null
    if (typeof deviceId !== 'string' || deviceId.length < 1 || deviceId.length > 128) return null
    if (typeof name !== 'string' || name.length > 256) return null
    return { token, deviceId, name }
  } catch {
    return null
  }
}
