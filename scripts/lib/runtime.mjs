// Shared plumbing for the scripts that need to load a plugin the way DSH does.
//
// DSH ships inside app.asar and installs a module-resolution layer at runtime,
// so nothing here works under a plain `node`: these helpers must run under the
// Electron binary in ELECTRON_RUN_AS_NODE mode. `scripts/lib/self-reexec.mjs`
// does that switch; these functions assume it already happened.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setEnvironmentData } from 'node:worker_threads'

export const RESOLUTION_KEY = '@deepseek-ai/dsh-app-boot/profile-resolution'

export function findDshApp(explicit) {
  const candidates = [
    explicit, process.env.DSH_APP,
    'D:/Program/deepseek harness desktop/DeepSeek Harness.exe',
    join(process.env.LOCALAPPDATA || '', 'Programs/DeepSeek Harness/DeepSeek Harness.exe'),
    join(process.env.LOCALAPPDATA || '', 'DeepSeek Harness/DeepSeek Harness.exe'),
    '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
  ].filter(Boolean)
  return candidates.find((c) => existsSync(c)) || null
}

export function dshHomeOf(explicit) {
  return explicit || process.env.DSH_HOME || join(homedir(), '.dsh')
}

// <app dir>/resources/app.asar/dsh/package.json
export function installAnchorFor(dshApp) {
  if (!dshApp) return null
  const anchor = join(resolve(dshApp, '..'), 'resources', 'app.asar', 'dsh', 'package.json')
  return existsSync(anchor) ? anchor : null
}

export function appBootDirFor(installAnchor) {
  return join(resolve(installAnchor, '..'), 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib')
}

export function bootstrapUrlFor(installAnchor) {
  const explicit = process.env.DSH_RESOLUTION_BOOTSTRAP
  if (explicit && existsSync(explicit)) return pathToFileURL(explicit).href
  const candidate = join(appBootDirFor(installAnchor), 'worker', 'profile-resolution-bootstrap.js')
  if (existsSync(candidate)) return pathToFileURL(candidate).href
  throw new Error(`this DSH build has no profile-resolution bootstrap at ${candidate}`)
}

export function packageNameOf(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, '')).name
}

// Read the version of the runtime that ships inside app.asar. A plain Node
// process cannot read an asar, so the caller has to be the Electron binary.
export function dshRuntimeVersion(installAnchor) {
  try { return JSON.parse(readFileSync(installAnchor, 'utf8')).version } catch { return null }
}

/**
 * Build the runtime module resolution for one profile and publish it where the
 * plugin's own import graph will pick it up.
 *
 * `linkRoots` registers extra package directories as linked roots, the same way
 * a `link:` dependency appears to DSH. Outside the profile tree a package only
 * resolves harness imports when its own peerDependencies name them — which is
 * exactly the property `link:` development depends on, so keep that field.
 */
export async function buildResolution({ dshApp, home, profile, linkRoots = [] }) {
  const installAnchor = installAnchorFor(dshApp)
  if (!installAnchor) throw new Error(`no asar runtime next to ${dshApp}`)
  const appBootDir = appBootDirFor(installAnchor)
  const appBoot = await import(pathToFileURL(join(appBootDir, 'index.js')).href)

  const profileDir = join(dshHomeOf(home), 'profiles', profile)
  if (!existsSync(profileDir)) throw new Error(`no profile "${profile}" at ${profileDir}`)

  const loaded = appBoot.loadProfileDirectory('dsh', profileDir, installAnchor, { userLayer: true })
  let resolution = await appBoot.createRuntimeResolution({ installAnchor, profile: loaded, home: dshHomeOf(home) })

  const roots = []
  const pluginEntries = []
  for (const dir of linkRoots.filter(Boolean)) {
    const root = resolve(dir)
    if (!existsSync(root)) throw new Error(`plugin directory does not exist: ${root}`)
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
    roots.push(Object.freeze({ name: manifest.name, realPath: root }))
    const main = manifest.main || 'plugin/godot-bridge.mjs'
    pluginEntries.push({ name: manifest.name, dir: root, entry: pathToFileURL(join(root, main)).href, manifest })
  }
  if (roots.length) {
    resolution = Object.freeze({ ...resolution, linkedRoots: Object.freeze([...(resolution.linkedRoots || []), ...roots]) })
  }

  setEnvironmentData(RESOLUTION_KEY, { resolution })
  const dshTools = resolution.entries?.find((e) => e.name === '@deepseek-ai/dsh-tools')
  return {
    installAnchor,
    bootstrapUrl: bootstrapUrlFor(installAnchor),
    resolution,
    dshTools: dshTools ? `${dshTools.version} (${dshTools.scope})` : null,
    pluginEntries,
  }
}
