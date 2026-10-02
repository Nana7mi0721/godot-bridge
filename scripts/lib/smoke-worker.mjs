// Worker half of scripts/smoke.mjs: load the plugin through the installed DSH
// runtime resolution, then run its production tool bodies against a real Godot
// executable and a generated throwaway project. Prints one JSON report.

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve as presolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildResolution, findDshApp, installAnchorFor } from './runtime.mjs'

const argv = process.argv.slice(2)
const opt = { probes: 0 }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--dsh-app') opt.dshApp = argv[++i]
  else if (a === '--home') opt.home = argv[++i]
  else if (a === '--profile') opt.profile = argv[++i]
  else if (a === '--plugin') opt.plugin = argv[++i]
  else if (a === '--project') opt.project = argv[++i]
  else if (a === '--godot') opt.godot = argv[++i]
  else if (a === '--bootstrap') opt.bootstrap = argv[++i]
  else if (a === '--probe') opt.probes++
}

const steps = []
const notes = []
let failed = 0
const record = (name, ok, detail) => { steps.push({ name, ok, detail }); if (!ok) failed++ }
const report = () => {
  process.stdout.write('\n' + JSON.stringify({ ok: failed === 0, passed: steps.length - failed, failed, steps, notes }, null, 2) + '\n')
}

if (!globalThis.__godotBridgeSmokeWorker) {
  // Bootstrap under the Electron-carried Node: the asar modules are unreadable
  // from a plain node process.
  const dshApp = opt.dshApp || findDshApp()
  if (!dshApp) { process.stderr.write('smoke-worker: no DSH application found\n'); process.exit(2) }
  if (!process.versions.electron) {
    globalThis.__godotBridgeSmokeWorker = true
    const r = spawn(dshApp, [pathToFileURL(process.argv[1]).href, ...argv], {
      stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    process.exit(r.status ?? 1)
  }
}

const dshApp = opt.dshApp || findDshApp()
const installAnchor = installAnchorFor(dshApp)
if (!installAnchor) { process.stderr.write('smoke-worker: no asar runtime next to the DSH application\n'); process.exit(2) }

let resolution
let pluginUrl
let pluginManifest = null
let bootstrapUrl = null
try {
  const built = await buildResolution({ dshApp, home: opt.home, profile: opt.profile, linkRoots: [opt.plugin] })
  resolution = built.resolution
  pluginUrl = built.pluginEntries[0]?.entry
  pluginManifest = built.pluginEntries[0]?.manifest ?? null
  bootstrapUrl = built.bootstrapUrl
  notes.push(`resolution: ${resolution.entries?.length ?? '?'} packages; dsh-tools ${built.dshTools ?? '?'}`)
} catch (err) {
  process.stderr.write(`smoke-worker: runtime resolution failed: ${err?.message || err}\n`)
  process.exit(2)
}
if (!pluginUrl) { process.stderr.write('smoke-worker: no plugin entry to load\n'); process.exit(2) }

// Installing the resolver has to happen in this thread, before any plugin (or
// harness package) import: it is what makes `@deepseek-ai/dsh-tools` resolvable.
try {
  await import(bootstrapUrl)
} catch (err) {
  process.stderr.write(`smoke-worker: could not install the runtime resolution: ${err?.message || err}\n`)
  process.exit(2)
}

// ── the harness context the tools expect ─────────────────────────────────
const TOOLS = new Map()
const SECTIONS = []
const warnings = []

function makeSubprocess() {
  return {
    spawn(opts) {
      const { argv, cwd, stdio = {}, graceMs = 3000, signal } = opts
      const child = spawn(argv[0], argv.slice(1), { cwd, windowsHide: true })
      const caps = { stdout: stdio.stdout?.collect?.maxBytes ?? 8 * 1024 * 1024, stderr: stdio.stderr?.collect?.maxBytes ?? 8 * 1024 * 1024 }
      const chunks = { stdout: [], stderr: [] }
      const sizes = { stdout: 0, stderr: 0 }
      for (const key of ['stdout', 'stderr']) {
        if (!child[key]) continue
        child[key].on('data', (c) => {
          if (sizes[key] >= caps[key]) return
          sizes[key] += c.length
          chunks[key].push(c)
        })
      }
      const collected = {
        stdout: { readFrom: () => ({ text: Buffer.concat(chunks.stdout).toString('utf8') }) },
        stderr: { readFrom: () => ({ text: Buffer.concat(chunks.stderr).toString('utf8') }) },
      }
      const done = new Promise((res) => {
        let settled = false
        const finish = (o) => { if (!settled) { settled = true; res(o) } }
        child.on('error', (err) => finish({ exitCode: -1, spawnError: String(err.message || err) }))
        child.on('close', (code, sig) => finish({ exitCode: code === null ? -1 : code, signal: sig }))
        if (signal) {
          if (signal.aborted) child.kill()
          else signal.addEventListener('abort', () => child.kill(), { once: true })
        }
        const guard = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, graceMs + 15 * 60 * 1000)
        guard.unref?.()
      })
      return {
        collected,
        done,
        kill: (sig) => child.kill(sig),
        terminate: () => { try { child.kill('SIGKILL') } catch {} },
      }
    },
  }
}

const fsStub = {
  async resolve(p, o = {}) {
    const cwd = o.cwd || process.cwd()
    return presolve(/^([A-Za-z]:[\\/]|\/)/.test(p) ? p : join(cwd, p))
  },
  async stat(target) { try { readFileSync(target); return { isFile: true } } catch { return null } },
  async readText(target) { return readFileSync(target, 'utf8') },
  async writeText(target, text) { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text, 'utf8'); return true },
  async writeFile(target, data) { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, data); return true },
  async readFile(target) { return readFileSync(target) },
  async listDir(target) { return readdirSync(target, { withFileTypes: true }).map((d) => ({ name: d.name, type: d.isDirectory() ? 'dir' : 'file' })) },
}

