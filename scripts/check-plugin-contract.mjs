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
const notes = []
const fail = (message) => problems.push(message)
const pass = (message) => verified.push(message)
const note = (message) => notes.push(message)
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

// -------------------------------------------------------------- browser half
// A package's `dsh.client` declaration turns its `exports["./client"]` file into
// a browser bundle (dsh-client-modules). The four ways to get that wrong are all
// either silent or late at runtime, so they are checked statically here:
//   1. a declaration member the host validator rejects, or a platform the host
//      does not serve (`parseDshClient`);
//   2. a factory whose `id` is not the package name — the module table then
//      cannot answer `<package>/client` for the Loader row;
//   3. a `require()` the platform seed table cannot answer and that
//      `dsh.client.external` does not name — the browser throws
//      `missed the module table` at first use;
//   4. a keyed slot key that does not name a row this bundle's patch declares
//      (`<package name>#<row id>`), which leaves the intended row with no
//      configuration control and no error.
// The seed list is the runtime module table of the 0.2 web client
// (`dsh-web-frontend`'s frozen platform seed); a specifier outside it has to be
// declared in `dsh.client.external` or answered by another plugin's bundle.
const SEED_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])
const CLIENT_DECLARATION_KEYS = new Set(['platform', 'inject', 'external', 'immediately'])
const clientDeclaration = pkg.dsh?.client
const patchText = patchFiles.filter((value) => typeof value === 'string').map((value) => read(value.replace(/^\.\//, ''))).join('\n')
if (clientDeclaration === undefined) {
  note('package.json declares no "dsh.client": this bundle ships no browser half, so its rows get no configuration form')
} else {
  if (typeof clientDeclaration !== 'object' || clientDeclaration === null || Array.isArray(clientDeclaration)) {
    fail('package.json "dsh.client" must be an object')
  } else {
    for (const key of Object.keys(clientDeclaration)) {
      if (!CLIENT_DECLARATION_KEYS.has(key)) fail(`package.json "dsh.client" carries "${key}", which the host validator does not read (allowed: platform, inject, external, immediately)`)
    }
    if (clientDeclaration.platform !== 'web') {
      fail('package.json "dsh.client.platform" must be "web": the host scan keeps only web declarations')
    }
    for (const member of ['inject', 'external']) {
      const value = clientDeclaration[member]
      if (value === undefined) continue
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) fail(`package.json "dsh.client.${member}" must be an array of strings`)
    }
    if (clientDeclaration.immediately !== undefined && typeof clientDeclaration.immediately !== 'boolean') {
      fail('package.json "dsh.client.immediately" must be a boolean')
    }
  }

  const clientExport = pkg.exports?.['./client']
  const clientRelative =
    typeof clientExport === 'string'
      ? clientExport
      : clientExport !== undefined && typeof clientExport === 'object' && typeof clientExport.default === 'string'
        ? clientExport.default
        : undefined
  if (clientRelative === undefined) {
    fail('package.json declares "dsh.client" but maps no "./client" bundle: the host throws "declares dsh.client but exports no \'./client\' bundle" at activation')
  } else {
    const rel = clientRelative.replace(/^\.\//, '')
    if (!existsSync(join(root, rel))) fail(`browser half entry is missing: ${clientRelative}`)
    else {
      if (!shipped(rel)) fail(`"files" whitelist does not ship ${rel}, so an installed copy activates without its browser half`)
      else pass(`browser half ${rel} exists and is shipped`)
      const text = read(rel)
      // Slot keys and module requests are read from code, not prose: this file's
      // own header explains which slots it does NOT use, and a comment must not
      // be able to satisfy — or trip — a contract check.
      const code = stripComments(text)
      if (!/window\.__ModuleLoader__\.load\s*\(/.test(code)) {
        fail(`${rel} must register through window.__ModuleLoader__.load({ id, factory }) — the module system loads a classic script, not an ES module`)
      }
      const idMatch = /window\.__ModuleLoader__\.load\s*\(\s*\{[^}]*?\bid\s*:\s*['"]([^'"]+)['"]/.exec(code)
      if (idMatch === null) fail(`${rel} must name the module it registers: window.__ModuleLoader__.load({ id: '${pkg.name}', factory })`)
      else if (idMatch[1] !== pkg.name) fail(`${rel} registers id "${idMatch[1]}", but a browser half is its package's client bundle and must register "${pkg.name}"`)
      else pass(`browser half registers the module id ${pkg.name}`)
      if (!/['"]slots['"]/.test(code)) {
        fail(`${rel} never names the "slots" service: a browser half reaches ctx.slots only by declaring it in its exported inject list`)
      }
      const external = new Set(Array.isArray(clientDeclaration?.external) ? clientDeclaration.external : [])
      const requested = new Set()
      for (const match of code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) requested.add(match[1])
      if (requested.size === 0) note(`${rel} requires no platform module: React comes from the browser module table, so a browser half normally requires at least react`)
      for (const specifier of requested) {
        if (SEED_MODULES.has(specifier) || external.has(specifier)) continue
        fail(`${rel} requires "${specifier}", which is neither a platform seed module nor listed in "dsh.client.external": the browser throws "require(\\"${specifier}\\") missed the module table" at first use`)
      }
      const harness = [...requested].filter((specifier) => specifier.startsWith('@deepseek-ai/dsh-client-'))
      if (harness.length > 0) {
        note(`${rel} loads Harness client packages as modules (${harness.join(', ')}): DSH's plugin authoring rules ask a plugin to ship its own controls instead, because those exports change without notice`)
      }
      const keys = new Set()
      for (const match of code.matchAll(/\bkey\s*:\s*['"]([^'"]+)['"]/g)) keys.add(match[1])
      const slotKeys = [...keys].filter((key) => key.includes('#'))
      for (const key of slotKeys) {
        const separator = key.indexOf('#')
        const bundle = key.slice(0, separator)
        const rowId = key.slice(separator + 1)
        if (bundle !== pkg.name) fail(`${rel} registers slot key "${key}", whose package name must be this bundle's name "${pkg.name}"`)
        else if (!new RegExp(`(^|\\s)id\\s*:\\s*['"]?${rowId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?(\\s|$)`).test(patchText)) {
          fail(`${rel} registers slot key "${key}", but no declared bundle patch inserts a row with id "${rowId}" — the keyed slot then names a row that does not exist and no error is raised`)
        } else pass(`slot key ${key} names a row this bundle's patch declares`)
      }
      if (/plugins\.row\.config/.test(code) && slotKeys.length === 0) {
        fail(`${rel} registers into the keyed slot "plugins.row.config" without a literal "<package name>#<row id>" key — write the key as a string literal so this check can prove it names a row the bundle's patch declares`)
      }
      if (/plugins\.bundle\.config/.test(code)) {
        if (keys.has(pkg.name)) pass(`bundle configuration key ${pkg.name} is this package's name`)
        else fail(`${rel} registers into the keyed slot "plugins.bundle.config" without a literal key equal to this bundle's package name "${pkg.name}" — the page dispatches that key when it opens this bundle's card, and a mismatch renders nothing`)
      }
    }
  }
  if (!existsSync(join(root, 'client'))) note('package.json declares "dsh.client" but there is no client/ directory')
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

// Scan whole statements rather than single lines: an import clause may wrap
// across lines (`import {\n  a,\n} from '@scope/pkg'`), and matching line by
// line would silently miss exactly the declaration this check exists to
// enforce. Comments are blanked (keeping newlines so reported lines stay
// correct) so a specifier mentioned in prose cannot produce a false positive;
// string bodies are deliberately kept, since the specifier lives in one.
const STATIC_FROM = /\b(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g
const STATIC_SIDE_EFFECT = /\bimport\s*['"]([^'"]+)['"]/g
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const isBare = (specifier) => !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':') && !specifier.startsWith('#')
const packageNameOf = (specifier) => (specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0])

/** Blank out comments, preserving newlines so line numbers stay accurate. */
function stripComments(source) {
  let out = ''
  let index = 0
  while (index < source.length) {
    const two = source.slice(index, index + 2)
    if (two === '//') {
      const end = source.indexOf('\n', index)
      const stop = end === -1 ? source.length : end
      out += ' '.repeat(stop - index)
      index = stop
      continue
    }
    if (two === '/*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
      out += source.slice(index, stop).replace(/[^\n]/g, ' ')
      index = stop
      continue
    }
    out += source[index]
    index++
  }
  return out
}

const imported = new Map()
const record = (name, file, line) => {
  if (!imported.has(name)) imported.set(name, `${file}:${line}`)
}
// Report the line of the specifier itself, not of the `import` keyword: a
// wrapped clause would otherwise be reported at its opening line.
const lineOfSpecifier = (source, offset, specifier) => {
  const at = source.indexOf(specifier, offset)
  return source.slice(0, at === -1 ? offset : at).split('\n').length
}

for (const abs of sources) {
  const file = relOf(abs)
  const text = stripComments(readText(abs))
  for (const pattern of [STATIC_FROM, STATIC_SIDE_EFFECT, DYNAMIC_IMPORT]) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      if (isBare(match[1])) record(packageNameOf(match[1]), file, lineOfSpecifier(text, match.index, match[1]))
    }
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
  if (notes.length > 0) {
    console.error('')
    for (const line of notes) console.error(`  ! ${line}`)
  }
  console.error('')
  process.exit(1)
}
console.log(`✔ ${label}: plugin contract OK`)
for (const line of verified) console.log(`  · ${line}`)
for (const line of notes) console.log(`  ! ${line}`)
