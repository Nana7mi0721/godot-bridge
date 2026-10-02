#!/usr/bin/env node
// godot-bridge doctor — answer "why doesn't the plugin work?" with evidence
// instead of guesses.
//
//   node scripts/doctor.mjs                       # check the DSH home it can find
//   node scripts/doctor.mjs --profile desktop
//   node scripts/doctor.mjs --profile desktop --godot "C:/Godot/Godot_v4.exe"
//   node scripts/doctor.mjs --profile desktop --json
//   node scripts/doctor.mjs --profile desktop --deep      # + real module load probe
//
// Checks, in order:
//   1  environment      node, DSH home, profile directory
//   2  profile state    dependency spec, dsh.profile.bundles entry, node_modules
//   3  plugin payload   entry file, client half, required manifest fields
//   4  godot engine     the godotPath setting / PATH / auto-discovery, --version
//   5  compatibility    DSH runtime version vs the ranges this fork was tested on
//   6  known traps      git proxy, a `godot` that is not Godot, desktop profile CLI
//   7  runtime load     (--deep) import the plugin the way DSH does and count tools

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SELF_DIR, '..')
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
const COMPAT = PKG.godotBridge?.compat ?? {}
const BUNDLE_NAME = PKG.name

const argv = process.argv.slice(2)
const opt = { profile: null, godot: null, home: null, dshApp: null, json: false, deep: false, quiet: false }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--profile') opt.profile = argv[++i]
  else if (a === '--godot') opt.godot = argv[++i]
  else if (a === '--home') opt.home = argv[++i]
  else if (a === '--dsh-app') opt.dshApp = argv[++i]
  else if (a === '--json') opt.json = true
  else if (a === '--deep') opt.deep = true
  else if (a === '--quiet') opt.quiet = true
  else if (a === '-h' || a === '--help') {
    console.log(`godot-bridge doctor ${PKG.version}

  node scripts/doctor.mjs [--profile <name>] [--godot <exe>] [--deep] [--json]

  --profile <name>  profile to inspect (default: DSH_PROFILE, else every profile)
  --godot <exe>     Godot executable to check (default: the plugin setting, then PATH)
  --deep            also import the plugin through the real DSH runtime resolution
  --json            machine-readable report
`)
    process.exit(0)
  } else { console.error(`doctor: unknown argument ${a}`); process.exit(2) }
}

const checks = []
const add = (id, status, title, detail, fix) => checks.push({ id, status, title, detail, fix })
const OK = 'ok', WARN = 'warn', FAIL = 'fail', SKIP = 'skip'

// ── semver-lite (only what the compatibility report needs) ────────────────
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null }
}
function cmpVersion(a, b) {
  if (!a || !b) return null
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1 // release > prerelease
  if (b.pre === null) return -1
  return a.pre < b.pre ? -1 : a.pre > b.pre ? 1 : 0
}
function satisfies(version, range) {
  const v = parseVersion(version)
  if (!v) return null
  for (const part of String(range).split('||').map((s) => s.trim())) {
    const m = /^(>=|>|<=|<|=|\^|~)?\s*v?(.+)$/.exec(part)
    if (!m) continue
    const op = m[1] || '='
    const bound = parseVersion(m[2])
    if (!bound) continue
    const c = cmpVersion(v, bound)
    let hit
    if (op === '>=') hit = c >= 0
    else if (op === '>') hit = c > 0
    else if (op === '<=') hit = c <= 0
    else if (op === '<') hit = c < 0
    else if (op === '^') hit = c >= 0 && v.major === bound.major
    else if (op === '~') hit = c >= 0 && v.major === bound.major && v.minor === bound.minor
    else hit = c === 0
    if (hit) return true
  }
  return false
}

// ── 1. environment ────────────────────────────────────────────────────────
const nodeMajor = Number(process.versions.node.split('.')[0])
add('node', nodeMajor >= 20 ? OK : nodeMajor >= 18 ? WARN : FAIL, 'Node.js runtime',
  `v${process.versions.node}`, nodeMajor >= 20 ? null : 'DSH 0.2 needs Node 20+; upgrade Node.')

