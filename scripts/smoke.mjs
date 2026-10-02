#!/usr/bin/env node
// End-to-end smoke test: build a throwaway Godot project, load the plugin
// through the real DSH runtime, and drive the production tool bodies against a
// real Godot executable.
//
//   node scripts/smoke.mjs                                  # auto-detects DSH + Godot
//   node scripts/smoke.mjs --godot "C:/Godot/Godot_v4.7.2-stable_win64.exe"
//   node scripts/smoke.mjs --profile desktop --keep           # keep the project
//
// What it proves, in order:
//   1  the plugin imports and registers its tools under this installation
//   2  godot_validate_script parses scripts that reference an autoload global
//   3  godot_headless_op creates and reads scenes
//   4  godot_run_project brings the game up and installs the interaction autoload
//   5  godot_command reaches real objects inside the running game
//   6  godot_screenshot and godot_stop_project close the loop
//
// Everything runs in a temp directory; nothing touches your real projects.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SELF_DIR, '..')
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))

const argv = process.argv.slice(2)
const opt = { godot: null, profile: null, home: null, dshApp: null, plugin: null, keep: false, json: false, timeoutMs: 180000 }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--godot') opt.godot = argv[++i]
  else if (a === '--profile') opt.profile = argv[++i]
  else if (a === '--home') opt.home = argv[++i]
  else if (a === '--dsh-app') opt.dshApp = argv[++i]
  else if (a === '--plugin') opt.plugin = argv[++i]
  else if (a === '--keep') opt.keep = true
  else if (a === '--json') opt.json = true
  else if (a === '--timeout-ms') opt.timeoutMs = Number(argv[++i])
  else if (a === '-h' || a === '--help') {
    console.log(`godot-bridge smoke test ${PKG.version}

  node scripts/smoke.mjs [--godot <exe>] [--profile <name>] [--plugin <dir>] [--keep]

  --godot <exe>    Godot executable (default: GODOT_BIN/GODOT4/GODOT_PATH, then a scan)
  --profile <name> DSH profile whose runtime resolution to borrow (default: DSH_PROFILE or desktop)
  --plugin <dir>   plugin checkout/install to load (default: this repository, else the profile copy)
  --keep           keep the generated project and print its path
  --json           machine-readable result
`)
    process.exit(0)
  } else { console.error(`smoke: unknown argument ${a}`); process.exit(2) }
}

const info = (m) => { if (!opt.json) console.log(m) }

// ── find a Godot executable ───────────────────────────────────────────────
function findGodot() {
  const candidates = [opt.godot, process.env.GODOT_BIN, process.env.GODOT4, process.env.GODOT_PATH].filter(Boolean)
  const roots = ['E:/Study', 'D:/', 'C:/Program Files', join(homedir(), 'Downloads'), join(homedir(), 'Desktop')]
  for (const root of roots) {
    if (!existsSync(root)) continue
    let names = []
    try { names = readdirSync(root) } catch { continue }
    for (const name of names) {
      if (!/^Godot/i.test(name)) continue
      const p = join(root, name)
      try {
        if (statSync(p).isDirectory()) {
          for (const f of readdirSync(p)) if (/^Godot.*\.exe$/i.test(f) && !/_console\.exe$/i.test(f)) candidates.push(join(p, f))
        } else if (/\.exe$/i.test(name)) candidates.push(p)
      } catch {}
    }
  }
  for (const exe of candidates) {
    if (!existsSync(exe)) continue
    const run = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 20000 })
    const out = `${run.stdout || ''}${run.stderr || ''}`.trim().split('\n')[0]
    if (/\d+\.\d+/.test(out)) return { path: exe, version: out }
  }
  return null
}

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

const godot = findGodot()
if (!godot) { console.error('smoke: no Godot executable found; pass --godot <path to Godot_v4.x-stable_win64.exe>'); process.exit(2) }
const dshApp = findDshApp()
if (!dshApp) { console.error('smoke: no DSH installation found; pass --dsh-app "<DeepSeek Harness.exe>"'); process.exit(2) }

const dshHome = opt.home || process.env.DSH_HOME || join(homedir(), '.dsh')
const profilesDir = join(dshHome, 'profiles')
const profile = opt.profile || (process.env.DSH_PROFILE && existsSync(join(profilesDir, process.env.DSH_PROFILE)) ? process.env.DSH_PROFILE : null)
  || (existsSync(join(profilesDir, 'desktop')) ? 'desktop' : readdirSync(profilesDir)[0])
const profileDir = join(profilesDir, profile)

