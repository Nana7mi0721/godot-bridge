#!/usr/bin/env node
// godot-bridge installer — transparent `dsh plugin add` for the profile you
// actually use (including the Desktop profile, which the plain `dsh` CLI
// refuses: `error: profile "desktop" is managed exclusively by the Electron
// application`).
//
//   node scripts/install.mjs --list
//   node scripts/install.mjs --profile desktop
//   node scripts/install.mjs --profile desktop --link E:/path/to/godot-bridge
//   node scripts/install.mjs --profile desktop --spec github:Nana7mi0721/godot-bridge#v0.2.1
//   node scripts/install.mjs --profile desktop --remove
//
// It never hand-edits cordis.patch.yml: the package's `dsh.bundle.patch`
// manifest field is what the loader composes, so installing the dependency and
// listing the bundle name in `dsh.profile.bundles` is the whole job.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SELF_DIR, '..')
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
const BUNDLE_NAME = PKG.name

// ── tiny argv parser ──────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const opt = { profile: null, spec: null, link: null, list: false, remove: false, dryRun: false, json: false, dshApp: null, home: null, yes: false }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--profile') opt.profile = argv[++i]
  else if (a === '--spec') opt.spec = argv[++i]
  else if (a === '--link') opt.link = argv[++i]
  else if (a === '--dsh-app') opt.dshApp = argv[++i]
  else if (a === '--home') opt.home = argv[++i]
  else if (a === '--list') opt.list = true
  else if (a === '--remove') opt.remove = true
  else if (a === '--dry-run') opt.dryRun = true
  else if (a === '--json') opt.json = true
  else if (a === '-y' || a === '--yes') opt.yes = true
  else if (a === '-h' || a === '--help') { usage(); process.exit(0) }
  else { fail(`unknown argument: ${a}`) }
}

function usage() {
  console.log(`godot-bridge installer (${BUNDLE_NAME}@${PKG.version})

  node scripts/install.mjs --list
  node scripts/install.mjs --profile <name> [--spec <pnpm spec>] [--link <dir>] [--remove]

Options
  --profile <name>  target dsh profile under $DSH_HOME/profiles (required to install)
  --spec <spec>     pnpm dependency spec; default github:Nana7mi0721/godot-bridge
                    (also accepts npm:<pkg>@<ver>, file:<tarball>, or a URL)
  --link <dir>      install this working copy instead (pnpm "link:" semantics).
                    Local development uses this; it requires the package's
                    peerDependencies to be declared, which they are.
  --dsh-app <exe>   path to the DSH desktop executable (auto-detected when omitted)
  --home <dir>      $DSH_HOME (default: DSH_HOME or ~/.dsh)
  --remove          uninstall (dependency + bundle entry)
  --dry-run         print what would change, touch nothing
  --json            machine-readable output
  -h, --help        this text

Why this exists
  \`dsh plugin --profile desktop add ...\` fails with
  "profile \\"desktop\\" is managed exclusively by the Electron application".
  The Electron shell calls the very same CLI with Desktop-profile management
  enabled, so this script does exactly that — the resulting profile state is
  identical to installing the plugin from the in-app plugin page.
`)
}

function fail(msg) {
  console.error(`install: error: ${msg}`)
  process.exit(1)
}
const info = (m) => { if (!opt.json) console.log(m) }

// ── dsh home / profile discovery ──────────────────────────────────────────
const dshHome = opt.home || process.env.DSH_HOME || join(homedir(), '.dsh')
if (!existsSync(dshHome)) fail(`no DSH home at ${dshHome} (pass --home)`)

const profilesDir = join(dshHome, 'profiles')
if (!existsSync(profilesDir)) fail(`no profiles directory at ${profilesDir}`)

function listProfiles() {
  return readdirSync(profilesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(profilesDir, d.name, 'package.json')))
    .map((d) => {
      const dir = join(profilesDir, d.name)
      let manifest = {}
      try { manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, '')) } catch {}
      const deps = manifest.dependencies || {}
      const bundles = manifest.dsh?.profile?.bundles || []
      return {
        name: d.name,
        dir,
        installed: Boolean(deps[BUNDLE_NAME]),
        spec: deps[BUNDLE_NAME] || null,
        bundleListed: bundles.includes(BUNDLE_NAME),
        dependencyCount: Object.keys(deps).length,
        nodeModules: existsSync(join(dir, 'node_modules')),
      }
    })
}

if (opt.list) {
  const profiles = listProfiles()
  if (opt.json) console.log(JSON.stringify({ dshHome, profiles }, null, 2))
  else {
    console.log(`DSH home: ${dshHome}`)
    for (const p of profiles) {
      const state = p.installed ? `installed (${p.spec})${p.bundleListed ? '' : ' [NOT in dsh.profile.bundles!]'}` : 'not installed'
      console.log(`  ${p.name.padEnd(12)} ${String(p.dependencyCount).padStart(2)} deps  ${state}`)
    }
  }
  process.exit(0)
}

if (!opt.profile) fail('--profile <name> is required (use --list to see the profiles)')
const profileDir = join(profilesDir, opt.profile)
if (!existsSync(join(profileDir, 'package.json'))) fail(`no profile "${opt.profile}" at ${profileDir}`)
const manifestPath = join(profileDir, 'package.json')

const spec = opt.link
  ? 'link:' + resolve(opt.link).replace(/\\/g, '/')
  : (opt.spec || `github:Nana7mi0721/godot-bridge#v${PKG.version}`)

