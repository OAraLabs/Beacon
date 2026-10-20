#!/usr/bin/env node
// Re-hash one release file after its bytes changed, and bring its update metadata back in step.
//
//   node scripts/rehash-update-file.mjs <artifact> <latest-*.yml>
//
// WHY. electron-builder hashes each artifact the moment it writes it: the `.blockmap` next to it and
// the file's sha512/size entry in latest-*.yml. Anything that changes the file afterwards leaves both
// stale. Stapling a notarization ticket to the dmg (release.yml) is exactly that: the ticket is
// appended to the file, so its size and sha512 change after electron-builder is done with it.
//
// This regenerates the blockmap with electron-builder's OWN routine (buildBlockMap, the same call
// createBlockmap makes; on the v0.3.0-dryrun.1 dmg it reproduces the published sha512, size and
// blockmap byte-for-byte), then rewrites the one matching `files[]` entry (and the top-level sha512
// when `path` names this file) with electron-builder's own YAML serializer.
//
// It refuses when the yml has no entry, or several, for the file: a rehash that matched nothing
// would leave the stale hash in place and exit 0. release.yml's publish-draft step re-checks every
// sha512 and size a feed names against the real file, so a stale entry cannot reach a draft anyway.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap.js')
const { serializeToYaml } = require('builder-util')
const yaml = require('js-yaml')

const [artifact, feedFile] = process.argv.slice(2)
if (!artifact || !feedFile || !existsSync(artifact) || !existsSync(feedFile)) {
  console.error('usage: node scripts/rehash-update-file.mjs <artifact> <latest-*.yml>  (both must exist)')
  process.exit(2)
}

const name = basename(artifact)
const feed = yaml.load(readFileSync(feedFile, 'utf8'))
const entries = (feed?.files ?? []).filter((f) => f?.url === name)
if (entries.length !== 1) {
  console.error(`✗ ${feedFile} has ${entries.length} entries for ${name}; expected exactly one`)
  process.exit(1)
}

const before = { sha512: entries[0].sha512, size: entries[0].size }
const info = await buildBlockMap(artifact, 'gzip', `${artifact}.blockmap`)
entries[0].sha512 = info.sha512
entries[0].size = info.size
if (feed.path === name) feed.sha512 = info.sha512
writeFileSync(feedFile, serializeToYaml(feed))

const changed = before.sha512 !== info.sha512 || before.size !== info.size
console.log(
  `✓ ${name}: ${changed ? 'rehashed' : 'unchanged'} — size ${before.size} → ${info.size}, ` +
    `sha512 ${String(before.sha512).slice(0, 12)}… → ${info.sha512.slice(0, 12)}…; ${name}.blockmap rewritten`
)
