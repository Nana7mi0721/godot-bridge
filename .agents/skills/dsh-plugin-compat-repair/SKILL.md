---
name: dsh-plugin-compat-repair
description: 当 DSH（DeepSeek Harness）插件在 harness 升级后无法加载时使用——症状是插件工具整批消失、launcher 日志出现 "skipping profile bundle" 或 "ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/…'"、插件在目标版本上行为异常。按 DSH 0.2 的 runtime resolution 规则定位根因（linked root 的 peerDependencies 契约、settings→volatile+configEditor 的 API 漂移、客户端插槽缺失），并用安装版 harness 代码做最小复现取证。只负责问题定性与修复；分支/Issue/PR/发版流程见 dsh-plugin-workflow。
whenToUse: 用户报告 DSH 插件在 harness 升级后加载失败、工具消失、设置项或写回能力失效，或让你排查某个 dsh 插件的 harness 依赖解析、配置模型兼容问题时。
---

# DSH 插件兼容性修复（升级后无法加载）

**本技能只做问题定性 + 修复方案。** 分支、提交、Issue、PR、验收、发版，以及**对外发言的身份要求**，一律走 [`dsh-plugin-workflow`](../dsh-plugin-workflow/SKILL.md)。

参考材料：
- [`references/evidence-recipes.md`](references/evidence-recipes.md) —— **两个仓库自带脚本的用法与时机**、asar 取证、手工最小复现、apply 冒烟
- [`references/failure-patterns.md`](references/failure-patterns.md) —— 已知失败模式与对应修法

## 先分清四类失败

| 症状 | 真实含义 | 位置 |
|---|---|---|
| 插件所有工具同时消失；日志有 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/xxx' imported from …` | 模块 import 失败：harness 包没有被路由到安装版副本 | 依赖契约 / 解析层 |
| launcher 打印 `dsh: skipping profile bundle "<name>": <reason>` | bundle 被启动器主动跳过：patch 读不到，或声明的 `@deepseek-ai/dsh*` peer 范围与运行时版本不匹配 | 兼容性门禁 |
| 插件能加载、工具在，但某个设置字段/写回能力失效，或 `ctx.someService.method is not a function` 被 try/catch 吞掉 | 插件用了已被移除的 harness API（多为静默降级） | 插件自身代码 |
| 插件能加载、工具在、Host 侧配置正常，但**插件页没有配置表单** | 该 row 的 keyed slot `plugins.row.config` 无人注册：DSH 只为自带客户端组件（`dsh.client`）的插件渲染行表单 | 客户端呈现层（不是配置损坏） |

先看 launcher 的 stderr（桌面版为宿主进程日志），再看插件页错误。**不要**一上来就怀疑业务代码。

## 五分钟分诊

1. **装法是什么？** `link:`（profile 的 `node_modules/<pkg>` 是指向本地 checkout 的符号链接）与「装进 profile 的普通依赖」在 0.2 的解析规则下**行为不同**：
   - 装在 profile 内 → harness 包自动解析，无需任何声明；
   - `link:` → 插件真实路径落在 profiles 树之外（Node ESM 会 realpath），只有插件自己在 `peerDependencies` 里声明过的包名才会被路由。
   查：`Get-Item <DSH_HOME>/profiles/<profile>/node_modules/<pkg> | Select LinkType,Target`。
2. **清单里有没有这个包？** 看 `<DSH_HOME>/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 与依赖 spec。
3. **插件 import 了哪些 harness 包？** 逐个对照插件 `package.json` 的 `peerDependencies`。**解析器只读 `peerDependencies` 的键，不读 `dependencies`。**
4. **跑仓库自带的两个检查**（时机、参数、坑见 [`references/evidence-recipes.md`](references/evidence-recipes.md) 开头的"仓库自带的两个工具"）：
   ```sh
   npm run check                                                             # 静态契约检查，不需要 DSH
   node scripts/diagnose-dsh-resolution.mjs --profile <profile> --expect ok   # 用已安装的 DSH 复现真实解析
   ```
   诊断脚本记住三点：**只读**（app 开着可跑）；`--repo <dir>` 复现"无 peer 声明的 linked 包"；**耦合 harness 内部结构，大版本升级后可能失效**。
5. 仍然不明 → 按 `references/evidence-recipes.md` 做最小复现，**别猜**。

## 定性原则

- **同一套判定要跑在可比的两组对象上**。要断言"是 A 导致的"，至少要有一组"除了 A 之外都一样"的对照（例：本插件字段 vs 官方同形态字段；真实路径 import vs profile 内副本 import）。
- **自己写的探针先自证**：让它对已知正确 / 已知错误的两组输入给出相反结果。本次实践中就出现过探针把 globals 符号与模块局部符号混用而**伪造出根因**的教训——符号判定必须取自被测对象自身（`Object.getOwnPropertySymbols`），不要用 `Symbol.for` 猜。
- **区分"Host 侧正确"与"UI 呈现"**。`settings.describe()` 投影正常 ≠ 页面上有表单：表单还依赖客户端组件注册 keyed slot。
- 失败模式与对应修法见 [`references/failure-patterns.md`](references/failure-patterns.md)。

## 修复后的自证

- [ ] 静态契约检查通过，且对「删掉 peer 声明的副本」会失败（护栏自证）
- [ ] 解析诊断 `--expect ok` 全 OK；`--repo <无 peer 的夹具>` 时 `--expect fail` 命中
- [ ] apply 级冒烟：假 ctx 调 `apply()`，确认注册的工具数、prompt section 数、各写入路径返回值（`defineTool` 会在这一步暴露选项形状不匹配）
- [ ] 真实宿主端到端：重启/重载后，新会话工具齐备、插件页无 skip、配置路径可写

> 最后一项若需要 GUI 点击或重启正在使用的宿主，**先与仓库所有者沟通由谁执行**，拿到结果再作为验收证据；不要跳过、也不要用话术替代。流程与对外发言要求见 `dsh-plugin-workflow`。

## 领域陷阱

- **沙箱伪故障**：受限沙箱里跑 DSH CLI 会出现 `EPERM ... package.json.lock` 或删除 `.dsh-module-fallback` 失败，这不是插件 bug；换到工作区内或用真实 app 复核。
- **Node ESM 会 realpath**：`--preserve-symlinks` 只影响 CJS；ESM 下符号链接路径永远变成真实路径——这正是 linked root 的判定依据。
- **junction ≠ symlink（在 Node 下）**：`lstat().isSymbolicLink()` 对 junction 为 false、`readlink` 报 `EINVAL`，所以 junction 安装会被当成「profile 内副本」，不能用来复现 linked root。
- **旧 `.dsh-module-fallback` 残留**：0.2 启动时会尝试删除；删不掉会 boot 失败，需先排除占用再手工清理。