const dshHome = opt.home || process.env.DSH_HOME || join(homedir(), '.dsh')
add('dsh-home', existsSync(dshHome) ? OK : FAIL, 'DSH home', dshHome,
  existsSync(dshHome) ? null : 'Pass --home <dir> or set DSH_HOME.')

const profilesDir = join(dshHome, 'profiles')
const profiles = existsSync(profilesDir)
  ? readdirSync(profilesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(profilesDir, d.name, 'package.json')))
    .map((d) => d.name)
  : []
add('profiles', profiles.length ? OK : FAIL, 'DSH profiles',
  profiles.length ? `${profiles.join(', ')} (under ${profilesDir})` : `none found under ${profilesDir}`,
  profiles.length ? null : 'Is this really the DSH home? The Electron app manages profiles under <home>/profiles.')

const targets = opt.profile ? [opt.profile] : (process.env.DSH_PROFILE && profiles.includes(process.env.DSH_PROFILE) ? [process.env.DSH_PROFILE] : profiles)
if (opt.profile && !profiles.includes(opt.profile)) {
  add('profile', FAIL, 'Selected profile', `"${opt.profile}" is not a profile under ${profilesDir}`,
    `Use one of: ${profiles.join(', ')}`)
}

// ── locate the DSH installation (for version + runtime resolution) ────────
function findDshApp() {
  const candidates = [
    opt.dshApp, process.env.DSH_APP,
    'D:/Program/deepseek harness desktop/DeepSeek Harness.exe',
    join(process.env.LOCALAPPDATA || '', 'Programs/DeepSeek Harness/DeepSeek Harness.exe'),
    join(process.env.LOCALAPPDATA || '', 'DeepSeek Harness/DeepSeek Harness.exe'),
    '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
  ].filter(Boolean)
  return candidates.find((c) => existsSync(c)) || null
}
const dshApp = findDshApp()
const asarDsh = dshApp ? join(dirname(dshApp), 'resources', 'app.asar', 'dsh') : null
const asarCli = asarDsh ? join(asarDsh, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') : null
add('dsh-install', dshApp ? OK : WARN, 'DSH installation',
  dshApp ? dshApp : 'not found (runtime-load probe disabled)',
  dshApp ? null : 'Pass --dsh-app "<path to DeepSeek Harness.exe>".')

// app.asar is not readable by a plain Node process, so read the bundled runtime
// manifest through the Electron binary in ELECTRON_RUN_AS_NODE mode.
let dshVersion = null
if (dshApp && asarDsh) {
  const probe = spawnSync(dshApp, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(asarDsh, 'package.json'))}, 'utf8'))`], {
    encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30000,
  })
  try { dshVersion = JSON.parse(probe.stdout).version } catch { dshVersion = null }
}

// ── the plugin's own payload ──────────────────────────────────────────────
function loadManifest(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

// ── per-profile checks ────────────────────────────────────────────────────
function resolveInstalledDir(profileDir) {
  const direct = join(profileDir, 'node_modules', BUNDLE_NAME)
  if (existsSync(direct)) {
    try {
      // pnpm's link: and file: installs are symlinks/junctions to a real dir.
      const real = statSync(direct).isDirectory() ? direct : direct
      return real
    } catch { return direct }
  }
  return null
}

const reports = []
for (const name of targets) {
  const profileDir = join(profilesDir, name)
  const entry = { profile: name, dir: profileDir, checks: [] }
  const push = (c) => { entry.checks.push(c); checks.push({ ...c, id: `${name}:${c.id}` }) }
  const manifest = loadManifest(profileDir)
  if (!manifest) {
    push({ id: 'manifest', status: FAIL, title: 'profile manifest', detail: `${profileDir}/package.json unreadable`, fix: null })
    reports.push(entry); continue
  }
  const deps = manifest.dependencies || {}
  const bundles = manifest.dsh?.profile?.bundles || []
  const spec = deps[BUNDLE_NAME] || null
  push({
    id: 'dependency', status: spec ? OK : FAIL, title: 'dependency',
    detail: spec ? `${BUNDLE_NAME} = ${spec}` : `${BUNDLE_NAME} is not in dependencies`,
    fix: spec ? null : `node scripts/install.mjs --profile ${name}`,
  })
  push({
    id: 'bundle', status: bundles.includes(BUNDLE_NAME) ? OK : FAIL, title: 'dsh.profile.bundles',
    detail: bundles.includes(BUNDLE_NAME) ? `includes "${BUNDLE_NAME}"` : `"${BUNDLE_NAME}" missing — the plugin will never load`,
    fix: bundles.includes(BUNDLE_NAME) ? null : `node scripts/install.mjs --profile ${name}`,
  })
  const installedDir = resolveInstalledDir(profileDir)
  push({
    id: 'node_modules', status: installedDir ? OK : FAIL, title: 'installed package',
    detail: installedDir || `no ${profileDir}/node_modules/${BUNDLE_NAME}`,
    fix: installedDir ? null : `node scripts/install.mjs --profile ${name}`,
  })

  let installedManifest = installedDir ? loadManifest(installedDir) : null
  if (installedManifest) {
    const missing = []
    if (!installedManifest.main) missing.push('main')
    if (!installedManifest.dsh?.bundle?.patch) missing.push('dsh.bundle.patch')
    if (!installedManifest.dsh?.client) missing.push('dsh.client')
    if (!installedManifest.peerDependencies?.['@deepseek-ai/dsh-tools']) missing.push('peerDependencies["@deepseek-ai/dsh-tools"]')
    push({
      id: 'payload', status: missing.length ? FAIL : OK, title: 'installed manifest',
      detail: missing.length ? `missing ${missing.join(', ')}` : `${BUNDLE_NAME}@${installedManifest.version} (main=${installedManifest.main})`,
      fix: missing.length ? 'Reinstall from this repository (the installed copy looks truncated).' : null,
    })
    const entryFile = join(installedDir, installedManifest.main || 'plugin/godot-bridge.mjs')
    push({
      id: 'entry', status: existsSync(entryFile) ? OK : FAIL, title: 'host entry file',
      detail: entryFile, fix: existsSync(entryFile) ? null : 'Reinstall: the package payload is incomplete.',
    })
    const patch = installedManifest.dsh?.bundle?.patch
    const patchFile = patch ? join(installedDir, patch) : null
    push({
      id: 'patch', status: patchFile && existsSync(patchFile) ? OK : FAIL, title: 'bundle patch',
      detail: patchFile || '(no dsh.bundle.patch)',
      fix: patchFile && existsSync(patchFile) ? null : 'Reinstall: the bundle patch is what inserts the plugin row.',
    })
    entry.installedVersion = installedManifest.version
  }
  entry.bundles = bundles
  entry.spec = spec
  entry.installedDir = installedDir
  reports.push(entry)
}

// ── godot engine discovery ────────────────────────────────────────────────
function parseGodotVersion(text) {
  const m = /(\d+\.\d+(?:\.\d+)?)\.(stable|rc\d*|beta\d*|dev\d*|alpha\d*)/.exec(String(text || ''))
  return m ? { version: m[1], stage: m[2], raw: String(text).trim().split('\n')[0] } : null
}
function godotCandidates() {
  const list = []
  if (opt.godot) list.push(opt.godot)
  const env = process.env.GODOT_BIN || process.env.GODOT4 || process.env.GODOT_PATH
  if (env) list.push(env)
  // the plugin's own setting lives in the profile patch / settings file
  for (const p of targets) {
    const patchPath = join(profilesDir, p, 'cordis.patch.yml')
    if (!existsSync(patchPath)) continue
    const text = readFileSync(patchPath, 'utf8')
    for (const m of text.matchAll(/godotPath:\s*("([^"]+)"|'([^']+)'|([^\s#'"]+))/g)) {
      const v = (m[2] || m[3] || m[4] || '').replace(/\\\\/g, '\\')
      if (v) list.push(v)
    }
  }
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['godot'], { encoding: 'utf8' })
  if (which.status === 0) for (const line of which.stdout.split(/\r?\n/)) if (line.trim()) list.push(line.trim())
  for (const root of ['E:/Study', 'D:/', 'C:/Program Files', join(homedir(), 'Downloads'), join(homedir(), 'Desktop')]) {
    if (!existsSync(root)) continue
    let names = []
    try { names = readdirSync(root) } catch { continue }
    for (const n of names) {
      if (!/^Godot/i.test(n)) continue
      const dir = join(root, n)
      try {
        if (!statSync(dir).isDirectory()) {
          if (/\.exe$/i.test(n)) list.push(dir)
          continue
        }
        for (const f of readdirSync(dir)) {
          if (/^Godot.*\.exe$/i.test(f) && !/_console\.exe$/i.test(f)) list.push(join(dir, f))
        }
      } catch {}
    }
  }
  return [...new Set(list.filter(Boolean))]
}
const godotFound = []
for (const exe of godotCandidates()) {
  if (!existsSync(exe)) continue
  const run = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 20000 })
  const parsed = parseGodotVersion(`${run.stdout || ''}${run.stderr || ''}`)
  godotFound.push({ path: exe, version: parsed?.version ?? null, raw: parsed?.raw ?? (run.error ? String(run.error.message) : ''), ok: Boolean(parsed) })
  if (parsed) break
}
const godot = godotFound.find((g) => g.ok) || godotFound[0] || null
add('godot', godot ? (godot.ok ? OK : WARN) : FAIL, 'Godot engine',
  godot ? `${godot.path} → ${godot.raw}` : 'no Godot executable found (setting, PATH, and common install roots all came up empty)',
  godot ? null : 'Set the Godot engine path in the plugin page, or call godot_set_engine_path with the full path to Godot_v4.x-stable_win64.exe (NOT a *_console.exe and NOT a version-manager shim).')
if (godot?.ok) {
  const min = COMPAT.godot?.min ?? '4.0'
  const max = COMPAT.godot?.max
  const v = parseVersion(godot.version)
  const tooOld = v && cmpVersion(v, parseVersion(min)) < 0
  const tooNew = max && v && cmpVersion(v, parseVersion(max)) > 0
  add('godot-version', tooOld ? FAIL : tooNew ? WARN : OK, 'Godot version',
    `${godot.version} (this fork is tested on ${COMPAT.godot?.tested ?? 'unknown'}; requires >= ${min}${max ? `, <= ${max}` : ''})`,
    tooOld ? `The bundled GDScript helpers need Godot ${min}+ (they use the Godot 4 API).`
      : tooNew ? `Newer than the release this fork was verified against — reporting a bug with the exact Godot version string will help.`
        : null)
}

// ── dsh runtime compatibility ─────────────────────────────────────────────
if (dshVersion) {
  const range = COMPAT.dsh
  const ok = range ? satisfies(dshVersion, range) : null
  add('dsh-version', ok === false ? FAIL : OK, 'DSH runtime',
    `${dshVersion}${range ? ` (this fork declares dsh ${range})` : ''}`,
    ok === false ? `This fork was verified against ${COMPAT.dshTested ?? range}. Update the fork or expect drift.` : null)
}

// ── known traps ───────────────────────────────────────────────────────────
if (process.platform === 'win32') {
  const gc = join(homedir(), '.gitconfig')
  let proxy = null
  if (existsSync(gc)) {
    const m = /^\s*proxy\s*=\s*(\S+)/m.exec(readFileSync(gc, 'utf8'))
    if (m) proxy = m[1]
  }
  if (proxy) {
    let reachable = null
    try {
      const probe = spawnSync(process.platform === 'win32' ? 'curl.exe' : 'curl', ['-sS', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null', '-m', '6', '-x', proxy, 'https://github.com'], { timeout: 20000 })
      reachable = probe.status === 0
    } catch { reachable = false }
    add('git-proxy', reachable ? OK : FAIL, 'git proxy (GitHub installs)',
      `gitconfig points at ${proxy} — ${reachable ? 'reachable' : 'NOT reachable'}`,
      reachable ? null : `Plugin-market installs of github: specs run through git. Fix it with:\n    git config --global http.proxy http://127.0.0.1:<live-port>\n    git config --global https.proxy http://127.0.0.1:<live-port>\n    (or unset both to go direct: git config --global --unset http.proxy)`)
  } else {
    add('git-proxy', OK, 'git proxy (GitHub installs)', 'no http.proxy configured — git connects directly', null)
  }
  if (godot?.path && /_console\.exe$/i.test(godot.path)) {
    add('godot-console-exe', WARN, 'Godot executable', `${godot.path} is the console wrapper`,
      'Prefer the plain Godot_v4.x-stable_win64.exe: the console build spawns the real engine as a detached child, so captured stdout can arrive after the process the plugin tracks has already exited.')
  }
}

