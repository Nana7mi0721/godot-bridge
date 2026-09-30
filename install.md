[English](install.md) | [中文](install.zh-CN.md)

# godot-bridge — install & maintenance

## Files

```
plugin/godot-bridge.mjs           # the plugin (standard DSH module: named exports name/inject/apply)
plugin/mcp_interaction_server.gd  # vendored from godot-mcp (MIT) — in-game TCP server autoload
plugin/godot_operations.gd        # vendored from godot-mcp (MIT) — headless ops script
plugin/validate_script.gd         # vendored from godot-mcp (MIT) — GDScript compile-check
package.json                      # dsh.bundle manifest (for `dsh plugin add`)
cordis.patch.yml                  # bundle patch layer (inserts the tool row)
```

The plugin is a standard DSH bundle module: it imports `defineTool` from `@deepseek-ai/dsh-tools` and registers the seventeen `godot_*` tools via `ctx.tools.register`. It uses named exports (`export const name`, `export const inject`, `export function apply`) — the cordis loader's `unwrapExports` (`exports.default ?? exports`) turns the namespace into the plugin object. Do not add a stray `export default`: it would make `unwrapExports` collapse to that single value and silently drop `name`/`inject`/`apply`.

Because it imports `@deepseek-ai/*`, the module must resolve the harness dependency tree at load time. DSH 0.2 does that with the launcher's runtime resolution instead of a physical fallback layer: a bundle installed into `$DSH_HOME/profiles/<name>/node_modules` is routed to the installation's copies automatically, while a `link:` checkout — whose real path lies outside the profiles tree, because Node's ESM loader resolves symlinks before importing — is routed only for names the plugin declares in its own `peerDependencies`. godot-bridge ≥ 0.1.8 declares `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery` (both `peerDependenciesMeta.optional`, so pnpm never installs harness packages from the registry). Keep that declaration when you edit the manifest — `npm run check` fails without it. Do **not** copy the file into a user agent preset (`~/.dsh/.agent-presets/...`): that location is outside every resolution scope and cannot resolve `@deepseek-ai/dsh-tools`.

## Install

### Recommended: community bundle (`dsh plugin add`)

```sh
dsh plugin --profile web add github:Smalldy/godot-bridge
```

`dsh plugin` is a pnpm forwarder: it installs the package into the profile and — because the package's `dsh.bundle` manifest points at `cordis.patch.yml`, which inserts the `tool-godot-bridge` row (referenced by package name) — appends `godot-bridge` to the profile's `dsh.profile.bundles` layer list. Pure ESM + assets, no build script, so a git install needs no `allowBuilds` exemption. After a restart, every session on that profile has the seventeen tools.

The same command installs a local checkout or a tarball:

```sh
dsh plugin --profile web add ./path/to/godot-bridge     # local checkout
dsh plugin --profile web add ./godot-bridge-0.1.8.tgz   # pnpm pack output
```

### Local development (`link:`)

