# 取证配方（不惊动运行中的 app）

目标：用**安装版 harness 自己的代码**复现失败，而不是读源码猜。

## 仓库自带的两个工具：何时用

两者都**不进发布包**（`files` 白名单只有 `plugin/` 与 CHANGELOG），属开发期工具。

`scripts/check-plugin-contract.mjs` —— 静态契约检查：

- **何时**：改了 `package.json`（`peerDependencies` / `files` / `main` / `exports` / `dsh.bundle`）、在 `plugin/` 里加了新的裸 `@deepseek-ai/*` import、提 PR 前、发版前。不需要 DSH，可进 CI。
- **怎么用**：`npm run check`；`node scripts/check-plugin-contract.mjs --root <dir>` 校验别的目录。
- **查什么**：裸 import 是否都已声明；`dsh.bundle.patch` 是否存在、被 `files` 覆盖、引用本包名；`main`/`exports` 目标是否存在且被 `files` 覆盖；入口是否有 `name`/`apply` 且无 `export default`。
- **护栏自证**：对"故意去掉 peer 声明的夹具"跑一次，必须 exit 1。不失败说明检查失效了——这是最容易静默发生的事，务必每次改动此脚本后重跑。
- **覆盖范围**：按语句扫描（不是按行），因此单行/多行 `import ... from`、副作用 `import 'x'`、`export ... from`、动态 `import('x')` 都能识别；注释里的包名会被剔除，不会误报。改这个脚本后，用一节含上述各写法的夹具自测一次（期望全部命中），并确认真仓库仍通过。

`scripts/diagnose-dsh-resolution.mjs` —— 真机解析诊断：

- **何时**：插件页报加载失败或工具整批消失；DSH 升级后巡检；排查 `link:` 与 profile 内安装的行为差异；**修复前后各跑一次做对照**。
- **怎么用**：
  ```sh
  node scripts/diagnose-dsh-resolution.mjs --profile <profile> --expect ok
  node scripts/diagnose-dsh-resolution.mjs --profile <profile> --repo <dir> --expect fail
  node scripts/diagnose-dsh-resolution.mjs --profile web --dsh-app "<exe>" --json
  ```
- **注意**：**只读**（不写 profile、不建符号链接，app 开着可跑）；`--expect` 不符时 exit 1，可作 CI 回归断言；**耦合 harness 未公开的内部结构，DSH 大版本升级后可能失效**——那时退回本文件的"手工最小复现"。
- **`--repo` 的能力边界（重要）**：它是**合成** linked root——直接把 `{name, realPath}` 注入解析表的 `linkedRoots`，**不经过 harness 真实的 `routeLinked` 祖先门禁**。因此它能稳定复现"未声明的 linked 包 import 失败"，但**不能**用来验证门禁本身（例如"声明了 peer 才会被路由"）。后者要按"手工最小复现"在真实布局下做。

  > 为什么这个区别要紧：`routeLinked`（`dsh-app-boot` 的 `lib/index.js` / worker bootstrap 同款）取的祖先集合是 `nodeModulePaths(dirname(parent))`，再读每个搜索路径**父目录**的 `package.json` 的 peer 键（L361-366）。所以夹具若放在一个已声明 peers 的包**内部**，门禁可能被祖先 manifest 满足，得到与预期相反的假结果。做真机对照时，把夹具放在**任何插件 manifest 之外**（例如系统临时目录），并核对祖先链上没有别的 manifest。

`scripts/lib/resolution-probe-worker.mjs` —— 上面诊断脚本的 worker 半边：**不需要手工调用**，没有独立入口；拆开是因为解析拦截必须装在真正执行 import 的线程里。唯一约束是 bootstrap 必须取自 `app.asar`。

**改完代码的标准收尾**：

```sh
npm run check \
  && node scripts/diagnose-dsh-resolution.mjs --profile desktop --expect ok \
  && node scripts/diagnose-dsh-resolution.mjs --profile web --expect ok
```

## 关键事实

安装的 harness 代码在 `app.asar` 里，**只有 DSH 的 Electron 可执行文件能读**。把它当 node 用：

```powershell
$exe = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe"
$env:ELECTRON_RUN_AS_NODE = '1'
& $exe -e "console.log(process.version, process.versions.electron)"
```

非 Windows / 自定义安装位置：给脚本传 `--dsh-app <真实 exe 路径>`。

## 诊断脚本内部做了什么

它会（在非 Electron 环境下自动用 app 重新执行自己）：

1. 用安装版 app-boot 载入 profile：`loadProfileDirectory('dsh', profileDir, installAnchor, {})` → 打印 `layers` 与 `skippedBundles`（后者的 `reason` 就是 launcher 打印的那句话）；
2. 计算并装同一份 runtime resolution：`createRuntimeResolution({ installAnchor, profile, home })` → 打印 `linkedRoots`（`link:` 安装会出现在这里）；
3. 在 Worker 里 `import(<插件入口>)`，用 app-boot 的 worker bootstrap 安装解析拦截。

**必须用 asar 里的 bootstrap**：解包出来的副本找不到 `node-addon-require-builtin`。

## 手工最小复现（诊断脚本不够用时）

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

## 读 harness 内部实现

写个 asar 解析器（读文件头 pickle + header JSON，按 offset 取文件），或用 Electron 直接 import 内部模块：

```powershell
& $exe -e "import('file:///…/app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js').then(m=>console.log(Object.keys(m)))"
```

注意：Electron 的 `-e` 走 CJS，`await` 需要包在 async IIFE 里或写成 `.mjs` 文件执行。

## apply 级冒烟（不启动真游戏/真宿主）

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

## 注意

- 探针里不要把函数对象 `postMessage` 出去（`DataCloneError`）；先 JSON 序列化并替换函数。
- 判定符号/引用身份时，**从被测对象自身取符号**（`Object.getOwnPropertySymbols`），不要用 `Symbol.for` 猜——否则会伪造出根因。
- 临时探针放 `.investigate/`（已 gitignore），任务结束即删。
- 输出贴进 issue/PR 前脱敏（remote URL、token、配置里的凭据）。