const stubValue = (label) => new Proxy(function () {}, {
  get: (_t, k) => (k === 'then' ? undefined : stubValue(`${label}.${String(k)}`)),
  apply: () => { warnings.push(`stub call ${label}()`); return undefined },
})

function makeCtx(godotPath) {
  const ctx = {
    subprocess: makeSubprocess(),
    fs: fsStub,
    timer: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) },
    timeout: (ms) => new Promise((r) => setTimeout(r, ms)),
    tools: { register: (d) => { TOOLS.set(d.name, d); return () => {} } },
    systemPrompt: { section: (s) => { SECTIONS.push(s); return () => {} } },
    sandboxPolicy: { get: () => ({ mode: 'danger-full-access' }), default: () => ({ mode: 'danger-full-access' }) },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fiber: { entry: { id: 'tool-godot-bridge' } },
    effect: (fn) => { try { return fn() ?? (() => {}) } catch (e) { warnings.push(`effect threw: ${e.message}`); return () => {} } },
    on: () => () => {},
    settings: { get: () => godotPath },
  }
  return new Proxy(ctx, {
    get: (t, k) => {
      if (k in t) return t[k]
      warnings.push(`missing ctx.${String(k)}`)
      return stubValue(`ctx.${String(k)}`)
    },
  })
}

const project = opt.project
const exec = { workspaceRoot: project, signal: new AbortController().signal }
const call = (name, args) => {
  const tool = TOOLS.get(name)
  if (!tool) throw new Error(`tool ${name} was not registered`)
  return tool.execute(args, exec)
}
const brief = (v) => {
  const text = typeof v === 'string' ? v : JSON.stringify(v)
  return text.length > 400 ? text.slice(0, 400) + '…' : text
}