A `link:` dependency (`"godot-bridge": "link:/path/to/godot-bridge"` — what pnpm writes when you add a local checkout to the profile) turns the profile's `node_modules/godot-bridge` into a symlink to your working copy, so edits are picked up without reinstalling. It is also the one install shape the launcher's runtime resolution cannot route by itself: the plugin's real path sits outside the profiles tree, and a *linked root* gets harness packages routed only for names the plugin declares in its `peerDependencies`. That declaration is why 0.1.8 exists — without it the whole bundle fails to import (`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools' imported from …godot-bridge.mjs`) and none of the seventeen tools registers.

- Prefer a non-symlinked install when you do not need live edits: `pnpm pack`, then `dsh plugin --profile web add ./godot-bridge-0.1.8.tgz` (reinstall after each change).
- After changing the manifest or the plugin, reload the profile (Plugins page) or restart DSH, then confirm the seventeen tools. `npm run check` guards the contract and `scripts/diagnose-dsh-resolution.mjs` reports what the launcher actually routes — see [README → DSH 0.2+ compatibility](README.md#dsh-02-compatibility-and-troubleshooting).

## Uninstall

```sh
dsh plugin --profile web remove godot-bridge
```

`dsh plugin remove` forwards to `pnpm remove` in the profile directory and then reconciles `dsh.profile.bundles` — the dependency **and** the `godot-bridge` bundle layer are both removed from the profile's `package.json`. After a restart, the seventeen `godot_*` tools are gone from sessions on that profile. The `web` profile itself (the standard one) is untouched; removing a plugin never creates or deletes a profile.

Notes:

- If a Godot process is running, stop it first with `godot_stop_project` — once the plugin is gone there is no tool to do it. As a safety net, the plugin registers an unload effect that terminates any Godot child it started, so a session reload after removal cleans it up.
- Nothing else is touched: `project.godot`, the game's `McpInteractionServer` autoload, and any game files are never modified by install or removal.
- Reinstall any time with the `add` command above.

## Config

- Godot executable: per-tool `godot_path` argument > the `godotPath` plugin setting > the `godot` command on PATH. The plugin author does **not** preset a path (Godot is a portable exe that can live anywhere); set your own engine path when it isn't on PATH. Always point at the **real exe**, never a version-manager shim.

  `godotPath` is a `.volatile()` field of the plugin's own config: it is read live (volatile fields update without remounting the plugin). Where the value lives:

  - **DSH 0.2.x** — the config of the `tool-godot-bridge` row: set it with the `godot_set_engine_path` tool (it writes the profile patch through `ctx.configEditor.edit(...)` and applies immediately — no restart), or add a `config:` block on that row in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. The tool checks that the file exists before writing and reports `persisted: 'profile-patch'`.

    ```yaml
    - id: tool-godot-bridge
      config:
        godotPath: C:/path/to/Godot_v4.4-stable_win64.exe
    ```
  - **DSH 0.1.6–0.1.x** — the legacy settings section (`godot-bridge:` in `$DSH_HOME/settings.yaml`, or that release's plugin-config page); the plugin still uses `settings.register` when that API exists and reports `persisted: 'settings'`.
  - Migrating 0.1.x → 0.2.x: a `godot-bridge:` section in `settings.yaml` is **not** carried over, because DSH 0.2 imports leftover sections by plugin entry id and this plugin's row id is `tool-godot-bridge`. You do not have to re-enter it: when this runtime has no configured path, the plugin reads that section and writes the recorded value back through the same profile-patch path as the tool, so the engine build configured before the upgrade is used again. An already-configured value is never overwritten, and a recorded path that no longer exists on disk is ignored — that case keeps the `godot` on PATH fallback and logs a warning naming the dropped value.
- Port/host: hardcoded `127.0.0.1:9090` (matches the `McpInteractionServer` autoload default).
- Headless scripts: the plugin locates them relative to the module (`import.meta.url`); pass an explicit `ops_script` / `validate_script` argument to override.

## No GUI field on DSH 0.2

DSH 0.2's Plugins page renders a configuration form only for rows whose **client component** registers the keyed slot `plugins.row.config` — no built-in package registers it, so a plugin must ship its own client entry (`dsh.client` in its manifest). godot-bridge ships none, so its row has **no settings form** and no `Godot engine path` field.

This is a presentation gap, not a broken config: the Host side is correct (`settings.describe()` projects `godotPath` for the `tool-godot-bridge` row), and the two paths above both work. Tracked separately as a feature request.

## Maintenance

- Editing `plugin/godot-bridge.mjs` needs no rebuild (plain ESM).
- After changing the plugin, reinstall it into the profile (`dsh plugin --profile web add github:Smalldy/godot-bridge` again) and restart the session. A `link:` install needs no reinstall — reload the profile (Plugins page) or restart DSH.
- Before committing or publishing, run `npm run check` (static dependency contract: declared `@deepseek-ai/*` peers, bundle patch, entry exports). `node scripts/diagnose-dsh-resolution.mjs --profile <profile>` re-runs the launcher's resolution and prints what it routes (development only; needs the installed DSH app).
- The manifest's `peerDependencies` change what DSH may load: a declared `@deepseek-ai/dsh-*` range that does not match the running runtime makes DSH skip the bundle with an explicit message instead of failing at import.
- **Publishing an update**: bump `version` in `package.json` and push — the plugin's boot-time check (see README "Update notices") uses that version as the release marker, so existing installs only see a notice when it is higher than what they have.
- The game side (`mcp_interaction_server.gd` autoload) is never modified by the plugin.
