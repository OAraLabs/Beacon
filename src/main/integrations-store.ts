// Integrations registry persistence — byte-for-byte mirror of loop-store.ts's
// contract: missing/corrupt file → [], saves sanitize first and return the
// sanitized list so the renderer always echoes clean state. The registry file
// (userData/integrations.json) holds NO secrets — authRef only.

import { readFileSync, writeFileSync } from 'fs'
import { IntegrationEntry, sanitizeIntegrations } from '../shared/integrations'

export function loadIntegrations(file: string): IntegrationEntry[] {
  try {
    return sanitizeIntegrations(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return [] // missing or corrupt — pure-Prometheus mode is a clean state, not an error
  }
}

export function saveIntegrations(file: string, raw: unknown): IntegrationEntry[] {
  const clean = sanitizeIntegrations(raw)
  try {
    writeFileSync(file, JSON.stringify(clean, null, 2))
  } catch (err) {
    // Loud: a failed save must not look like success in the log...
    console.error('[integrations-store] save failed:', err)
  }
  return clean
}
