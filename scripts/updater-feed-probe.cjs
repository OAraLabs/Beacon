/**
 * updater-feed-probe — does the shipped feed config build the PUBLIC provider, and stay public?
 *
 * The feed is OAraLabs/beacon, a public repo, and the app must never send a credential to it. The
 * library decides that in providerFactory, not in our code: it builds PrivateGitHubProvider (the
 * authenticated API path) when it finds a token, and with `private: true` it goes looking for one in
 * GH_TOKEN / GITHUB_TOKEN. A shell or CI launch has those set. So run the real library against the
 * real config, with a token in the environment, and read which provider it built.
 *
 * It needs a GUI Electron process (not ELECTRON_RUN_AS_NODE): on darwin `electron-updater` builds a
 * MacUpdater whose constructor reaches for Electron's `app`, which does not exist under
 * RUN_AS_NODE. It does NOT need a packaged build — setFeedURL never consults app.isPackaged.
 *
 *   npm run build && npm run probe:updater-feed
 */
const { readFileSync, readdirSync } = require('node:fs')
const { join } = require('node:path')
const { app } = require('electron')
const { autoUpdater } = require('electron-updater')

let failures = 0
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures += 1
}
const providerName = async () => {
  const p = await autoUpdater.clientPromise
  return p ? p.constructor.name : 'none'
}

app.whenReady().then(async () => {
  console.log('\n=== updater feed: the shipped config builds the public provider ===')

  // The FEED the built main bundle carries — read from the build output, not retyped here, so this
  // probes what ships. (updater-smoke pins FEED to electron-builder.yml's publish block.) Searched
  // across out/main, because rollup puts updater.ts in a shared chunk (the smoke imports it too).
  const defs = new Set()
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.js') && !e.name.endsWith('-smoke.js')) {
        for (const m of readFileSync(p, 'utf8').matchAll(/\bFEED\s*=\s*(\{[^}]*\})/g)) defs.add(m[1])
      }
    }
  }
  walk(join(__dirname, '..', 'out', 'main'))
  ok(defs.size === 1, 'found exactly one FEED in out/main (run `npm run build` first)', `${defs.size} found`)
  const feed = defs.size === 1 ? Function(`return (${[...defs][0]})`)() : {}
  ok(feed.owner === 'OAraLabs' && feed.repo === 'beacon', 'FEED names OAraLabs/beacon', JSON.stringify(feed))

  // 1. The control first: the library DOES switch providers on a token, or the checks below prove
  //    nothing. A token in the config is the one input that must flip it.
  autoUpdater.setFeedURL({ ...feed, token: 'ghp_shape_only_never_a_real_token' })
  const control = await providerName()
  ok(control === 'PrivateGitHubProvider', 'CONTROL: a token in the config does build the authenticated provider', control)

  // 2. The shipped config, with GH_TOKEN AND GITHUB_TOKEN set the way a shell or CI launch has them.
  process.env.GH_TOKEN = 'ghp_env_only_never_a_real_token'
  process.env.GITHUB_TOKEN = 'ghp_env_only_never_a_real_token'
  autoUpdater.setFeedURL({ ...feed })
  const shipped = await providerName()
  ok(shipped === 'GitHubProvider', 'the shipped feed builds the PUBLIC provider, environment tokens ignored', shipped)
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`)
  app.exit(failures === 0 ? 0 : 1)
})
