# 失败模式库（DSH 0.2 与 0.1.x 的差异）

每条：**症状 → 机制 → 修法**。机制部分都标了可在安装版 harness 里复核的代码位置。

## 1. linked root 未声明 harness 包 → 整包 import 失败

**症状**：插件所有工具消失，日志 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools' imported from …`。

**机制**：0.2 用进程内 runtime resolution 取代 0.1.x 的物理 module-fallback 层（旧 `.dsh-module-fallback` 只留清理逻辑）。解析器按「import 该模块的路径」决定是否路由：

- profiles 树内 → 自动路由到安装版副本；
- **linked root**（`link:` 产生的、指向树外目录的符号链接）→ 只有包名出现在**该包自己的 `peerDependencies`** 里才路由。判定点在 `@deepseek-ai/dsh-app-boot` 的 `routeLinked` → `readPeerNames(directory).has(name)`（`lib/index.js` 约 L1471–1479，worker bootstrap 同款逻辑）。Node ESM 会先 realpath 再 import，所以 `link:` 安装的 importer 路径确实在树外。

**修法**：在插件 `package.json` 的 `peerDependencies` 里声明**被 import 的**包（如 `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`），并加 `peerDependenciesMeta.optional = true` 防止 pnpm 去 registry 拉 harness 包。声明面保持最小。

**对照结论**：profile 内正常安装**不需要**这些声明；只有 linked root 需要。所以"把插件复制进 profile"是一条可行的临时绕过。

## 2. peer 版本范围不匹配 → bundle 被 skip

**症状**：launcher 打印 `dsh: skipping profile bundle "<name>": <reason>`；插件页报错。

**机制**：DSH 只对 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 做门禁，判定是 `semver.satisfies(runtime, range, { includePrerelease: true })`（`dsh-app-boot` 的 `evaluatePluginCompatibility`）。预发布版本参与匹配；`workspace:^|~|*` 等价于当前运行时。**缺失 peer 不构成约束**（不会 skip），只有范围不匹配才会。

**修法**：把范围写宽以同时覆盖目标区间，例如 `>=0.1.6-0` 可覆盖 `0.1.6-alpha.2` 与 `0.2.0-rc.2`。应急手段：`dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version <runtime> --accept-risk`（精确版本豁免，写进 profile 的 `compatibility.json`）。

## 3. settings API 漂移 → 配置静默失效

**症状**：`ctx.someService.method is not a function` 被自己的 try/catch 吞掉；设置写入工具恒返回"服务不可用"。

**机制**：0.2 的 `@deepseek-ai/dsh-settings` 只剩 `configure/describe/schema`（**`register` 已删除**）。新模型是：

- 插件 `Config` 的字段加 `.volatile()`（schemastery 3.18+）→ 才被设置表单投影（`volatileForm()` 只挑 volatile 子树）；
- volatile 字段解析成**冻结的 `{ get() }` 引用**，更新**不 remount**（`cosmokit` 的 `createVolatile` / `updateVolatile` 原地写引用）→ 读活值必须走 `.get()`；
- 写入走 `ctx.configEditor.edit(entry, (current) => next)`：校验整份候选 → 写 active profile 的 `cordis.patch.yml` → 热重组。`entry` 用 `ctx.fiber.entry` 定位，并用 `editor.entries()` 校验成员资格。

**修法**：双栈 + 单一入口——`ctx.inject(['configEditor'], …)` 装新 writer，`ctx.inject(['settings'], …)` 仅在 `typeof settings.register === 'function'` 时装旧 scope；两者共用一个"取活值"函数，避免行为分叉。

## 4. 版本门禁的兼容性 vs 运行时的兼容性

**要点**：`peerDependencies` 同时承担两件事——**解析路由**（模式 1）与**版本门禁**（模式 2）。声明了才能被路由；声明了不匹配的范围又会被 skip。所以范围必须同时满足「覆盖目标运行时」与「不误伤旧运行时」。

## 5. 插件页没有配置表单（呈现层，非配置损坏）

**症状**：插件加载正常、工具可用、Host 侧配置读写正常，但插件行**没有设置表单**、看不到任何字段。

**机制**：插件页的「配置」入口由 **keyed slot `plugins.row.config`** 驱动（`dsh-client-ui-plugin-manager` 消费：`ledger.rows.has(rowConfigKey(pkg.name, row.rowId))`）。**app.asar 里没有任何内置包注册该插槽**——官方内置插件是随发行版编译进去的，第三方拿不到。所以插件必须自带客户端组件：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "inject": [...], "platform": "web" } }
```

再在 client 入口里 `ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: '<entryKey>' }, Form))`。

**不要误判**：Host 侧的 `settings.describe()` 对这类 row 是**正常**的（能投影出 schema 与 value/base/user，`ns` 即 entry id）。所以「没有表单」不代表 schema 写错了——先用模式 6 的探针确认 Host 侧，再判断是不是缺客户端组件。

**修法**：补客户端组件（大改），或在文档写明替代路径（工具写入 / 行 `config:` 块）+ 开跟踪 issue。

## 6. 自查探针（判断模式 5 是否成立）

镜像 `dsh-settings` 的投影函数（`volatileForm` / `projectForm` / `plainConfig`）跑在插件自己的 `Config` 上，**并与一个官方 volatile 字段做对照**：

- `volatileForm(Config)` 返回 `undefined` → 没有任何 volatile 字段，表单必然为空；
- `plainConfig(resolved)[field]` 与 schema 声明的类型不一致 → 投影/解引用有问题；
- 两者都正常而页面没表单 → 属于模式 5（缺客户端组件）。

**判定坑**：`cosmokit` 的 write 符号是**模块局部符号**（`Symbol('cosmokit.volatile.write')`），不是 `Symbol.for(...)` 注册的全局符号。用 `Symbol.for` 去 `in value` 恒为 false，会得出"未解引用"的**假根因**。正确做法是从被测值自身取符号：`Object.getOwnPropertySymbols(value).find(s => /volatile\.write/.test(String(s)))`。

## 7. 入口导出形态

**机制**：loader 的 `unwrapExports` 是 `exports.default ?? exports`。加了 `export default` 会把 `name`/`inject`/`apply` 静默丢掉。

**修法**：用命名导出，不要 `export default`；把它做成静态检查项。

## 8. 解析范围之外

**机制**：`~/.dsh/.agent-presets/...` 之类的路径没有任何拦截层，harness 包永远解析不到。

**修法**：一律通过 bundle 机制安装（profile 的 `node_modules` 下）。
