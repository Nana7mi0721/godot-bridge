#!/usr/bin/env node
/**
 * Runtime check for the **browser half** of this bundle.
 *
 *   node scripts/check-client.mjs            # from the repo root
 *   node scripts/check-client.mjs --json
 *
 * Why this exists — the "the plugin page has no configuration form" failure is
 * invisible from the host side: the rows load, all 17 tools register, and the
 * card simply renders without a field. Nothing logs an error, because nothing
 * failed: the browser half either never registered the slot, or registered it
 * under a key the page does not dispatch. Both are silent.
 *
 * This file loads `client/client.js` the way `@deepseek-ai/dsh-client-modules`
 * does — as a classic script calling `window.__ModuleLoader__.load({ id, factory })`
 * — then runs the returned plugin body against a recording context and renders
 * the component it registers. It needs no DSH installation, no browser and no
 * dependency: the React below is a stub just rich enough for the hooks the form
 * uses (useState/useRef/useMemo/useSyncExternalStore), and `createElement`
 * returns plain nodes this file can walk.
 *
 * It asserts the four things that make the form appear where a user looks for it:
 *   1. the module id equals the package name (the key the loader and the page use);
 *   2. the body requires only platform-seed specifiers (`react`, `react-dom`, …);
 *   3. with the settings-form service present it registers
 *      `plugins.bundle.config` **keyed by the package name**, and reads the row
 *      scope under the row id `tool-godot-bridge`;
 *   4. the registered component actually renders the stored value — the label,
 *      the saved path in the field, the read-only and unavailable notices, and
 *      nothing at all before the settings document arrives.
 * Without the settings-form service (DSH 0.1.6–0.1.x) it must stay inert rather
 * than render a form that could not save; that boundary is checked too.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SELF_DIR, '..')
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
const NAME = PKG.name
/** The row id this bundle inserts; the form must read exactly this scope. */
const ENTRY_NS = 'tool-godot-bridge'
/** Specifiers the platform seeds into the module table for every plugin. */
const PLATFORM_SEEDS = new Set(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'])

const results = []
/**
 * Record one check outcome.
 * @param name - short check name.
 * @param ok - whether it passed.
 * @param detail - evidence shown either way.
 */
function check(name, ok, detail) {
  results.push({ name, ok, detail })
}

/** Minimal element tree: `createElement` returns this, `walk()` reads it. */
function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity) }
}
/** Hooks the form uses, with state that is stable for a single render pass. */
const React = {
  createElement,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useMemo: (factory) => factory(),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

/**
 * Load the browser half as a classic script and return its plugin body.
 * @returns the module the factory returned, plus the requires it made.
 */
function loadClientHalf() {
  const specifiers = []
  const requires = (specifier) => {
    specifiers.push(specifier)
    if (specifier === 'react') return React
    throw new Error(`unexpected require('${specifier}')`)
  }
  let entry = null
  const document = {
    createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
    head: { appendChild() {} },
  }
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: (loaded) => { entry = loaded } } },
    document,
    console,
  })
  const relative = PKG.exports?.['./client'] ?? './client/client.js'
  const file = resolve(REPO_ROOT, typeof relative === 'string' ? relative : relative.default)
  new vm.Script(readFileSync(file, 'utf8'), { filename: file }).runInContext(context)
  if (entry === null) throw new Error(`${file} never called window.__ModuleLoader__.load()`)
  return { entry, module: entry.factory(requires), specifiers, file }
}

/**
 * Run the body against a recording context.
 * @param body - the plugin body (`{ inject, apply }`).
 * @param options - `{ configForms }` toggles the settings-form service.
 * @returns what the body registered, and the errors it left behind.
 */
