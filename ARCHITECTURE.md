[English](ARCHITECTURE.md) | [中文](ARCHITECTURE.zh-CN.md)

# godot-bridge — architecture

## Why this exists

[godot-mcp](https://github.com/tugcantopaloglu/godot-mcp) is an MCP server (stdio JSON-RPC) wrapping three layers of real work:

1. **Process management** — `spawn(godot -d --path <project>)`, collect output, kill on demand.
2. **Runtime game control** — connect to the game's `McpInteractionServer` autoload on **TCP 127.0.0.1:9090** with newline-delimited JSON `{command, params, id}`; ~105 `game_*` tools map onto these commands.
3. **Headless static operations** — `godot --headless --path <project> --script godot_operations.gd <op> <json>` (scene edits, script validation, project creation).

The MCP layer itself contributes nothing but an outer JSON-RPC shell. DeepSeek Harness already has native equivalents for everything:

| layer | godot-mcp | godot-bridge |
| --- | --- | --- |
| process | Node `spawn` | host `subprocess.spawn` (same args) |
| runtime | TCP 9090 JSON | same TCP 9090 JSON via a one-shot `node -e` bridge |
| headless | `godot --headless …` | included: `godot_headless_op` + `godot_validate_script` over vendored `godot_operations.gd` / `validate_script.gd` |

Crucially, **the game side does not know MCP exists**: `mcp_interaction_server.gd` is a plain TCP JSON server. Replacing the MCP server requires zero game-side changes; `project.godot` autoloads stay as-is.

## The TCP bridge

The dynamic sandbox and the preset environment expose no raw `net` socket to plugin code, so each command spawns a short-lived `node -e` bridge:

```
node -e "<bridge>" <command> <paramsJson>
```

The bridge connects to 127.0.0.1:9090, writes one `{command, params, id:1}\n`, prints the first complete response line, and exits. The game server is single-connection with a `_busy` flag, so this connection-per-command model is a perfect match. `argv[1]`/`argv[2]` carry the command and params (`node -e` puts extra args at index 1+).

## Sandbox interaction (the important one)

DSH's file sandbox (`workspace-write`) restricts writes to the workspace + temp areas. The **shell executor** (pwsh/bash tools) applies that policy to the whole process tree (Windows restricted-token runner), so launching Godot from a shell tool crashes it: Godot writes `user://` (= `%APPDATA%\Godot\app_userdata\<project>\`, startup logs) and dies with `Failed to open 'user://logs/…'` → signal 11.

godot-bridge spawns through the harness's **raw `subprocess` service** — the unconfined primitive the shell executor itself uses internally — so Godot runs normally. Do not launch the game through pwsh/bash tools in a sandboxed session; use `godot_run_project`.

## Tool model

All tools return the game's response JSON verbatim (canonical value validated against `{type:'object', additionalProperties:true}`), rendered as text. Tool calls are exclusive by default (no `isConcurrencySafe`), matching the single-command game server.

## Dependency contract and runtime resolution

A DSH plugin that imports harness packages (`@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`, …) never resolves them from the npm registry. The launcher computes one immutable **runtime resolution** — the dependency closure of the installation plus the selected bundles — and installs it into Node's ESM and CommonJS resolvers (DSH 0.2 does this in-process, replacing the 0.1.x physical module-fallback layer; the old `.dsh-module-fallback` directories are only cleaned up). Which modules get that routing is decided per importing path:

- **Inside the profiles tree** (`$DSH_HOME/profiles/<name>/…`): a profile-layer importer is routed to the installation's copy for any `@deepseek-ai/*` package the installation carries. A bundle installed with `dsh plugin add` lives here, so it needs no declaration.
- **Linked root** (a symlink under a profile's `node_modules` whose target lies outside the profiles tree — what a `link:` dependency produces): routed only for package names the importing package declares in its own `peerDependencies`. The resolver reads `peerDependencies` keys, not `dependencies`, and Node's ESM loader resolves symlinks before importing, so the importer path really is the target outside the tree.
- **Anything else** (a path outside both, e.g. a file copied into an agent preset): no routing at all — plain Node lookup, which cannot see the installation's packages.

Two consequences shape this package's manifest:

- `peerDependencies` is a **load-time contract**, not just metadata: without the declaration a `link:` install fails the whole bundle import (`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'`) and none of the seventeen tools registers — the 0.1.7-and-earlier behaviour on DSH 0.2.
- DSH also **gates** declared `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peers against the runtime version (prereleases participate in the range match). A range that does not match makes the launcher skip the bundle with an explicit message; a missing peer imposes no constraint and therefore can never cause a skip. That is why the declaration is a range (`>=0.1.6-0`) rather than a pin, and why `peerDependenciesMeta.optional` marks the harness packages: pnpm must never fetch them from the registry.

The **browser half** is a different contract and deliberately declares nothing here. `dsh.client` makes the host serve `exports["./client"]` as a classic script to the web client, and that script's factory resolves its imports against the client's own platform module table (React and a few static libraries) instead of Node — so no `peerDependencies` entry participates. It exists for one reason: the Plugins page renders a configuration section only for a bundle whose browser half registers one of its slots, and this half registers `plugins.bundle.config` under the package name, which is what puts the `Godot engine path` field on the `godot-bridge` card's page. Its writes take the client settings road (`configForms` scope → the settings service → `configEditor.edit`), i.e. the same profile patch the `godot_set_engine_path` tool writes.

```mermaid
flowchart LR
    L["dsh launcher"] --> R["runtime resolution<br/>ESM + CJS resolver hooks"]
    R -->|"importer inside the profiles tree"| I["installation copy<br/>@deepseek-ai/*"]
    R -->|"linked root + peerDependencies key"| I
    R -->|"linked root, name not declared"| N["native Node lookup<br/>→ ERR_MODULE_NOT_FOUND"]
    R -->|"outside every scope"| N
```

`npm run check` enforces the declaration statically; `scripts/diagnose-dsh-resolution.mjs` prints what a running launcher actually routes.

## Architecture diagrams

### System overview

```mermaid
flowchart TB
    subgraph GITHUB["GitHub — Smalldy/godot-bridge"]
        REPO["bundle<br/>package.json (dsh.bundle · dsh.client) · cordis.patch.yml · plugin/ · client/"]
    end

    subgraph DSH["DeepSeek Harness host (web profile)"]
        PROFILE["$DSH_HOME/profiles/web/package.json<br/>dsh.profile.bundles = base · web-app · godot-bridge"]
        NODE["profiles/web/node_modules/godot-bridge"]
        PLUGIN["cordis row tool-godot-bridge<br/>godot-bridge.mjs apply(ctx)"]
        TOOLS["17 godot_* tools<br/>defineTool + ctx.tools.register"]
        PROMPT["system-prompt sections<br/>update notice (conditional)"]
    end

    subgraph CHANNELS["Plugin channels"]
        BRIDGE["node -e one-shot TCP bridge"]
        HEADLESS["godot --headless --script<br/>godot_operations.gd / validate_script.gd"]
        PROC["subprocess.spawn(godot -d --path …)"]
        FILE["fs service<br/>project.godot · export_presets.cfg"]
        NET["fetch raw.githubusercontent.com<br/>boot-time version check"]
    end

    subgraph GAME["Godot project (user)"]
        AUTOLOAD["project.godot [autoload]<br/>McpInteractionServer"]
        SERVER["mcp_interaction_server.gd<br/>TCP 127.0.0.1:9090"]
        SFILES["scenes/*.tscn · resources/*.tres<br/>scripts/*.gd"]
    end

    GITHUB -->|"dsh plugin add github:… / release .tgz"| PROFILE
    PROFILE --> NODE
    NODE --> PLUGIN
    PLUGIN --> TOOLS
    PLUGIN --> PROMPT
    TOOLS --> BRIDGE
    BRIDGE -->|"{command, params, id}<br/>newline-delimited JSON"| SERVER
    TOOLS --> HEADLESS
    HEADLESS --> SFILES
    TOOLS --> PROC
    PROC -->|"boots the game"| SERVER
    TOOLS --> FILE
    FILE --> SFILES
    PLUGIN --> NET
    AUTOLOAD --> SERVER
```

### Tool channels

```mermaid
flowchart LR
    subgraph TOOLS["godot_* tools"]
        P["process<br/>run / stop / get_debug_output / ping"]
        R["runtime<br/>command / screenshot"]
        H["headless<br/>headless_op / validate_script / export_project"]
        E["project-edit<br/>set_project_setting / manage_* / create_*"]
    end
    P -->|"spawn + collected output"| G["Godot process"]
    R -->|"TCP 9090 via node -e bridge"| S["McpInteractionServer<br/>inside the game"]
    H -->|"godot --headless"| F["scene / resource / script files"]
    E -->|"fs service"| F
    S --> G
```

### godot_run_project — launch flow

```mermaid
sequenceDiagram
    participant Agent
    participant RP as godot_run_project
    participant H as plugin helpers
    participant FS as fs service
    participant GO as Godot process
    participant SRV as McpInteractionServer 9090

    Agent->>RP: execute({project_path, scene, wait_ms})
    RP->>H: ensureInteractionAutoload(project)
    H->>FS: read project.godot
    alt autoload missing
        H->>FS: copy vendored gd → autoload/<br/>register [autoload] entry
    end
    RP->>H: launchProject(project, …)
    H->>GO: subprocess.spawn(godot -d --path project)
    Note over GO: boots — autoload starts the TCP server
    loop poll ≤ wait_ms (default 20s, every ~4s)
        H->>SRV: get_performance via node -e bridge
        SRV-->>H: ok
    end
    RP-->>Agent: {game_ready, autoload, pid, port, note}
```

### Runtime tool pre-flight (self-healing guard)

```mermaid
sequenceDiagram
    participant Agent
    participant T as godot_command / godot_screenshot
    participant G as ensureGameService
    participant LP as launchProject
    participant SRV as McpInteractionServer 9090

    Agent->>T: execute(...)
    T->>G: probe get_performance (1.5s timeout)
    alt server answers
        G-->>T: pass
    else no game + project derivable<br/>(project_path or workspace project.godot)
        G->>LP: auto-start project<br/>(autoload self-heal + spawn + wait ready)
        LP-->>G: game_ready
        G-->>T: pass
    else nothing derivable
        G-->>T: guidance error (call godot_run_project)
    end
    T->>SRV: runGameCommand(command) via bridge
    SRV-->>T: response JSON
    T-->>Agent: result
```

## Known behavior notes

- `eval` compile errors pause a debug-mode game at the debugger (identical to godot-mcp). Recover with `godot_stop_project` + `godot_run_project`; write dynamic-access code (`node.get("prop")`) to dodge static typing.
- `godot_get_debug_output` is incremental (offset-based readers).
- The configured Godot path must be the real exe; a version-manager shim exits immediately and orphans the real process.
