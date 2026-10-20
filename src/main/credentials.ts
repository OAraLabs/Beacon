import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

/**
 * Reversible cipher for the stored credential. Production = Electron safeStorage (OS keychain).
 * Behind an interface so the CredentialStore's round-trip + persistence logic is testable headless
 * with a fake (the real keychain needs a GUI Electron process + an OS keyring → a hands-on run).
 */
export interface Cipher {
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(blob: Buffer): string
}

/**
 * Stores ONE credential — the optional Prometheus API bearer token (Step-0 survey: the daemon's
 * only auth is `Authorization: Bearer <PROMETHEUS_API_TOKEN>` on REST :8005; NOT the MC_USERNAME /
 * MC_PASSWORD / SESSION_SECRET creds, which are Beacon-web's iron-session). The token is encrypted
 * via the OS keychain and the blob
 * lives in the app-data dir — NEVER the renderer, NEVER localStorage, NEVER a bundle. The key never
 * leaves the keychain.
 */
export class CredentialStore {
  constructor(
    private readonly filePath: string,
    private readonly cipher: Cipher
  ) {}

  /** Persist the token, or clear it when blank (no-auth mode). */
  setToken(token: string): void {
    const t = token.trim()
    if (!t) {
      this.clear()
      return
    }
    writeFileSync(this.filePath, this.cipher.encrypt(t), { mode: 0o600 })
  }

  getToken(): string | null {
    if (!existsSync(this.filePath)) return null
    try {
      const t = this.cipher.decrypt(readFileSync(this.filePath)).trim()
      return t || null
    } catch {
      return null
    }
  }

  hasToken(): boolean {
    return this.getToken() !== null
  }

  clear(): void {
    if (existsSync(this.filePath)) unlinkSync(this.filePath)
  }
}

/**
 * The production cipher: Electron safeStorage. Lazily requires 'electron' so this module still
 * loads under ELECTRON_RUN_AS_NODE (where the Electron APIs are absent) — only the GUI main process
 * ever constructs/uses it.
 *
 * Linux without a secret service (headless session, no gnome-keyring): isEncryptionAvailable() is
 * false and encryptString THROWS — which used to hard-wall first-run Connect (live-walk finding,
 * 2026-06-10). Electron's sanctioned fallback is setUsePlainTextEncryption(true) — the basic_text
 * backend Chrome itself uses without a keyring. Linux-only by construction: the call throws on
 * macOS/Windows, where the OS keychain is always available anyway.
 */
export function electronSafeStorageCipher(): Cipher {
  const elec = (): typeof import('electron') => require('electron') as typeof import('electron')
  let fallbackEnabled = false
  const ensureAvailable = (): void => {
    const ss = elec().safeStorage
    if (fallbackEnabled || ss.isEncryptionAvailable() || process.platform !== 'linux') return
    ss.setUsePlainTextEncryption?.(true)
    fallbackEnabled = true
    console.warn('[creds] OS keyring unavailable — using safeStorage basic_text (Linux fallback)')
  }
  return {
    isAvailable: () => {
      ensureAvailable()
      return elec().safeStorage.isEncryptionAvailable()
    },
    encrypt: (plain) => {
      ensureAvailable()
      return elec().safeStorage.encryptString(plain)
    },
    decrypt: (blob) => {
      ensureAvailable()
      return elec().safeStorage.decryptString(blob)
    }
  }
}

export type StartupMode = 'setup' | 'connect'

/**
 * First-run vs returning launch — a PURE decision (unit-testable headless). Setup is needed only
 * when there's neither a stored gateway profile nor an env override (dev/CI). The token is OPTIONAL,
 * so its presence/absence never gates startup.
 */
export function decideStartup(opts: { hasStoredGateway: boolean; hasEnvGateway: boolean }): StartupMode {
  return opts.hasStoredGateway || opts.hasEnvGateway ? 'connect' : 'setup'
}
