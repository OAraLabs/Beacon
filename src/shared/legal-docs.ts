// Beacon's license and the open-source notices, as Settings → About opens them.
//
// The renderer names a document; it never sends a path. Main maps the name to the one file electron-builder
// shipped for it (electron-builder.yml extraResources), so this channel cannot be asked to open anything
// else on disk.
//
// Where each file is:
//   packaged     resources dir (process.resourcesPath): LICENSE.txt, THIRD_PARTY_NOTICES.txt, and on macOS
//                LICENSES.chromium.html. On Linux electron-builder keeps Electron's own LICENSES.chromium.html
//                at the app's root, the resources dir's parent.
//   unpackaged   the repo: LICENSE, THIRD_PARTY_NOTICES.txt, and Electron's copy under node_modules.

export type LegalDoc = 'license' | 'notices' | 'chromium'

export const LEGAL_DOCS: readonly LegalDoc[] = ['license', 'notices', 'chromium']

export function isLegalDoc(value: unknown): value is LegalDoc {
  return typeof value === 'string' && (LEGAL_DOCS as readonly string[]).includes(value)
}

export interface LegalDocPlace {
  packaged: boolean
  platform: string
  /** process.resourcesPath */
  resourcesPath: string
  /** The repo root, for an unpackaged build. */
  repoRoot: string
}

const join = (...parts: string[]): string => parts.join('/').replace(/\/{2,}/g, '/')
const parent = (dir: string): string => dir.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'

export function legalDocPath(doc: LegalDoc, at: LegalDocPlace): string {
  if (!at.packaged) {
    if (doc === 'license') return join(at.repoRoot, 'LICENSE')
    if (doc === 'notices') return join(at.repoRoot, 'THIRD_PARTY_NOTICES.txt')
    return join(at.repoRoot, 'node_modules/electron/dist/LICENSES.chromium.html')
  }
  if (doc === 'license') return join(at.resourcesPath, 'LICENSE.txt')
  if (doc === 'notices') return join(at.resourcesPath, 'THIRD_PARTY_NOTICES.txt')
  return at.platform === 'darwin' ? join(at.resourcesPath, 'LICENSES.chromium.html') : join(parent(at.resourcesPath), 'LICENSES.chromium.html')
}

/** What legal.open() resolves to: opened in the OS's viewer, or why not. */
export type LegalDocResult = { ok: true } | { ok: false; error: string }
