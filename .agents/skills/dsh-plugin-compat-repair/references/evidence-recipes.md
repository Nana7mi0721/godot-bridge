# 取证配方（不惊动运行中的 app）

目标：用**安装版 harness 自己的代码**复现失败，而不是读源码猜。

## 0. 关键事实

安装的 harness 代码在 `app.asar` 里，**只有 DSH 的 Electron 可执行文件能读**。把它当 node 用：

```powershell
$exe = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe"
$env:ELECTRON_RUN_AS_NODE = '1'
& $exe -e "console.log(process.version, process.versions.electron)"
```

非 Windows / 自定义安装位置：`--dsh-app` 传真实 exe 路径。

## 1. 封装好的诊断（优先用）

```sh
node scripts/diagnose-dsh-resolution.mjs --profile <profile> [--expect ok|fail] [--repo <dir>] [--json]
```

它会（在非 Electron 环境下自动用 app 重新执行自己）：

1. 用安装版 app-boot 载入 profile：`loadProfileDirectory('dsh', profileDir, installAnchor, {})` → 打印 `layers` 与 `skippedBundles`（后者的 `reason` 就是 launcher 打印的那句话）；
2. 计算并装同一份 runtime resolution：`createRuntimeResolution({ installAnchor, profile, home })` → 打印 `linkedRoots`（`link:` 安装会出现在这里）；
3. 在 Worker 里 `import(<插件入口>)`，用 app-boot 的 worker bootstrap 安装解析拦截。

**必须用 asar 里的 bootstrap**：解包出来的副本找不到 `node-addon-require-builtin`。

## 2. 手工最小复现（诊断脚本不够用时）

```js
// parent：装解析 → 在 worker 里 import 目标
import { setEnvironmentData, Worker } from 'node:worker_threads'
const KEY = '@deepseek-ai/dsh-app-boot/profile-resolution'

const appBoot = await import(pathToFileURL(`${ASAR}/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`).href)
const profile = appBoot.loadProfileDirectory('dsh', profileDir, installAnchor, {})
const resolution = await appBoot.createRuntimeResolution({ installAnchor, profile, home })
setEnvironmentData(KEY, { resolution })

new Worker(workerUrl, { workerData: {
  bootstrapUrl: pathToFileURL(`${ASAR}/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/worker/profile-resolution-bootstrap.js`).href,
  targets: [pluginEntryUrl],
}})
```

```js
// worker：先装拦截，再 import
await import(workerData.bootstrapUrl)
for (const target of workerData.targets) { /* import + 回报 ok/失败原因 */ }
```

**对照实验是决定性的一步**，同一份 resolution、同一个 worker：

- 从插件**真实路径**导入 → 复现 FAIL；
- 把插件文件 copy 进 `<profile>/node_modules/<pkg>/`（真实目录，**不要用 junction**）再导入 → OK。

两者差异锁定在「linked root + peer 声明」上，与包是否安装、版本是否兼容无关。

## 3. 读 harness 内部实现

写个 asar 解析器（读文件头 pickle + header JSON，按 offset 取文件），或用 Electron 直接 import 内部模块：

```powershell
& $exe -e "import('file:///…/app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js').then(m=>console.log(Object.keys(m)))"
```

注意：Electron 的 `-e` 走 CJS，`await` 需要包在 async IIFE 里或写成 `.mjs` 文件执行。

## 4. apply 级冒烟（不启动真游戏/真宿主）

用假 ctx 调真实 `apply()`：

```js
const ctx = {
  subprocess: { resolveExecutable: async () => null },
  timer: { timeout: async () => {} },
  tools: { register: (def) => { registered.set(def.name, def); return () => {} } },
  fs: {}, sandboxPolicy: {},
  systemPrompt: { section: (s) => { sections.push(s.name); return () => {} } },
  logger: { warn() {}, info() {}, error() {} },
  effect: (factory) => { const d = factory(); return () => typeof d === 'function' && d() },
  inject: (names, cb) => { cb(servicesFor(names)); return () => {} },
  fiber: { state: 2, entry: { options: { id: '...', config: {} }, fiber: { state: 2 } } },
  timeout: async () => {},
}
await mod.apply(ctx, config)
```

断言：注册的工具数量、`systemPrompt.section` 数量、各写入路径的返回值、错误路径的提示文案。
`defineTool` 的选项形状不匹配会在这步直接抛错——比在真宿主里试快得多。

## 5. 注意

- 探针里不要把函数对象 `postMessage` 出去（`DataCloneError`）；先 JSON 序列化并替换函数。
- 判定符号/引用身份时，**从被测对象自身取符号**（`Object.getOwnPropertySymbols`），不要用 `Symbol.for` 猜——否则会伪造出根因。
- 临时探针放 `.investigate/`（已 gitignore），任务结束即删。
- 输出贴进 issue/PR 前脱敏（remote URL、token、配置里的凭据）。
