#!/usr/bin/env node
/**
 * Diagnose why a DSH profile bundle fails to load its harness (`@deepseek-ai/*`)
 * imports — the failure mode behind "the plugin's tools disappeared after a DSH
 * upgrade".
 *
 * It reuses the *installed* DSH launcher code instead of guessing:
 *   - loads the profile through @deepseek-ai/dsh-app-boot (asar-aware, so it must
 *     run under the DSH application's Electron in Node mode — this script
 *     re-executes itself that way automatically);
 *   - builds the same immutable runtime resolution the launcher installs;
 *   - installs it in a worker through the app-boot worker bootstrap and imports
 *     the plugin entry, reporting the real resolution outcome.
 *
 * Usage:
 *   node scripts/diagnose-dsh-resolution.mjs [options]
 *
 * Options:
 *   --dsh-app <path>   DSH executable (default: %LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe)
 *   --home <dir>       DSH home (default: $DSH_HOME or ~/.dsh)
 *   --profile <name>   profile under <home>/profiles (default: $DSH_PROFILE or desktop)
 *   --repo <dir>       emulate a *linked root* for this plugin checkout (a `link:`
 *                      profile dependency) without touching the real profile
 *   --target <file>    entry file to import (repeatable; default: this package's main)
 *   --expect <ok|fail> exit non-zero when the outcome differs
 *   --json             machine-readable report
 *
 * Notes:
 *   - Read-only: the profile directory is only read (never rewritten) and no
 *     symlink is created, so this can run while the app is open.
 *   - Relies on undocumented harness internals (app-boot's resolver module
 *     layout); treat it as a development diagnostic and re-check it after a DSH
 *     upgrade.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { setEnvironmentData, Worker } from 'node:worker_threads'

const SEP = process.platform === 'win32' ? '\\' : '/'
const scriptPath = fileURLToPath(import.meta.url)
const root = resolve(dirname(scriptPath), '..')
const RESOLUTION_KEY = '@deepseek-ai/dsh-app-boot/profile-resolution'
// A BOM is legal in files edited on Windows; Node strips it when loading
// package.json, so every JSON read here must tolerate it as well.
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))

function parseArguments(argv) {
  const options = { targets: [] }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--json') options.json = true
    else if (flag === '--expect') options.expect = (value ?? '').toLowerCase(), index++
    else if (flag === '--dsh-app') options.dshApp = value, index++
    else if (flag === '--home') options.home = value, index++
    else if (flag === '--profile') options.profile = value, index++
    else if (flag === '--repo') options.repo = value, index++
    else if (flag === '--target') options.targets.push(value), index++
    else if (flag === '--help' || flag === '-h') options.help = true
    else {
      console.error(`diagnose-dsh-resolution: unknown argument ${flag}`)
      process.exit(2)
    }
  }
  return options
}

function defaultDshApp() {
  if (process.platform !== 'win32') return undefined
  const local = process.env.LOCALAPPDATA
  return local === undefined ? undefined : join(local, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')
}

const options = parseArguments(process.argv.slice(2))
if (options.help) {
  console.log(readFileSync(scriptPath, 'utf8').split('*/')[0].replace(/^#![^\n]*\n/, ''))
  process.exit(0)
}