try {
  const mod = await import(pluginUrl)
  const plugin = mod?.default ?? mod
  await plugin.apply(makeCtx(opt.godot), { godotPath: opt.godot })
  const expect = ['godot_run_project', 'godot_command', 'godot_headless_op', 'godot_validate_script', 'godot_screenshot', 'godot_stop_project']
  const missing = expect.filter((n) => !TOOLS.has(n))
  record('plugin loads through the DSH runtime resolution', missing.length === 0,
    `${plugin.name ?? pluginManifest?.name}@${pluginManifest?.version ?? '?'} — ${TOOLS.size} tools, ${SECTIONS.length} prompt sections` +
    (missing.length ? `; missing: ${missing.join(', ')}` : ''))

  // 1. GDScript validation (autoload globals must resolve)
  const v = await call('godot_validate_script', { script_path: 'scripts/main.gd', project_path: project })
  record('godot_validate_script parses a script that uses an autoload', v.valid === true && v.error_count === 0, brief(v))

  // 2. headless static scene operations
  const created = await call('godot_headless_op', { operation: 'create_scene', project_path: project, params: { scene_path: 'generated/badge.tscn', root_node_type: 'Node2D', root_node_name: 'Badge' } })
  record('godot_headless_op create_scene', created.success === true, brief(created.output ?? created.error ?? created))
  const added = await call('godot_headless_op', { operation: 'add_node', project_path: project, params: { scene_path: 'generated/badge.tscn', parent_node_path: '.', node_type: 'Sprite2D', node_name: 'Glow' } })
  record('godot_headless_op add_node', added.success === true, brief(added.output ?? added.error ?? added))
  const read = await call('godot_headless_op', { operation: 'read_scene', project_path: project, params: { scene_path: 'generated/badge.tscn' } })
  const readText = JSON.stringify(read.output ?? '')
  const sawChild = readText.includes('Glow')
  record('godot_headless_op read_scene reads the edited scene back', read.success === true && sawChild,
    sawChild ? `read back ${readText.length} chars of scene JSON including the added "Glow" node` : brief(read.output ?? read.error ?? read))

  // 3. a bounded headless run
  const headless = await call('godot_run_headless', { project_path: project, quit_after: 4, timeout_ms: 60000 })
  const stdout = String(headless.stdout ?? '')
  record('godot_run_headless runs the main loop and exits cleanly',
    headless.success === true && headless.exit_code === 0 && stdout.includes('[Game] score=5'),
    brief({ exit_code: headless.exit_code, stdout: stdout.split('\n').slice(0, 6).join(' | '), stderr: String(headless.stderr ?? '').split('\n').slice(0, 3).join(' | ') }))

  // 4. interactive run through the in-game TCP server
  const run = await call('godot_run_project', { project_path: project, quit_after: 600, timeout_ms: 30000 })
  record('godot_run_project starts the game and installs the interaction autoload',
    run.game_ready === true && run.managed === true && run.autoload?.registered === true,
    brief({ game_ready: run.game_ready, port: run.port, autoload: run.autoload, error: run.error }))

  const tree = await call('godot_command', { command: 'get_scene_tree' })
  const treeText = JSON.stringify(tree.result ?? tree)
  record('godot_command get_scene_tree reaches the running game',
    tree.success === true && treeText.includes('Main') && treeText.includes('McpInteractionServer'), brief(tree.result ?? tree))

  const called = await call('godot_command', { command: 'call_method', params: { node_path: '/root/Main', method: 'add_probe_calls' } })
  const value = await call('godot_command', { command: 'get_property', params: { node_path: '/root/Main', property: 'probe_calls' } })
  const got = value.result?.value ?? value.value ?? value.result
  record('godot_command call_method mutates a live scene property', called.success === true && Number(got) === 1,
    brief({ call_method: called.result, get_property: value.result }))

  // 5. screenshot + shutdown
  const shot = await call('godot_screenshot', { project_path: project })
  const shotBytes = typeof shot.data === 'string' ? Math.floor(shot.data.length * 3 / 4) : 0
  record('godot_screenshot captures the viewport', shot.success === true && shotBytes > 1000,
    brief({ width: shot.width, height: shot.height, bytes: shotBytes, error: shot.error }))

  const stopped = await call('godot_stop_project', { project_path: project })
  record('godot_stop_project stops the managed instance', stopped.stopped === true, brief(stopped))
} catch (err) {
  record('smoke run completed without an unexpected exception', false, String(err?.stack || err))
}

for (const w of [...new Set(warnings)].slice(0, 10)) notes.push(w)
report()
process.exit(failed ? 1 : 0)
