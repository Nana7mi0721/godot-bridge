#!/usr/bin/env node
/**
 * Static contract checks for this DSH plugin bundle. Run it in CI and before a
 * release: `npm run check` (or `node scripts/check-plugin-contract.mjs --root <dir>`).
 *
 * Why this exists — DSH 0.2 resolves a bare `@deepseek-ai/*` import:
 *   - inside the profiles tree: from the running installation, no declaration needed;
 *   - through a *linked root* (a `link:`/symlinked profile dependency, whose real
 *     path lives outside the profiles tree): only when the package declares that
 *     exact name in its own `peerDependencies`
 *     (@deepseek-ai/dsh-app-boot `routeLinked` -> `readPeerNames(directory).has(name)`).
 * A missing declaration therefore surfaces as
 *   ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'
 * and the whole plugin row silently never loads.
 *
 * The checks are deliberately static: no DSH installation is required.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootArgument = process.argv.indexOf('--root')
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = rootArgument === -1 ? defaultRoot : resolve(process.argv[rootArgument + 1] ?? '')
if (!existsSync(join(root, 'package.json'))) {
  console.error(`✖ no package.json under ${root}`)
  process.exit(2)
}

const problems = []
const verified = []
const fail = (message) => problems.push(message)
const pass = (message) => verified.push(message)
// A BOM is legal in files edited on Windows; Node strips it when loading
// package.json and ESM, so the checker must tolerate it as well.
const readText = (abs) => readFileSync(abs, 'utf8').replace(/^\uFEFF/, '')
const read = (rel) => readText(join(root, rel))
const relOf = (abs) => relative(root, abs).split(sep).join('/')

const pkg = JSON.parse(read('package.json'))
const peers = Object.keys(pkg.peerDependencies ?? {})
const dependencies = Object.keys(pkg.dependencies ?? {})
const declared = new Set([...peers, ...dependencies])
const whitelist = Array.isArray(pkg.files) ? pkg.files : []
const shipped = (rel) => whitelist.some((rule) => (rule.endsWith('/') ? rel.startsWith(rule) : rel === rule))

// --------------------------------------------------------------- entry files
const targets = new Set()
if (typeof pkg.main !== 'string' || pkg.main.trim() === '') fail('package.json "main" must name the plugin entry file')
else {
  targets.add(pkg.main)
  if (!existsSync(join(root, pkg.main))) fail(`package.json "main" points at a missing file: ${pkg.main}`)
}
const exportValue = pkg.exports?.['.']
if (typeof exportValue === 'string') targets.add(exportValue.replace(/^\.\//, ''))
else if (exportValue !== undefined && typeof exportValue === 'object') {
  for (const value of Object.values(exportValue)) if (typeof value === 'string') targets.add(value.replace(/^\.\//, ''))
} else fail('package.json "exports" must map "." to the plugin entry file')
if (exportValue === undefined) fail('package.json "exports" is missing: the loader resolves the bundle entry through it')
for (const rel of targets) {
  if (!existsSync(join(root, rel))) fail(`entry file is missing: ${rel}`)
  if (!shipped(rel)) fail(`"files" whitelist does not ship ${rel}, so an installed copy would break`)
}
if (typeof pkg.main === 'string' && ![...targets].some((rel) => rel !== pkg.main)) pass(`entry ${pkg.main} exists and is shipped`)

// ------------------------------------------------------------ bundle patches
const patchDeclaration = pkg.dsh?.bundle?.patch
const patchFiles = Array.isArray(patchDeclaration) ? patchDeclaration : patchDeclaration === undefined ? [] : [patchDeclaration]
if (patchFiles.length === 0) fail('package.json "dsh.bundle.patch" must name at least one patch file (installed bundles are selected through it)')
for (const value of patchFiles) {
  if (typeof value !== 'string') {
    fail('every "dsh.bundle.patch" entry must be a string')
    continue
  }
  const rel = value.replace(/^\.\//, '')
  if (!existsSync(join(root, rel))) {
    fail(`bundle patch is missing: ${value}`)
    continue
  }
  if (!shipped(rel)) fail(`"files" whitelist does not ship the bundle patch ${rel}`)
  if (!read(rel).includes(pkg.name)) fail(`bundle patch ${rel} never references "${pkg.name}", so it cannot register this bundle's row`)
  else pass(`bundle patch ${rel} registers a row for ${pkg.name}`)
}

// --------------------------------------------------- harness imports vs peers
const sources = []
const collect = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) collect(abs)
    else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) sources.push(abs)
  }
}
const pluginDir = join(root, 'plugin')
if (!existsSync(pluginDir)) fail('plugin/ directory is missing')
else collect(pluginDir)

// Static forms are matched at line starts (top-level ESM imports/exports); a
// multi-line import clause is not matched — keep those on one line.
const STATIC_FROM = /^\s*(?:import|export)\b[^\n]*?\bfrom\s*['"]([^'"]+)['"]/
const STATIC_SIDE_EFFECT = /^\s*import\s*['"]([^'"]+)['"]/
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const isBare = (specifier) => !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':') && !specifier.startsWith('#')
const packageNameOf = (specifier) => (specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0])

const imported = new Map()
const record = (name, file, line) => {
  if (!imported.has(name)) imported.set(name, `${file}:${line}`)
}
for (const abs of sources) {
  const file = relOf(abs)
  const text = readText(abs)
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const match = STATIC_FROM.exec(line) ?? STATIC_SIDE_EFFECT.exec(line)
    if (match !== null && isBare(match[1])) record(packageNameOf(match[1]), file, index + 1)
    for (const dynamic of line.matchAll(DYNAMIC_IMPORT)) if (isBare(dynamic[1])) record(packageNameOf(dynamic[1]), file, index + 1)
  }
}
if (imported.size === 0) fail('no package imports were found under plugin/, so the peer-declaration rule could not be verified')
for (const [name, at] of imported) {
  if (declared.has(name)) pass(`${name} is imported (${at}) and declared`)
  else {
    fail(
      `plugin code imports ${name} (${at}) but package.json declares it in neither "peerDependencies" nor "dependencies".\n` +
        `      DSH 0.2 supplies harness packages to a *linked root* only through the plugin's own peerDependencies;\n` +
        `      without the declaration the import fails with ERR_MODULE_NOT_FOUND and the plugin row never loads.`,
    )
  }
}
for (const name of Object.keys(pkg.peerDependenciesMeta ?? {})) {
  if (!peers.includes(name)) fail(`"peerDependenciesMeta" mentions ${name}, which "peerDependencies" does not declare`)
}

// ---------------------------------------------------------------- export shape
const entryFile = typeof pkg.main === 'string' ? join(root, pkg.main) : undefined
if (entryFile !== undefined && existsSync(entryFile)) {
  const text = readText(entryFile)
  const exportsNamed = (name) => new RegExp(`^\\s*export\\s+(?:const|let|var|function|async\\s+function|class)\\s+${name}\\b|^\\s*export\\s*\\{[^}]*\\b${name}\\b`, 'm').test(text)
  if (!exportsNamed('name')) fail(`${pkg.main} must export \`name\`: the loader takes the plugin identity from it`)
  if (!exportsNamed('apply')) fail(`${pkg.main} must export \`apply\``)
  if (exportsNamed('Config')) pass(`${pkg.main} exports Config (drives the plugin settings form)`)
  else pass(`${pkg.main} exports no Config (optional)`)
  if (/^\s*export\s+default\b/m.test(text)) {
    fail(`${pkg.main} must not use \`export default\`: the loader's unwrapExports collapses to that single value and silently drops name/inject/apply`)
  } else pass('entry uses named exports only (no export default)')
}

// --------------------------------------------------------------------- report
const label = `${pkg.name}@${pkg.version}`
if (problems.length > 0) {
  console.error(`✖ ${label}: ${problems.length} contract problem(s) under ${root}\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('')
  process.exit(1)
}
console.log(`✔ ${label}: plugin contract OK`)
for (const line of verified) console.log(`  · ${line}`)
