---
name: dsh-plugin-compat-repair
description: 当 DSH（DeepSeek Harness）插件在 harness 升级后无法加载时使用——症状是插件工具整批消失、插件页/日志出现 "skipping profile bundle" 或 "ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/…'"、插件设置项不见了、`link:`（符号链接）安装突然失效。按 DSH 0.2 的 runtime resolution 规则定位根因（linked root 的 peerDependencies 契约、settings→volatile+configEditor 的 API 漂移），修复后按 issue+PR 流程发版。
whenToUse: 用户报告 DSH 插件在 harness 升级后加载失败、工具消失、设置项缺失，或让你排查某个 dsh 插件的 harness 依赖解析问题时。
---

# DSH 插件兼容性修复（升级后无法加载）

## 0. 先分清三种失败

| 症状 | 真实含义 | 位置 |
|---|---|---|
| 插件所有工具同时消失；日志有 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/xxx' imported from …` | 模块 import 失败：harness 包没有被路由到安装版副本 | 依赖契约 / 解析层 |
| launcher 打印 `dsh: skipping profile bundle "<name>": <reason>` | bundle 被启动器主动跳过：patch 读不到，或声明的 `@deepseek-ai/dsh*` peer 范围与运行时版本不匹配 | 兼容性门禁 |
| 插件能加载、工具在，但某个设置字段/写回能力失效，或 `ctx.someService.method is not a function` 被 try/catch 吞掉 | 插件用了已被移除的 harness API（多为静默降级） | 插件自身代码 |

先看 launcher 的 stderr（桌面版为宿主进程日志），再看插件页错误。**不要**一上来就怀疑业务代码。

## 1. 五分钟分诊

1. **装法是什么？** `link:`（profile 的 `node_modules/<pkg>` 是指向本地 checkout 的符号链接）与「装进 profile 的普通依赖」在 0.2 的解析规则下**行为不同**：
   - 装在 profile 内 → harness 包自动解析，无需任何声明；
   - `link:` → 插件真实路径落在 profiles 树之外（Node ESM 会 realpath），只有插件自己在 `peerDependencies` 里声明过的包名才会被路由。
   查：`ls -l <DSH_HOME>/profiles/<profile>/node_modules/<pkg>`（Windows：`Get-Item … | Select LinkType,Target`）。
