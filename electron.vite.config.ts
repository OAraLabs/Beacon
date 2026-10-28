import { mkdirSync, writeFileSync } from 'fs'
import { relative, resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { mainOutDirExpression } from './src/shared/main-out-dir'

/** `import.meta.mainOutDir` in main-process code: out/main, written into each chunk as the hop from
 *  that chunk's own directory. A module's `__dirname` names whichever chunk rollup put it in, which
 *  other build inputs decide (src/shared/main-out-dir.ts has the incident). Rollup tells this hook
 *  which chunk it is rendering. */
function mainOutDir(): Plugin {
  return {
    name: 'beacon:main-out-dir',
    resolveImportMeta(property, { chunkId, format }) {
      if (property !== 'mainOutDir') return null
      if (format !== 'cjs') throw new Error(`import.meta.mainOutDir: main is built as ${format}, and only cjs is supported`)
      return mainOutDirExpression(chunkId)
    }
  }
}

/** Where each build target's list of bundled npm packages goes: scripts/third-party-notices.mjs reads
 *  it. Outside out/, because everything under out/ ships. */
export const BUNDLED_PACKAGES_DIR = 'node_modules/.cache/beacon-bundled-packages'

/** Records which npm packages rollup inlined into this target's output. Code rollup inlines ships in
 *  app.asar whether or not its package is a production dependency, so THIRD_PARTY_NOTICES cannot be
 *  read off package.json alone. main's smoke entries are left out: electron-builder.yml never ships
 *  out/main/*-smoke.js. Vite's own helpers arrive as virtual modules (\0vite/…, \0commonjsHelpers…)
 *  and are vite's code; a \0-prefixed CommonJS proxy of a real package file counts as that package;
 *  any other virtual module is recorded as such, for the notices check to refuse. */
function bundledPackages(target: 'main' | 'preload' | 'renderer'): Plugin {
  return {
    name: 'beacon:bundled-packages',
    apply: 'build',
    generateBundle(_options, bundle) {
      const packages = new Set<string>()
      const virtual = new Set<string>()
      for (const out of Object.values(bundle)) {
        if (out.type !== 'chunk') continue
        if (target === 'main' && /^[^/]*-smoke\.js$/.test(out.fileName)) continue
        for (const id of Object.keys(out.modules)) {
          const path = id.split('?')[0].replace(/^\0/, '')
          if (/^(vite\/|commonjsHelpers)/.test(path)) {
            packages.add('node_modules/vite')
            continue
          }
          const at = path.lastIndexOf('/node_modules/')
          if (at < 0) {
            if (id.startsWith('\0')) virtual.add(path)
            continue
          }
          const rest = path.slice(at + '/node_modules/'.length).split('/')
          const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]
          packages.add(relative(process.cwd(), `${path.slice(0, at)}/node_modules/${name}`))
        }
      }
      mkdirSync(BUNDLED_PACKAGES_DIR, { recursive: true })
      const record = { target, packages: [...packages].sort(), virtual: [...virtual].sort() }
      writeFileSync(`${BUNDLED_PACKAGES_DIR}/${target}.json`, JSON.stringify(record, null, 2) + '\n')
    }
  }
}

