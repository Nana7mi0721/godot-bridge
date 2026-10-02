// Run the dsh CLI *as the Electron desktop shell runs it*.
//
// Why this is needed: the shipped CLI hard-refuses the reserved profile name —
//
//   $ dsh plugin --profile desktop list
//   error: profile "desktop" is managed exclusively by the Electron application
//
// That refusal comes from `rejectElectronProfile()` in app.asar's
// `@deepseek-ai/dsh/lib/bin.js`, and it is bypassed by a single argument:
// `runCli({ manageDesktopProfile: true })`. The Electron shell passes exactly
// that when it manages its own profile, so this wrapper does too — nothing is
// patched, and the resulting profile state is identical to using the in-app
// plugin page or the plugin market.
//
// usage:
//   <DeepSeek Harness.exe> scripts/lib/run-cli.mjs --dsh-app <exe> plugin --profile desktop list
//   (with ELECTRON_RUN_AS_NODE=1, or let this file re-exec itself)

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
let dshApp = process.env.DSH_APP || null
const rest = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--dsh-app') dshApp = argv[++i]
  else rest.push(argv[i])
}

const CANDIDATES = [
  dshApp,
  'D:/Program/deepseek harness desktop/DeepSeek Harness.exe',
  join(process.env.LOCALAPPDATA || '', 'Programs/DeepSeek Harness/DeepSeek Harness.exe'),
  join(process.env.LOCALAPPDATA || '', 'DeepSeek Harness/DeepSeek Harness.exe'),
  '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
].filter(Boolean)
dshApp = CANDIDATES.find((c) => existsSync(c)) || null

if (!dshApp) {
  console.error('run-cli: could not locate "DeepSeek Harness.exe"; pass --dsh-app <path> or set DSH_APP')
  process.exit(2)
}

const binUrl = pathToFileURL(join(dirname(dshApp), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')).href

// Re-exec under the Electron binary when we are running on plain node, so the
// CLI always sees the runtime it was built against.
if (!process.versions.electron) {
  const r = spawnSync(dshApp, [fileURLToPath(import.meta.url), '--dsh-app', dshApp, ...rest], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  process.exit(r.status ?? 1)
}

const saved = process.argv
process.argv = [process.argv[0], binUrl, ...rest]
const { runCli } = await import(binUrl)
await runCli({ manageDesktopProfile: true })
process.argv = saved