const dshApp = options.dshApp ?? defaultDshApp()
if (!process.versions.electron) {
  // The app-boot package lives inside the application's asar archive, which only
  // the DSH Electron binary can read: relaunch ourselves through it.
  if (dshApp === undefined || !existsSync(dshApp)) {
    console.error('diagnose-dsh-resolution: cannot find the DSH application.')
    console.error('  Pass --dsh-app "<path to DeepSeek Harness.exe>" (Electron is required to read the harness packages inside app.asar).')
    process.exit(2)
  }
  const relay = spawnSync(dshApp, [scriptPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  process.exit(relay.status ?? 1)
}

const home = resolve(options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const profileName = options.profile ?? process.env.DSH_PROFILE ?? 'desktop'
const profileDir = join(home, 'profiles', profileName)
const installAnchor = join(dshApp.replace(/[^\\/]+$/, ''), 'resources', 'app.asar', 'dsh', 'package.json')
const appBootUrl = pathToFileURL(join(dirname(installAnchor), 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href
const bootstrapUrl = pathToFileURL(join(dirname(installAnchor), 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'worker', 'profile-resolution-bootstrap.js')).href
const workerUrl = new URL('./lib/resolution-probe-worker.mjs', import.meta.url)

const report = { dshApp, home, profile: profileName, profileDir, layers: [], skipped: [], linkedRoots: [], imports: [], results: [] }

if (!existsSync(profileDir)) {
  console.error(`diagnose-dsh-resolution: profile directory does not exist: ${profileDir}`)
  process.exit(2)
}

const appBoot = await import(appBootUrl)
const profile = appBoot.loadProfileDirectory('dsh', profileDir, installAnchor, { userLayer: true })
report.layers = profile.layers.map((layer) => layer.packageName)
report.skipped = profile.skippedBundles.map((skipped) => ({ packageName: skipped.packageName, reason: String(skipped.reason) }))

const computed = await appBoot.createRuntimeResolution({ installAnchor, profile, home })
const repoRoot = options.repo === undefined ? undefined : resolve(options.repo)
let resolution = computed
if (repoRoot !== undefined) {
  const repoManifest = join(repoRoot, 'package.json')
  if (!existsSync(repoManifest)) {
    console.error(`diagnose-dsh-resolution: --repo has no package.json: ${repoRoot}`)
    process.exit(2)
  }
  const name = readJson(repoManifest).name
  // Exactly the launcher's own linked-root shape, added to a freshly computed
  // resolution (no file is created or rewritten).
  resolution = Object.freeze({
    ...computed,
    linkedRoots: Object.freeze([...computed.linkedRoots, Object.freeze({ name, realPath: repoRoot })]),
  })
}
report.linkedRoots = resolution.linkedRoots.map((entry) => ({ name: entry.name, realPath: entry.realPath }))

// Harness packages the entry imports, and whether the resolution supplies them.
const packageRoot = repoRoot ?? root
const manifest = readJson(join(packageRoot, 'package.json'))
const entryFiles = options.targets.length > 0 ? options.targets.map((target) => resolve(target)) : [join(packageRoot, manifest.main)]
const STATIC_FROM = /^\s*(?:import|export)\b[^\n]*?\bfrom\s*['"]([^'"]+)['"]/
const STATIC_SIDE_EFFECT = /^\s*import\s*['"]([^'"]+)['"]/
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const barePackageName = (specifier) => (specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0])
for (const file of entryFiles) {
  const text = readFileSync(file, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const found = []
    const staticMatch = STATIC_FROM.exec(line) ?? STATIC_SIDE_EFFECT.exec(line)
    if (staticMatch) found.push(staticMatch[1])
    for (const dynamic of line.matchAll(DYNAMIC_IMPORT)) found.push(dynamic[1])
    for (const specifier of found) {
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':') || specifier.startsWith('#')) continue
      const name = barePackageName(specifier)
      const entry = resolution.entries.find((candidate) => candidate.name === name)
      report.imports.push({ file, specifier, resolution: entry === undefined ? 'absent' : `${entry.name}@${entry.version} (${entry.scope})` })
    }
  }
}

const targets = [...new Set(entryFiles.map((file) => pathToFileURL(file).href))]
// Node's ESM resolver resolves a profile symlink to its real path before a
// module's own imports are resolved, so importing the real path above is the
// same code path the Loader takes; no separate symlink target is needed.

setEnvironmentData(RESOLUTION_KEY, { resolution })
await new Promise((settle) => {
  const worker = new Worker(workerUrl, { workerData: { targets: [...new Set(targets)], bootstrapUrl } })
  worker.on('message', (message) => report.results.push(message))
  worker.on('error', (error) => report.results.push({ target: '(worker)', ok: false, code: error.code ?? null, message: String(error.message ?? error) }))
  worker.on('exit', () => settle())
})

const failed = report.results.filter((result) => !result.ok)
if (options.json) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`DSH app        : ${report.dshApp}`)
  console.log(`DSH home       : ${report.home}`)
  console.log(`profile        : ${report.profile} (${report.profileDir})`)
  console.log(`bundle layers  : ${report.layers.join(', ') || '(none)'}`)
  console.log(`skipped bundles: ${report.skipped.length === 0 ? '(none)' : report.skipped.map((skipped) => `${skipped.packageName}: ${skipped.reason}`).join('; ')}`)
  console.log(`linked roots   : ${report.linkedRoots.length === 0 ? '(none)' : report.linkedRoots.map((entry) => `${entry.name} -> ${entry.realPath}`).join(', ')}`)
  for (const item of report.imports) console.log(`import         : ${item.specifier} -> ${item.resolution}`)
  for (const result of report.results) {
    console.log(`${result.ok ? 'OK  ' : 'FAIL'}           : ${result.target}`)
    console.log(`                 ${result.ok ? `exports: ${result.exports}` : `${result.code ?? ''} ${result.message}`}`)
  }
  if (failed.length > 0) {
    console.log('')
    console.log('A failing import of an @deepseek-ai/* package means the profile bundle cannot load.')
    console.log('For a linked root (`link:` install) declare every imported harness package in the')
    console.log('plugin\'s own "peerDependencies" — see README "DSH 0.2+ compatibility".')
  }
}

if (options.expect === 'ok' && failed.length > 0) process.exit(1)
if (options.expect === 'fail' && failed.length === 0) process.exit(1)
process.exit(0)
