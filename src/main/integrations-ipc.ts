import { existsSync } from 'fs'
import { IPC } from '@shared/ipc'
import { isAllowedIntegrationPath, type IntegrationEntry, type IntegrationStatus } from '@shared/integrations'
import { loadIntegrations, saveIntegrations } from './integrations-store'
import { IntegrationsManager } from './integrations-client'
import { handleFromShell } from './shell-windows'

// Integrations IPC — the generic control-surface family (contract v0.1).
// Mirrors the loop-ipc pattern: its own deps object, registry via a JSON file
// in userData, and MAIN as the only party that knows base URLs or attaches
// auth. The renderer only ever passes { integrationId, relPath } — the same
// ownership rule as apiBase+token on the daemon connection.

export interface IntegrationsIpcDeps {
  /** Absolute path to the registry JSON (join(userData, 'integrations.json')). */
  registryFile: () => string
  /** Token resolver for authRef entries ('stored' → per-id keychain blob). */
  tokenFor: (entry: IntegrationEntry) => string | null
  /** Persist a token for an entry (keychain-encrypted; '' clears). Flips authRef via registry save. */
  setToken: (integrationId: string, token: string) => void
  /** Show a file in the OS file manager (shell.showItemInFolder). */
  reveal: (path: string) => void
}

export function registerIntegrationsHandlers(deps: IntegrationsIpcDeps): {
  getManager: () => IntegrationsManager
} {
  let manager = new IntegrationsManager(loadIntegrations(deps.registryFile()), deps.tokenFor)

  const rebuild = (): void => {
    manager = new IntegrationsManager(loadIntegrations(deps.registryFile()), deps.tokenFor)
  }

  // Registry + live statuses (manifest discovery + health probe, concurrent).
  handleFromShell(IPC.INTEGRATIONS_STATUS, async (): Promise<IntegrationStatus[]> => manager.statuses())

  // Persist registry edits (connect/disconnect toggles, settings). Returns the
  // sanitized list — renderer echoes clean state, loop-store contract.
  handleFromShell(IPC.INTEGRATIONS_SET, async (_e, raw: unknown): Promise<IntegrationEntry[]> => {
    const clean = saveIntegrations(deps.registryFile(), raw)
    rebuild()
    return clean
  })

  // Generic read for view endpoints (vitals/browser/events poll).
  handleFromShell(IPC.INTEGRATIONS_GET, async (_e, integrationId: string, relPath: string): Promise<unknown> => {
    if (typeof relPath !== 'string' || !isAllowedIntegrationPath(relPath)) {
      throw new Error(`illegal integration path: ${String(relPath).slice(0, 80)}`)
    }
    const client = manager.client(String(integrationId))
    if (!client) throw new Error(`unknown or disabled integration: ${integrationId}`)
    return client.get(relPath)
  })

  // Control invocation (POST/PUT/DELETE per the manifest's declared method).
  handleFromShell(
    IPC.INTEGRATIONS_INVOKE,
    async (_e, integrationId: string, relPath: string, method: string): Promise<unknown> => {
      if (typeof relPath !== 'string' || !isAllowedIntegrationPath(relPath)) {
        throw new Error(`illegal integration path: ${String(relPath).slice(0, 80)}`)
      }
      const client = manager.client(String(integrationId))
      if (!client) throw new Error(`unknown or disabled integration: ${integrationId}`)
      return client.invoke(relPath, String(method || 'POST'))
    },
  )

  // Store/clear a bearer for one entry. The VALUE never travels back to the
  // renderer (hasToken-only rule, same as the daemon credential). Also flips
  // the entry's authRef so the registry file reflects reality.
  handleFromShell(IPC.INTEGRATIONS_SET_TOKEN, async (_e, integrationId: string, token: string): Promise<void> => {
    deps.setToken(String(integrationId), String(token ?? ''))
    const entries = loadIntegrations(deps.registryFile()).map((en) =>
      en.id === integrationId ? { ...en, authRef: (token ?? '').trim() ? ('stored' as const) : ('none' as const) } : en
    )
    saveIntegrations(deps.registryFile(), entries)
    rebuild()
  })

  // The empty state's next step: the file to add an integration to, shown in Finder. Written empty first when there is none, so there is
  // a file to show (an empty list is what a missing file already means).
  handleFromShell(IPC.INTEGRATIONS_REVEAL, async (): Promise<void> => {
    const file = deps.registryFile()
    if (!existsSync(file)) saveIntegrations(file, [])
    deps.reveal(file)
  })

  return { getManager: () => manager }
}