// electron-vite drives three build targets from one config: the Node main process,
// the sandboxed preload, and the Vite/React renderer. `externalizeDepsPlugin` keeps
// node/native deps (electron, better-sqlite3, ws) as runtime `require`s instead of
// bundling them — essential for the native cache module.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), mainOutDir(), bundledPackages('main')],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: {
        input: {
          // App entry + standalone smoke entries (run under ELECTRON_RUN_AS_NODE).
          index: resolve('src/main/index.ts'),
          'markdown-urls-smoke': resolve('src/main/markdown-urls-smoke.ts'),
          'reply-watchdog-smoke': resolve('src/main/reply-watchdog-smoke.ts'),
          'compaction-status-smoke': resolve('src/main/compaction-status-smoke.ts'),
          'live-frames-smoke': resolve('src/main/live-frames-smoke.ts'),
          'stop-interrupt-smoke': resolve('src/main/stop-interrupt-smoke.ts'),
          'watchdog-log-smoke': resolve('src/main/watchdog-log-smoke.ts'),
          'window-chrome-smoke': resolve('src/main/window-chrome-smoke.ts'),
          'recovery-smoke': resolve('src/main/recovery-smoke.ts'),
          'min-size-smoke': resolve('src/main/min-size-smoke.ts'),
          'context-menu-smoke': resolve('src/main/context-menu-smoke.ts'),
          'badge-smoke': resolve('src/main/badge-smoke.ts'),
          'notification-prefs-smoke': resolve('src/main/notification-prefs-smoke.ts'),
          'tray-hint-smoke': resolve('src/main/tray-hint-smoke.ts'),
          'login-item-smoke': resolve('src/main/login-item-smoke.ts'),
          'armilla-pace-smoke': resolve('src/main/armilla-pace-smoke.ts'),
          'theme-applier-smoke': resolve('src/main/theme-applier-smoke.ts'),
          'session-activity-smoke': resolve('src/main/session-activity-smoke.ts'),
          'live-announce-smoke': resolve('src/main/live-announce-smoke.ts'),
          'step2-smoke': resolve('src/main/step2-smoke.ts'),
          'step4-smoke': resolve('src/main/step4-smoke.ts'),
          'step5-smoke': resolve('src/main/step5-smoke.ts'),
          'step6-smoke': resolve('src/main/step6-smoke.ts'),
          'parts-smoke': resolve('src/main/parts-smoke.ts'),
          'plan-smoke': resolve('src/main/plan-smoke.ts'),
          'outputs-smoke': resolve('src/main/outputs-smoke.ts'),
          'match-spec-smoke': resolve('src/main/match-spec-smoke.ts'),
          'socket-log-smoke': resolve('src/main/socket-log-smoke.ts'),
          'stall-message-smoke': resolve('src/main/stall-message-smoke.ts'),
          'ui-trace-smoke': resolve('src/main/ui-trace-smoke.ts'),
          'approval-disclosure-smoke': resolve('src/main/approval-disclosure-smoke.ts'),
          'install-guard-smoke': resolve('src/main/install-guard-smoke.ts'),
          'approval-smoke': resolve('src/main/approval-smoke.ts'),
          'main-model-smoke': resolve('src/main/main-model-smoke.ts'),
          'approval-refusal-smoke': resolve('src/main/approval-refusal-smoke.ts'),
          'owner-promotion-smoke': resolve('src/main/owner-promotion-smoke.ts'),
          'approval-push-smoke': resolve('src/main/approval-push-smoke.ts'),
          'voice-smoke': resolve('src/main/voice-smoke.ts'),
          'voice-stream-smoke': resolve('src/main/voice-stream-smoke.ts'),
          'hands-free-smoke': resolve('src/main/hands-free-smoke.ts'),
          'search-smoke': resolve('src/main/search-smoke.ts'),
          'export-smoke': resolve('src/main/export-smoke.ts'),
          'artifacts-smoke': resolve('src/main/artifacts-smoke.ts'),
          'pane-link-smoke': resolve('src/main/pane-link-smoke.ts'),
          'checkpoints-smoke': resolve('src/main/checkpoints-smoke.ts'),
          'wiki-smoke': resolve('src/main/wiki-smoke.ts'),
          'wiki-frontmatter-smoke': resolve('src/main/wiki-frontmatter-smoke.ts'),
          'session-title-smoke': resolve('src/main/session-title-smoke.ts'),
          'devices-smoke': resolve('src/main/devices-smoke.ts'),
          'usage-smoke': resolve('src/main/usage-smoke.ts'),
          'background-smoke': resolve('src/main/background-smoke.ts'),
          'attachment-smoke': resolve('src/main/attachment-smoke.ts'),
          'forget-smoke': resolve('src/main/forget-smoke.ts'),
          'daemon-isolation-smoke': resolve('src/main/daemon-isolation-smoke.ts'),
          'daemon-folders-smoke': resolve('src/main/daemon-folders-smoke.ts'),
          'credential-origin-smoke': resolve('src/main/credential-origin-smoke.ts'),
          'identity-challenge-smoke': resolve('src/main/identity-challenge-smoke.ts'),
          'daemon-list-smoke': resolve('src/main/daemon-list-smoke.ts'),
          'instance-watch-smoke': resolve('src/main/instance-watch-smoke.ts'),
          'edit-address-smoke': resolve('src/main/edit-address-smoke.ts'),
          'panels-smoke': resolve('src/main/panels-smoke.ts'),
          'trust-smoke': resolve('src/main/trust-smoke.ts'),
          'ws-auth-smoke': resolve('src/main/ws-auth-smoke.ts'),
          'ws-replace-smoke': resolve('src/main/ws-replace-smoke.ts'),
          'ws-liveness-smoke': resolve('src/main/ws-liveness-smoke.ts'),
          'activity-frames-smoke': resolve('src/main/activity-frames-smoke.ts'),
          'session-groups-smoke': resolve('src/main/session-groups-smoke.ts'),
          'session-projects-smoke': resolve('src/main/session-projects-smoke.ts'),
          'session-windows-smoke': resolve('src/main/session-windows-smoke.ts'),
          'split-panes-smoke': resolve('src/main/split-panes-smoke.ts'),
          'session-sources-smoke': resolve('src/main/session-sources-smoke.ts'),
          'coding-smoke': resolve('src/main/coding-smoke.ts'),
          'computer-smoke': resolve('src/main/computer-smoke.ts'),
          'computer-door-smoke': resolve('src/main/computer-door-smoke.ts'),
          'timeline-smoke': resolve('src/main/timeline-smoke.ts'),
          'palette-smoke': resolve('src/main/palette-smoke.ts'),
          'documents-smoke': resolve('src/main/documents-smoke.ts'),
          'loop-smoke': resolve('src/main/loop-smoke.ts'),
          'nav-smoke': resolve('src/main/nav-smoke.ts'),
'integrations-smoke': resolve('src/main/integrations-smoke.ts'),
          'chat-home-smoke': resolve('src/main/chat-home-smoke.ts'),
          'composer-controls-smoke': resolve('src/main/composer-controls-smoke.ts'),
          'session-profile-smoke': resolve('src/main/session-profile-smoke.ts'),
          'session-fork-smoke': resolve('src/main/session-fork-smoke.ts'),
          'session-pins-smoke': resolve('src/main/session-pins-smoke.ts'),
          'provenance-smoke': resolve('src/main/provenance-smoke.ts'),
          'workers-smoke': resolve('src/main/workers-smoke.ts'),
          'retire-optimistic-smoke': resolve('src/main/retire-optimistic-smoke.ts'),
          'dictation-smoke': resolve('src/main/dictation-smoke.ts'),
          'theme-smoke': resolve('src/main/theme-smoke.ts'),
          'doc-redline-smoke': resolve('src/main/doc-redline-smoke.ts'),
          'pairing-smoke': resolve('src/main/pairing-smoke.ts'),
          'setup-wizard-smoke': resolve('src/main/setup-wizard-smoke.ts'),
          'setup-links-smoke': resolve('src/main/setup-links-smoke.ts'),
          'onboarding-smoke': resolve('src/main/onboarding-smoke.ts'),
          'onboarding-copy-smoke': resolve('src/main/onboarding-copy-smoke.ts'),
          'discovery-smoke': resolve('src/main/discovery-smoke.ts'),
          'hello-smoke': resolve('src/main/hello-smoke.ts'),
          'mac-check-smoke': resolve('src/main/mac-check-smoke.ts'),
          'download-estimate-smoke': resolve('src/main/download-estimate-smoke.ts'),
          'request-join-smoke': resolve('src/main/request-join-smoke.ts'),
          'approve-join-smoke': resolve('src/main/approve-join-smoke.ts'),
          'prometheus-install-smoke': resolve('src/main/prometheus-install-smoke.ts'),
          'tls-pin-smoke': resolve('src/main/tls-pin-smoke.ts'),
          'tls-enforce-smoke': resolve('src/main/tls-enforce-smoke.ts'),
          'join-tls-smoke': resolve('src/main/join-tls-smoke.ts'),
          'plain-lan-smoke': resolve('src/main/plain-lan-smoke.ts'),
          'discovery-confirm-smoke': resolve('src/main/discovery-confirm-smoke.ts'),
          'network-setting-smoke': resolve('src/main/network-setting-smoke.ts'),
          'openrouter-signin-smoke': resolve('src/main/openrouter-signin-smoke.ts'),
          'model-setup-smoke': resolve('src/main/model-setup-smoke.ts'),
          'model-keys-smoke': resolve('src/main/model-keys-smoke.ts'),
          'xai-oauth-smoke': resolve('src/main/xai-oauth-smoke.ts'),
          'model-auth-smoke': resolve('src/main/model-auth-smoke.ts'),
          'order-smoke': resolve('src/main/order-smoke.ts'),
          'real-history-smoke': resolve('src/main/real-history-smoke.ts'),
          'slash-smoke': resolve('src/main/slash-smoke.ts'),
          'at-references-smoke': resolve('src/main/at-references-smoke.ts'),
          'updater-smoke': resolve('src/main/updater-smoke.ts'),
          'screenshot-smoke': resolve('src/main/screenshot-smoke.ts'),
          'deeplink-smoke': resolve('src/main/deeplink-smoke.ts'),
          'connectors-smoke': resolve('src/main/connectors-smoke.ts'),
          'unlisted-session-smoke': resolve('src/main/unlisted-session-smoke.ts'),
          'purge-smoke': resolve('src/main/purge-smoke.ts'),
          'browser-smoke': resolve('src/main/browser-smoke.ts'),
          'browser-invariant-smoke': resolve('src/main/browser-invariant-smoke.ts'),
          'terminal-smoke': resolve('src/main/terminal-smoke.ts'),
          'shell-window-smoke': resolve('src/main/shell-window-smoke.ts'),
          'ipc-sender-smoke': resolve('src/main/ipc-sender-smoke.ts'),
          'side-panel-smoke': resolve('src/main/side-panel-smoke.ts'),
          'voice-gate-smoke': resolve('src/main/voice-gate-smoke.ts'),
          'shell-url-smoke': resolve('src/main/shell-url-smoke.ts'),
          'release-gate-smoke': resolve('src/main/release-gate-smoke.ts'),
          'legal-docs-smoke': resolve('src/main/legal-docs-smoke.ts'),
          'this-computer-smoke': resolve('src/main/this-computer-smoke.ts'),
          'owner-only-smoke': resolve('src/main/owner-only-smoke.ts'),
          'shipped-strings-smoke': resolve('src/main/shipped-strings-smoke.ts'),
          'plain-public-smoke': resolve('src/main/plain-public-smoke.ts'),
          'launch-047-smoke': resolve('src/main/launch-047-smoke.ts'),
          'backend-health-smoke': resolve('src/main/backend-health-smoke.ts'),
          'spellcheck-smoke': resolve('src/main/spellcheck-smoke.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin(), bundledPackages('preload')],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    plugins: [react(), bundledPackages('renderer')],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src')
      }
    },
    build: {
      // Never inline assets as data: URIs. The packaged CSP has no font-src, so a data: font
      // falls back to default-src 'self' and is REFUSED — Vite's default 4 KB inlining was
      // silently doing this to the small KaTeX faces (and one app face), packaged builds only.
      // Files are always 'self' and always load.
      assetsInlineLimit: 0
    }
  }
})
