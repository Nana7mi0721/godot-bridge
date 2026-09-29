<!--
PR 说明模板 / pull-request template.
填满「现象 / 根因 / 证据 / 验证」四节再请求评审：这是本仓库修 DSH 兼容性问题时最容易漏掉证据的地方。

身份要求：Issue/PR 上的发言者就是仓库所有者本人。通篇用维护者第一人称陈述（做了什么、证据是什么、限制是什么），
不要出现「请…」「需要维护者本机确认」「请把结果回帖」这类请求他人做事的句式——需要协调的步骤走对话，不进公开记录。
发布前搜一遍：请 / 你 / 帮我 / 需要维护者 / 本机确认。
-->

## 现象 / Symptom

<!-- 用户能看到什么：哪些工具消失、日志里哪一行报错、哪个 profile、什么安装方式（link: / tarball / github）。 -->

## 根因 / Root cause

<!-- 一句话结论 + 关键代码位置（例如 @deepseek-ai/dsh-app-boot 的 routeLinked/readPeerNames）。附上「为什么以前能用、现在不能」的机制差异。 -->

## 证据 / Evidence

<!-- 贴命令与真实输出（凭据、token、remote URL 请打码）：
     - npm run check
     - node scripts/diagnose-dsh-resolution.mjs --profile <profile> --expect ok|fail
     - 必要的对照实验（改前 FAIL / 改后 OK） -->

## 修复 / Fix

<!-- 改了什么、为什么这样改，以及是否保留了旧运行时兼容（0.1.6+ 双栈）和下线的边界。 -->

## 验证 / Verification

<!-- 只列作者能自己完成的验证。无法在本 PR 内完成的项不要留成未勾选的待办：
     要么补做，要么在「风险与兼容性」里写清「未执行 + 原因」，作为已说明的限制。 -->

- [ ] `npm run check` 通过（且对「故意去掉 peer 声明的副本」会失败）
- [ ] `node scripts/diagnose-dsh-resolution.mjs --profile <profile> --expect ok` 全 OK
- [ ] 反向用例命中：`--repo <无 peer 的夹具> --expect fail`
- [ ] apply 级冒烟：工具数量、systemPrompt section 数、两条写入路径的返回值
- [ ] README / install / ARCHITECTURE / CHANGELOG 中英双份同步更新
- [ ] `version` 已递增（插件启动时的更新提示以此为发布标记）
- [ ] 工作区无未跟踪残留（`.investigate/`、临时夹具已删除）

## 生效条件 / Activation

<!-- 这次改动何时生效：重载 profile / 重启宿主 / 需要重新 add / 用户需迁移什么。
     这是中性的运维事实，不是待办；不要把主语写成「维护者」「某人」，也不要用未勾选表示。 -->

## 风险与兼容性 / Risk and compatibility

<!-- 声明面是否最小（只声明被 import 的包）？peer 版本范围是否会误伤旧/新运行时？
     是否有未在本 PR 内执行的验证（例如需要重启宿主的端到端确认）——写清项与原因。 -->

## 下线计划 / Deprecation

<!-- 本次若保留旧运行时兜底路径，写清触发下线条件与关联 Issue（例如 Ref #N），否则填「无」。 -->

Refs #