// ── deep: load the plugin the way DSH does ────────────────────────────────
if (opt.deep) {
  if (!dshApp) {
    add('deep', SKIP, 'runtime load probe', 'skipped: no DSH installation found', 'Pass --dsh-app "<DeepSeek Harness.exe>".')
  } else {
    for (const name of targets) {
      const r = reports.find((x) => x.profile === name)
      if (!r?.installedDir) { add('deep', SKIP, `runtime load probe (${name})`, 'skipped: plugin not installed in this profile', null); continue }
      const probe = spawnSync(dshApp, [
        join(SELF_DIR, 'lib', 'load-probe.mjs'),
        '--dsh-app', dshApp, '--home', dshHome, '--profile', name, '--plugin', r.installedDir, '--json',
      ], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 120000 })
      let parsed = null
      const text = (probe.stdout || '').trim()
      const start = text.indexOf('{')
      if (start >= 0) { try { parsed = JSON.parse(text.slice(start)) } catch {} }
      if (parsed?.ok) {
        const runtime = parsed.context?.runtime ?? {}
        add('deep', OK, `runtime load probe (${name})`,
          `${parsed.name}@${parsed.version} applied through @deepseek-ai/dsh-tools@${runtime.dshTools ?? '?'} — ${parsed.toolCount} tools, ${parsed.promptSections?.length ?? 0} prompt sections` +
          (parsed.stubHits?.length ? ` (context services not emulated: ${parsed.stubHits.join(', ')})` : ''), null)
        r.deep = parsed
      } else {
        add('deep', FAIL, `runtime load probe (${name})`,
          parsed?.error || text.slice(0, 400) || (probe.stderr || '').slice(0, 400) || `exit ${probe.status}`,
          'The plugin cannot be loaded by this DSH runtime. Report the message above.')
        r.deep = parsed
      }
    }
  }
}

