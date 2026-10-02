// Worker half of the load probe. Installs the runtime resolution passed through
// worker_threads environment data, imports the plugin entry for real, and runs
// `apply()` against a permissive stand-in for the harness context.
//
// This is deliberately the *same* import path DSH uses (`@deepseek-ai/dsh-tools`
// and `@deepseek-ai/schemastery` resolved by the installation resolver), so a
// failure here is a failure in the real product.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'

const { pluginDir, bootstrapUrl, context = {}, timeoutMs = 60000 } = workerData

let tools = []
let promptSections = []
const warnings = []
const stubHits = []

const timer = setTimeout(() => {
  finish({ ok: false, error: `plugin import/apply did not finish within ${timeoutMs} ms` })
}, timeoutMs)

function finish(payload) {
  clearTimeout(timer)
  for (const hit of seenStubs) if (!stubHits.includes(hit)) stubHits.push(hit)
  parentPort.postMessage({ ...payload, context, warnings, stubHits })
  process.exit(0)
}

// Any service the plugin touches that we do not emulate is recorded instead of
// throwing, the same way the real loader swallows a missing method.
function makeStub(path, seen) {
  const fn = (...args) => { seen.add(path); return undefined }
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
      if (typeof prop !== 'string') return undefined
      return makeStub(`${path}.${prop}`, seen)
    },
    apply() { seen.add(path); return undefined },
  })
}
function stubSet() { return new Set() }

const ctx = {
  tools: {
    register(tool) {
      const name = tool?.name ?? tool?.id ?? '(unnamed)'
      tools.push(name)
      return () => tools.splice(tools.indexOf(name), 1)
    },
  },
  systemPrompt: {
    section(section) {
      promptSections.push(section?.name ?? '(unnamed)')
      return () => {}
    },
  },
  effect(fn) { try { return fn() } catch { return () => {} } },
  on() { return () => {} },
  timeout(fn, ms) { const h = setTimeout(fn, ms); return () => clearTimeout(h) },
  interval(fn, ms) { const h = setInterval(fn, ms); return () => clearInterval(h) },
  logger: {
    debug() {}, info() {},
    warn(msg) { warnings.push(String(msg)) },
    error(msg) { warnings.push(String(msg)) },
  },
}
const seenStubs = stubSet()
for (const service of ['settings', 'configEditor', 'subprocess', 'fs', 'sandboxPolicy', 'inject', 'fiber', 'timer', 'loader', 'console']) {
  ctx[service] = makeStub(`ctx.${service}`, seenStubs)
}
ctx.ctx = ctx

try {
  const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
  const entry = pathToFileURL(join(pluginDir, manifest.main || 'plugin/godot-bridge.mjs')).href
  await import(bootstrapUrl)
  const mod = await import(entry)
  const plugin = mod?.default ?? mod
  if (!plugin || typeof plugin.apply !== 'function') {
    finish({ ok: false, error: `${entry} does not export apply(); exports were: ${Object.keys(mod).join(', ')}` })
  }
  const config = {}
  for (const [key, value] of Object.entries(plugin.Config ?? {})) {
    if (typeof value === 'function') continue
    if (value === null || typeof value !== 'object') { config[key] = value; continue }
    if (typeof value.get === 'function') { try { config[key] = value.get() } catch {} }
  }
  await plugin.apply(ctx, config)
  finish({
    ok: true,
    name: plugin.name ?? manifest.name ?? null,
    version: manifest.version ?? null,
    inject: plugin.inject ?? null,
    configKeys: Object.keys(plugin.Config ?? {}),
    toolCount: tools.length,
    tools,
    promptSections,
  })
} catch (err) {
  finish({
    ok: false,
    error: String(err?.message || err),
    stack: err?.stack ? String(err.stack).split('\n').slice(0, 12).join('\n') : null,
  })
} finally {
  // stubHits is filled in by finish(); nothing to do here.
}