// Which copy of the plugin should we load? Prefer this checkout, then whatever
// the profile has installed (which may be a link: straight back to this clone).
function pickPluginDir() {
  if (opt.plugin) return resolve(opt.plugin)
  if (existsSync(join(REPO_ROOT, 'plugin', 'godot-bridge.mjs'))) return REPO_ROOT
  const installed = join(profileDir, 'node_modules', PKG.name)
  if (existsSync(installed)) return installed
  return null
}
const pluginDir = pickPluginDir()
if (!pluginDir) { console.error(`smoke: no plugin to load (looked in ${REPO_ROOT} and ${profileDir}/node_modules); pass --plugin <dir>`); process.exit(2) }
const pluginPkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))

info(`godot-bridge smoke test ${PKG.version}`)
info(`plugin : ${pluginDir}`)
info(`godot  : ${godot.path} -> ${godot.version}`)
info(`dsh    : ${dshApp}`)
info(`profile: ${profile}`)

// ── generate the throwaway project ────────────────────────────────────────
const PROJECT_FILES = {
  'project.godot': `; Generated by godot-bridge scripts/smoke.mjs — disposable.

config_version=5

[application]

config/name="godot-bridge smoke"
run/main_scene="res://scenes/main.tscn"
config/features=PackedStringArray("4.7", "Forward Plus")

[autoload]

Game = "*res://autoload/game.gd"

[display]

window/size/viewport_width=640
window/size/viewport_height=360
`,
  'scenes/main.tscn': `[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://scripts/main.gd" id="1_main"]

[node name="Main" type="Node2D"]
script = ExtResource("1_main")

[node name="Label" type="Label" parent="."]
offset_left = 16.0
offset_top = 16.0
offset_right = 336.0
offset_bottom = 48.0
text = "boot"
`,
  'scripts/main.gd': `extends Node2D
## Smoke fixture: references the Game autoload so the validator has to resolve
## a global class name, and exposes a property the bridge can poke.

@onready var label: Label = $Label

var probe_calls: int = 0


func _ready() -> void:
	if label:
		label.text = "smoke"
	Game.add_score(5)
	print("[Main] ready %s" % Engine.get_version_info().get("string"))


func add_probe_calls(amount: int = 1) -> int:
	probe_calls += amount
	print("[Main] probe_calls=%d" % probe_calls)
	return probe_calls
`,
  'autoload/game.gd': `extends Node
## Smoke fixture: the autoload global that validate_script must resolve.

var score: int = 0


func add_score(amount: int) -> void:
	score += amount
	print("[Game] score=%d" % score)
`,
}

const workDir = mkdtempSync(join(tmpdir(), 'godot-bridge-smoke-'))
const project = join(workDir, 'project')
for (const [rel, text] of Object.entries(PROJECT_FILES)) {
  const target = join(project, rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text, 'utf8')
}

// ── run the worker under the Electron-carried Node ────────────────────────
const bootstrap = join(dirname(dshApp), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'worker', 'profile-resolution-bootstrap.js')
const run = spawnSync(dshApp, [
  join(SELF_DIR, 'lib', 'smoke-worker.mjs'),
  '--dsh-app', dshApp,
  '--home', dshHome,
  '--profile', profile,
  '--plugin', pluginDir,
  '--project', project,
  '--godot', godot.path,
  '--bootstrap', bootstrap,
], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: opt.timeoutMs, maxBuffer: 64 * 1024 * 1024 })

// Godot keeps a lock on its .godot cache for a moment after exiting, so give
// the recursive delete a few tries before giving up (cleanup is best effort).
const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch {} }
function removeProject(dir) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try { rmSync(dir, { recursive: true, force: true }); return true } catch { sleep(150 * (attempt + 1)) }
  }
  return false
}

let report = null
const stdout = run.stdout || ''
const start = stdout.indexOf('{')
if (start >= 0) { try { report = JSON.parse(stdout.slice(start)) } catch {} }

if (!report) {
  console.error('smoke: the worker produced no report')
  if (stdout.trim()) console.error(stdout.trim().slice(-4000))
  if ((run.stderr || '').trim()) console.error((run.stderr || '').trim().slice(-4000))
  if (run.error) console.error(String(run.error.message || run.error))
  if (!opt.keep) removeProject(workDir)
  process.exit(1)
}

if (opt.json) console.log(JSON.stringify({ ...report, godot: godot.path, pluginDir, profile }, null, 2))
else {
  console.log('')
  for (const step of report.steps) {
    const mark = step.ok ? '\u2714' : '\u2718'
    console.log(`${mark} ${step.name}`)
    if (step.detail) console.log(`    ${String(step.detail).split('\n').join('\n    ')}`)
  }
  console.log('')
  console.log(`${report.passed}/${report.steps.length} checks passed` + (report.failed ? ` — ${report.failed} failed` : ''))
  if (report.notes?.length) for (const n of report.notes) console.log(`note: ${n}`)
}

if (opt.keep) info(`\nproject kept at ${project}`)
else if (!removeProject(workDir)) info(`\n(cleanup skipped — remove ${workDir} later)`)

process.exit(report.failed ? 1 : 0)