function applyBody(body, { configForms }) {
  const registered = []
  const dictionaries = []
  const namespaces = []
  const effects = []
  const failures = []
  const settings = {
    get: (namespace) => {
      namespaces.push(namespace)
      return configForms?.scope
    },
  }
  const ctx = {
    effect: (callback, label) => {
      effects.push(label)
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: { register: (namespace, dict) => { dictionaries.push({ namespace, dict }); return () => {} } },
    slots: {
      inject: (_slot, callback) => callback(),
      register: (options, component) => { registered.push({ options, component }); return () => {} },
    },
    // cordis: `ctx.inject(deps, callback)` hands the callback a derived context,
    // so `forms.configForms` is the service (verified against @deepseek-ai/cordis
    // 4.0.4 `lib/index.js`, the `@Inject()` method path).
    inject: (deps, callback) => {
      if (!configForms) return
      for (const name of deps) if (name !== 'configForms') throw new Error(`unexpected inject('${name}')`)
      callback({ ...ctx, configForms: settings })
    },
  }
  try {
    body.apply(ctx)
  } catch (error) {
    failures.push(error)
  }
  return { registered, dictionaries, namespaces, effects, failures }
}

/** Walk an element tree, yielding every node (strings included). */
function* walk(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') { yield { text: String(node) }; return }
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return }
  yield node
  for (const child of node.children ?? []) yield* walk(child)
}
/** Concatenate every text leaf under a node. */
function textOf(node) {
  let text = ''
  for (const found of walk(node)) if (found.text !== undefined) text += found.text
  return text
}
/** The first node of an element type, or `null`. */
function find(node, type) {
  for (const found of walk(node)) if (found.type === type) return found
  return null
}
/** Find every node with a given element type. */
function findAll(node, type) {
  return [...walk(node)].filter((found) => found.type === type)
}

const FIELD = 'godotPath'
const PATH = 'C:/Godot/Godot_v4.7.2-stable_win64.exe'
/**
 * One settings scope, as the host projects a `.volatile()` field.
 *
 * The component binds the scope **once**, when the body registers it, and then
 * only ever reads `getSnapshot()` — so a scenario has to move this one scope's
 * snapshot rather than hand the component a different object. `move()` does that.
 */
function makeScope() {
  let snapshot = { status: 'loading', revision: 0, writable: true }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
    move: (next) => { snapshot = next },
  }
}
/**
 * Build the snapshot the host would project for a `godotPath` value.
 * @param overrides - fields to replace in the default ready snapshot.
 * @returns a settings snapshot.
 */
function snapshotOf(overrides = {}) {
  return {
    status: 'ready',
    revision: 7,
    writable: true,
    value: { [FIELD]: PATH },
    user: { [FIELD]: PATH },
    ...overrides,
  }
}

let half
try {
  half = loadClientHalf()
} catch (error) {
  check('browser half loads', false, error.message)
  report()
  process.exit(1)
}

check('module id is the package name', half.entry.id === NAME, `id=${JSON.stringify(half.entry.id)} package=${JSON.stringify(NAME)}`)
check(
  'only platform-seed specifiers required',
  half.specifiers.every((specifier) => PLATFORM_SEEDS.has(specifier)),
  `required: ${half.specifiers.join(', ') || '(none)'}`,
)
check('body exports inject + apply', Array.isArray(half.module?.inject) && typeof half.module?.apply === 'function',
  `inject=${JSON.stringify(half.module?.inject)} apply=${typeof half.module?.apply}`)
check('body injects slots', half.module?.inject?.includes('slots') === true, `inject=${JSON.stringify(half.module?.inject)}`)

const scope = makeScope()
scope.move(snapshotOf())
const withForms = applyBody(half.module, { configForms: { scope } })
check('apply() throws nothing', withForms.failures.length === 0, withForms.failures.map((error) => error.message).join('; ') || 'clean')
check('reads the row scope under the row id', withForms.namespaces.includes(ENTRY_NS), `configForms.get(${withForms.namespaces.map((ns) => JSON.stringify(ns)).join(', ')})`)