// ── locate a runnable dsh CLI (the Electron-carried one always works) ─────
function findDshApp() {
  if (opt.dshApp) return opt.dshApp
  const candidates = [
    process.env.DSH_APP,
    'D:/Program/deepseek harness desktop/DeepSeek Harness.exe',
    join(process.env.LOCALAPPDATA || '', 'Programs/DeepSeek Harness/DeepSeek Harness.exe'),
    join(process.env.LOCALAPPDATA || '', 'DeepSeek Harness/DeepSeek Harness.exe'),
    '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
  ].filter(Boolean)
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

// The desktop profile is reserved by the Electron shell, so the CLI entry in
// the installation has to be driven through that shell: scripts/lib/run-cli.mjs
// imports its `runCli` and passes `manageDesktopProfile: true` — the same flag
// the app itself uses. That thin wrapper needs the executable, so keep the path
// around for it.
const dshApp = findDshApp()
if (!opt.dryRun && !dshApp) {
  fail('could not find the DSH desktop executable; pass --dsh-app <path to "DeepSeek Harness.exe">')
}

const actions = []

// ── 1. dependency ─────────────────────────────────────────────────────────
function pnpmArgs() {
  const a = ['plugin', '--profile', opt.profile]
  if (opt.remove) a.push('remove', BUNDLE_NAME)
  else if (opt.link) a.push('add', `link:${resolve(opt.link).replace(/\\/g, '/')}`)
  else a.push('add', spec)
  return a
}

function runCli(args) {
  // Electron is the runtime the CLI expects (it also reads its own bundled
  // packages); ELECTRON_RUN_AS_NODE makes it behave like plain node.
  const wrapper = join(REPO_ROOT, 'scripts', 'lib', 'run-cli.mjs')
  const res = spawnSync(dshApp, [wrapper, '--dsh-app', dshApp, ...args], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  return res.status ?? 1
}

actions.push({ step: 'dependency', detail: `dsh plugin --profile ${opt.profile} ${opt.remove ? 'remove' : 'add'} ${opt.remove ? BUNDLE_NAME : spec}` })

// ── 2. bundle list (re-planned after pnpm writes the dependency) ──────────
function readManifest() {
  return JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
}
function planBundleEdit() {
  const manifest = readManifest()
  manifest.dependencies ||= {}
  manifest.dsh ||= {}
  manifest.dsh.profile ||= {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : (manifest.dsh.profile.bundles = [])
  const listed = bundles.includes(BUNDLE_NAME)
  if (opt.remove) {
    if (!listed) return { needed: false, manifest }
    manifest.dsh.profile.bundles = bundles.filter((b) => b !== BUNDLE_NAME)
  } else {
    if (listed) return { needed: false, manifest }
    bundles.push(BUNDLE_NAME)
  }
  return { needed: true, manifest }
}
const bundleEdit = planBundleEdit()
actions.push({
  step: 'dsh.profile.bundles',
  detail: bundleEdit.needed ? (opt.remove ? `remove ${BUNDLE_NAME}` : `add ${BUNDLE_NAME}`) : 'already correct',
})

if (opt.dryRun) {
  const out = { dshHome, profile: opt.profile, profileDir, spec: opt.remove ? null : spec, dshApp, dryRun: true, actions }
  if (opt.json) process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  else for (const a of actions) console.log(`would ${a.step}: ${a.detail}`)
  process.exit(0)
}

// ── execute ───────────────────────────────────────────────────────────────
if (!opt.json) {
  info(`profile: ${opt.profile} (${profileDir})`)
  info(`dsh cli: ${dshApp || '(not found)'}`)
}
const status = runCli(pnpmArgs())
if (status !== 0) fail(`pnpm exited with ${status} (see the output above)`)

// Re-read the manifest AFTER pnpm ran: pnpm writes the dependency itself, so
// editing a manifest captured earlier would silently undo its write.
const applied = planBundleEdit()

if (applied.needed) {
  const backup = `${manifestPath}.bak-godot-bridge-${new Date().toISOString().replace(/[:.]/g, '-')}`
  writeFileSync(backup, readFileSync(manifestPath, 'utf8'))
  writeFileSync(manifestPath, JSON.stringify(applied.manifest, null, 2) + '\n')
  if (!opt.json) info(`updated dsh.profile.bundles (backup: ${backup})`)
}

// ── verify ────────────────────────────────────────────────────────────────
const after = listProfiles().find((p) => p.name === opt.profile)
const ok = opt.remove ? !after.installed : after.installed && after.bundleListed
if (opt.json) {
  console.log(JSON.stringify({ ok, profile: after, spec: opt.remove ? null : spec, dshHome }, null, 2))
} else {
  info('')
  info(ok
    ? (opt.remove
      ? `\u2714 ${BUNDLE_NAME} was removed from profile "${opt.profile}".`
      : `\u2714 ${BUNDLE_NAME} is installed in profile "${opt.profile}".`)
    : `\u2718 ${opt.remove ? 'removal' : 'installation'} incomplete for profile "${opt.profile}".`)
  if (!opt.remove) {
    info(`  dependency: ${after.spec}`)
    info(`  bundle entry: ${after.bundleListed ? BUNDLE_NAME : '(missing — the plugin will not load!)'}`)
    info('')
    info('Next: restart DeepSeek Harness (plugin bundles are composed at boot), then run')
    info(`  node ${join('scripts', 'doctor.mjs')} --profile ${opt.profile}`)
  } else {
    info('Restart DeepSeek Harness to drop the plugin tools from the running session.')
  }
}
process.exit(ok ? 0 : 1)