// ── report ────────────────────────────────────────────────────────────────
const counts = checks.reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] || 0) + 1 }), {})
if (opt.json) {
  console.log(JSON.stringify({ plugin: { name: BUNDLE_NAME, version: PKG.version }, dshHome, dshApp, dshVersion, profiles: reports, checks, counts }, null, 2))
} else if (!opt.quiet) {
  const icon = { ok: '\u2714', warn: '!', fail: '\u2718', skip: '-' }
  console.log(`${BUNDLE_NAME} ${PKG.version} — doctor`)
  console.log(`dsh home : ${dshHome}`)
  if (dshVersion) console.log(`dsh      : ${dshVersion} (${dshApp})`)
  if (godot) console.log(`godot    : ${godot.raw}`)
  console.log('')
  for (const c of checks) {
    if (opt.profile === null && c.id.includes(':') && !['dependency', 'bundle', 'node_modules'].includes(c.id.split(':')[1])) continue
    console.log(`${icon[c.status]} ${c.id.padEnd(28)} ${c.detail}`)
    if (c.status !== OK && c.fix) for (const line of String(c.fix).split('\n')) console.log(`    → ${line}`)
  }
  console.log('')
  console.log(`ok ${counts.ok || 0}  warn ${counts.warn || 0}  fail ${counts.fail || 0}  skipped ${counts.skip || 0}`)
  if (counts.fail) console.log('Some checks failed — the plugin will not work until they are fixed.')
}
process.exit(counts.fail ? 1 : 0)