2. **清单里有没有这个包？** 看 `<DSH_HOME>/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 与依赖 spec。
3. **插件 import 了哪些 harness 包？** 逐个对照插件 `package.json` 的 `peerDependencies`。**解析器只读 `peerDependencies` 的键，不读 `dependencies`。**
4. **跑仓库自带的两个检查**（godot-bridge 仓库）：
   ```sh
   npm run check                                                             # 静态契约检查，不需要 DSH
   node scripts/diagnose-dsh-resolution.mjs --profile <profile> --expect ok   # 用已安装的 DSH 复现真实解析
   ```
5. 仍然不明 → 用第 2 节做最小复现，别猜。

## 2. 取证配方（最小复现，不惊动运行中的 app）

关键事实：**安装的 harness 代码在 `app.asar` 里，只有 DSH 的 Electron 可执行文件能读**。用 `ELECTRON_RUN_AS_NODE=1` 把它当 node 用：

```powershell
$exe = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe"
$env:ELECTRON_RUN_AS_NODE = '1'
& $exe -e "console.log(process.version, process.versions.electron)"
```

`scripts/diagnose-dsh-resolution.mjs` 已经封装了下面的步骤（它会在非 Electron 环境下自动用 app 重新执行自己）：

1. 用安装版 app-boot 载入 profile：`appBoot.loadProfileDirectory('dsh', profileDir, installAnchor, {})` → 打印 `layers` 与 `skippedBundles`（`skippedBundles` 的 `reason` 就是 launcher 打印的那句话）。
2. 计算并发装同一份 runtime resolution：`createRuntimeResolution({ installAnchor, profile, home })` → 打印 `linkedRoots`（`link:` 安装会在这里出现）。
3. 在 Worker 里导入 app-boot 的 worker bootstrap（`lib/worker/profile-resolution-bootstrap.js`），父线程先 `setEnvironmentData('@deepseek-ai/dsh-app-boot/profile-resolution', { resolution })`；worker 随后 `import(<插件入口>)`，拿到真实结果。
   - **必须**用 asar 里的 bootstrap：解包出来的副本找不到 `node-addon-require-builtin`。
4. **对照实验**（决定性的那一步）：同一个 resolution、同一个 worker，
   - 从插件**真实路径**导入 → 复现 FAIL；
   - 造一个「profile 内真实目录副本」（把插件文件 copy 进 `<profile>/node_modules/<pkg>/`，不需要符号链接；junction 在 Node 下不算 symlink）再导入 → OK。
   两者差异就锁定在「linked root + peer 声明」上，与包是否安装、版本是否兼容无关。

想直接读 harness 内部实现时，写个 asar 解析器（读文件头 pickle + header JSON，按 offset 取文件）或用 Electron：
`& $exe -e "import('file:///…/app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')"`。

## 3. 修复模式库

- **linked root 缺 peer 声明**：给插件 `package.json` 加 `peerDependencies`，**只声明被 import 的包**（如 `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`），并加 `peerDependenciesMeta.optional = true` 防止 pnpm 去 registry 装 harness 包。
- **版本范围语义**：DSH 只对 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 做门禁，用 `semver.satisfies(runtime, range, { includePrerelease: true })`；预发布版本参与匹配，所以 `>=0.1.6-0` 这类范围能同时覆盖 `0.1.6-alpha.2` 与 `0.2.0-rc.2`。**缺失 peer 不构成约束**（不会导致 skip），范围不匹配才会被 skip 并打印原因。
- **settings API 漂移**：0.2 的 `@deepseek-ai/dsh-settings` 只剩 `configure/describe/schema`（`register` 已删除）。新写法：
  - Config 字段加 `.volatile()`（schemastery 3.18+；旧版用 `typeof field.volatile === 'function'` 特性探测）→ 设置页只投影 volatile 字段；
  - 读取活值：volatile 字段解析成冻结的 `{ get() }` 引用，且**不 remount**，必须走 `.get()`（`updateVolatile` 原地写引用）；
  - 写入：`ctx.configEditor.edit(entry, (current) => ({ ...current, field: value }))` —— 校验整份候选、写 active profile 的 `cordis.patch.yml`、热重组；`entry` 用 `ctx.fiber.entry` 定位并用 `editor.entries()` 校验成员资格；
  - 保留旧运行时兜底时，用「双栈 + 单一入口」：两个 `ctx.inject` 各装一个 writer，调用时优先新 API，避免行为分叉。
- **不要 `export default`**：loader 的 `unwrapExports` 是 `exports.default ?? exports`，加了 default 会把 `name`/`inject`/`apply` 静默丢掉。
- **别把插件放到解析范围之外**：`~/.dsh/.agent-presets/...` 之类的路径没有任何拦截层，harness 包永远解析不到。

## 4. 验证清单

- [ ] 静态契约检查通过，且对「删掉 peer 声明的副本」会失败（护栏自证）。
- [ ] 诊断脚本 `--expect ok` 全 OK；`--repo <无 peer 的夹具>` 时 `--expect fail` 命中。
- [ ] apply 级冒烟：用假 ctx（`inject/effect/logger` + 假 `tools.register`）调 `apply()`，确认工具数量、systemPrompt section 数、以及两条写入路径（新 API / 旧 API）返回值；`defineTool` 会在这一步暴露选项形状不匹配。
- [ ] 重启 DSH（或插件页重载 profile）后，新会话工具齐了；插件页无 skip。
- [ ] 设置字段出现在插件页，写回后**无需重启**生效。
- [ ] 工作区无临时夹具/未跟踪残留。

## 5. 发版流程（规范化）

1. 分支：`fix/<主题>`（如 `fix/dsh-0.2-compat`）；从 `main` 切出。
2. 提交按主题分组：`fix(deps)` / `refactor(config)` / `test(contract)` / `docs` / `chore(release)`。
3. **两个 Issue**：
   - Bug Issue：现象 / 环境（DSH 版本、装法、profile）/ 根因（带代码位置）/ 证据（诊断输出）/ 修复（指 PR）/ 临时绕过。
   - 下线计划 Issue（若本次保留了旧运行时兜底）：触发条件（如「DSH 稳定版 ≥0.2 后 1 个 minor」或「插件下个 minor」）、移除清单、通知方式。
4. PR：用 `.github/pull_request_template.md`；body 写 `Closes #<bug>`、`Refs #<下线>`。
5. 版本号 + 双语 CHANGELOG 同批更新；版本号就是插件启动更新提示的发布标记。
6. `gh pr create` / `gh issue create`；发布（push/tag/publish）由人执行。

## 6. 已知陷阱

- **沙箱伪故障**：在受限沙箱里跑 DSH CLI 会出现 `EPERM ... package.json.lock` 或删除 `.dsh-module-fallback` 失败，这不是插件 bug；换到工作区内或用真实 app 复核。
- **Node ESM 会 realpath**：`--preserve-symlinks` 只影响 CJS；ESM 下符号链接路径永远变成真实路径——这正是 linked root 的判定依据。
- **junction ≠ symlink（在 Node 下）**：`lstat().isSymbolicLink()` 对 junction 为 false、`readlink` 报 `EINVAL`，所以 junction 安装会被当成「profile 内副本」，不能用来复现 linked root。
- **旧 `.dsh-module-fallback` 残留**：0.2 启动时会尝试删除；删不掉会 boot 失败，需先排除占用再手工清理。
- **取证输出打码**：`git remote -v`、配置片段里可能带 token，贴日志前先脱敏。