const section = withForms.registered.find((entry) => entry.options?.name === 'plugins.bundle.config')
check(
  'registers plugins.bundle.config keyed by the package name',
  section !== undefined && section.options.key === NAME,
  section === undefined
    ? `registered: ${withForms.registered.map((entry) => `${entry.options?.name}#${entry.options?.key}`).join(', ') || '(none)'}`
    : `key=${JSON.stringify(section.options.key)} keyed-slot=${JSON.stringify(section.options.name)}`,
)
check('registration carries a component', typeof section?.component === 'function', `component=${typeof section?.component}`)

const dictionaries = withForms.dictionaries.find((entry) => entry.namespace === 'godotBridge')?.dict
check('registers the zh + en dictionaries', typeof dictionaries?.zh === 'object' && typeof dictionaries?.en === 'object',
  `namespaces: ${withForms.dictionaries.map((entry) => entry.namespace).join(', ') || '(none)'}`)

if (typeof section?.component === 'function' && dictionaries !== undefined) {
  const zh = dictionaries.zh
  const t = (key) => zh[key] ?? `{${key}}`
  // The card hands the section its translator and the view it is rendering.
  const render = (snapshot) => {
    scope.move(snapshot)
    return section.component({ t, view: { packageName: NAME } })
  }

  const ready = render(snapshotOf())
  const input = find(ready, 'input')
  check('renders the stored path in the field', input?.props?.defaultValue === PATH && input?.props?.disabled === false,
    `defaultValue=${JSON.stringify(input?.props?.defaultValue)} disabled=${JSON.stringify(input?.props?.disabled)}`)
  check('renders the label and the overridden badge',
    textOf(ready).includes(zh.label) && textOf(ready).includes(zh.overridden),
    `text=${JSON.stringify(textOf(ready).slice(0, 160))}`)
  const save = findAll(ready, 'button').find((button) => textOf(button) === zh.save)
  check('renders a save control', save !== undefined, `buttons: ${findAll(ready, 'button').map((button) => JSON.stringify(textOf(button))).join(', ')}`)

  const empty = render(snapshotOf({ value: {}, user: {} }))
  check('an unset path renders an empty field without the badge',
    find(empty, 'input')?.props?.defaultValue === '' && !textOf(empty).includes(zh.overridden),
    `defaultValue=${JSON.stringify(find(empty, 'input')?.props?.defaultValue)}`)

  const readOnly = render(snapshotOf({ writable: false, value: {}, user: {} }))
  check('a read-only deployment disables the field and says so',
    find(readOnly, 'input')?.props?.disabled === true && textOf(readOnly).includes(zh.readOnly),
    `disabled=${JSON.stringify(find(readOnly, 'input')?.props?.disabled)} text=${JSON.stringify(textOf(readOnly).slice(0, 120))}`)

  const gone = render({ status: 'unavailable', revision: 1, writable: false })
  check('an unloaded row explains itself instead of rendering a dead form',
    find(gone, 'input') === null && textOf(gone).includes(zh.unavailable),
    `text=${JSON.stringify(textOf(gone).slice(0, 120))}`)

  const pending = render({ status: 'loading', revision: 0, writable: true })
  check('renders nothing before the settings document arrives', pending === null, `node=${JSON.stringify(pending)}`)
}

const withoutForms = applyBody(half.module, { configForms: null })
check(
  'stays inert where the settings-form service is absent (DSH 0.1.x)',
  withoutForms.registered.length === 0 && withoutForms.failures.length === 0,
  `registrations=${withoutForms.registered.length} failures=${withoutForms.failures.length}`,
)

report()

/**
 * Print the collected checks and exit non-zero when any of them failed.
 */
function report() {
  const json = process.argv.includes('--json')
  const failed = results.filter((result) => !result.ok)
  if (json) {
    console.log(JSON.stringify({ package: NAME, ok: failed.length === 0, results }, null, 2))
  } else {
    console.log(`${NAME} ${PKG.version} — browser half`)
    for (const result of results) console.log(`${result.ok ? '✔' : '✖'} ${result.name}  ${result.detail}`)
    console.log(`${failed.length === 0 ? '✔ browser half OK' : `✖ ${failed.length} of ${results.length} checks failed`}`)
  }
  process.exit(failed.length === 0 ? 0 : 1)
}
