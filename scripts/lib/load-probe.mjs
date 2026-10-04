#!/usr/bin/env node
// Load probe — prove that THIS DSH installation can actually load the plugin.
//
//   node scripts/lib/load-probe.mjs --dsh-app "<DeepSeek Harness.exe>" \
//        --home "<dsh home>" --profile desktop [--plugin <dir>] [--json]
//
// The plugin is imported through the same runtime resolution DSH itself uses,
// so a PASS means the module graph (`@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`)
// really resolves for this installation and `apply()` really registers its tools.
// If the DSH app is an Electron binary this file re-executes itself under
// ELECTRON_RUN_AS_NODE, because the asar-hosted modules can only be imported there.
//
// Read-only: it never writes to the profile.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { buildResolution, dshHomeOf, findDshApp } from './runtime.mjs'

const WORKER = new URL('./load-probe-worker.mjs', import.meta.url)
const SELF = fileURLToPath(import.meta.url)

const argv = process.argv.slice(2)
const opt = { reexeced: false, json: false, timeoutMs: 60000 }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--dsh-app') opt.dshApp = argv[++i]
  else if (a === '--home') opt.home = argv[++i]
  else if (a === '--profile') opt.profile = argv[++i]
  else if (a === '--plugin') opt.plugin = argv[++i]
  else if (a === '--json') opt.json = true
  else if (a === '--reexec') opt.reexeced = true
  else if (a === '--timeout-ms') opt.timeoutMs = Number(argv[++i])
  else if (a === '-h' || a === '--help') {
    console.log(`usage: node scripts/lib/load-probe.mjs --dsh-app <exe> --profile <name> [--home <dir>] [--plugin <dir>] [--json]`)
    process.exit(0)
  } else { console.error(`load-probe: unknown argument ${a}`); process.exit(2) }
}

const dshApp = findDshApp(opt.dshApp)
const dshHome = dshHomeOf(opt.home)
const profile = opt.profile

if (!dshApp) { console.error('load-probe: could not find the DSH application; pass --dsh-app <exe>'); process.exit(2) }
if (!profile) { console.error('load-probe: --profile <name> is required'); process.exit(2) }

// app.asar can only be imported from the Electron binary, so a plain `node`
// run hands over to the app in ELECTRON_RUN_AS_NODE mode.
if (!opt.reexeced) {
  opt.reexeced = true
  if (!process.versions.electron) {
    const r = spawnSync(dshApp, [SELF, ...argv, '--reexec'], {
      stdio: 'inherit',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    process.exit(r.status ?? 1)
  }
}

const profileDir = join(dshHome, 'profiles', profile)
if (!existsSync(join(profileDir, 'package.json'))) { console.error(`load-probe: no profile "${profile}" at ${profileDir}`); process.exit(2) }

// --plugin: probe that directory instead of the copy installed in the profile.
// Otherwise list every installed DSH bundle package in the profile, preferring
// the one that owns this script (a checkout normally probes itself).
// A bundle package's host entry is `main`, else the root `exports` condition,
// else index.js — the same order Node itself uses. (dsh-comfyui-agent ships
// `main: null` and only `exports["."]`, so reading `main` alone misses it.)
function entryOf(dir, manifest) {
  const exp = manifest?.exports
  const root = typeof exp === 'string' ? exp : exp?.['.']
  const fromExports = typeof root === 'string' ? root : (root?.default || root?.import)
  return join(dir, manifest?.main || fromExports || 'index.js')
}

function installedPluginDirs(profileDir2, selfName) {
  const manifest = readManifest(join(profileDir2, 'package.json'))
  if (!manifest) return []
  const nm = join(profileDir2, 'node_modules')
  const found = []
  for (const dep of Object.keys(manifest.dependencies || {})) {
    if (dep.startsWith('@deepseek-ai/')) continue
    const dir = join(nm, dep)
    const m = readManifest(join(dir, 'package.json'))
    if (m?.dsh?.bundle?.patch && existsSync(entryOf(dir, m))) found.push(dir)
  }
  const score = (dir) => (readManifest(join(dir, 'package.json'))?.name === selfName ? -1 : 0)
  return found.sort((a, b) => score(a) - score(b))
}
function readManifest(path) {
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SELF_DIR, '..', '..')
const selfName = readManifest(join(REPO_ROOT, 'package.json'))?.name ?? null
const candidates = opt.plugin ? [opt.plugin] : installedPluginDirs(profileDir, selfName)
if (!candidates.length) {
  console.error(`load-probe: profile "${profile}" has no installed DSH bundle package; pass --plugin <dir>`)
  process.exit(2)
}

let built
try {
  built = await buildResolution({ dshApp, home: dshHome, profile, linkRoots: candidates })
} catch (err) {
  console.error(`load-probe: could not build the runtime resolution: ${err?.message || err}`)
  process.exit(1)
}

const worker = new Worker(WORKER, {
  workerData: {
    pluginDir: built.pluginEntries[0].dir,
    bootstrapUrl: built.bootstrapUrl,
    timeoutMs: opt.timeoutMs,
    context: {
      profile,
      dshHome,
      dshApp,
      runtime: { dshTools: built.dshTools, schemastery: built.resolution.entries?.find((e) => e.name === '@deepseek-ai/schemastery')?.version ?? null },
      packageCount: built.resolution.entries?.length ?? null,
    },
  },
})

const result = await new Promise((res) => {
  const timer = setTimeout(() => res({ ok: false, error: `probe timed out after ${opt.timeoutMs} ms` }), opt.timeoutMs)
  worker.once('message', (m) => { clearTimeout(timer); res(m) })
  worker.once('error', (err) => { clearTimeout(timer); res({ ok: false, error: String(err?.stack || err) }) })
})
try { await worker.terminate() } catch {}

if (opt.json) {
  console.log(JSON.stringify(result, null, 2))
} else if (result.ok) {
  console.log(`\u2714 ${result.name}@${result.version} loads on this DSH runtime`)
  console.log(`  profile    ${profile} (${result.context?.packageCount ?? '?'} packages in the resolution)`)
  console.log(`  dsh-tools  ${result.context?.runtime?.dshTools ?? 'unknown'}`)
  console.log(`  tools      ${result.toolCount}: ${result.tools.join(', ')}`)
  console.log(`  prompts    ${result.promptSections.join(', ') || '(none)'}`)
  if (result.warnings?.length) for (const w of result.warnings) console.log(`  note       ${w}`)
} else {
  console.error(`\u2718 ${basename(candidates[0])} failed to load: ${result.error}`)
  if (result.stack) console.error(result.stack)
}
process.exit(result.ok ? 0 : 1)
