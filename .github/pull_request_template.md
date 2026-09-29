<!--
PR 说明模板 / pull-request template.
填满「现象 / 根因 / 证据 / 验证」四节再请求评审：这是本仓库修 DSH 兼容性问题时最容易漏掉证据的地方。
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

- [ ] `npm run check` 通过（且对「故意去掉 peer 声明的副本」会失败）
- [ ] `node scripts/diagnose-dsh-resolution.mjs --profile <profile> --expect ok` 全 OK
- [ ] 重启 DSH（或插件页重载 profile）后，新会话出现预期的 `godot_*` 工具
- [ ] 插件设置页出现/仍显示 `Godot engine path`
- [ ] `godot_set_engine_path` 写入生效（返回 `persisted: 'profile-patch'`，无需重启）
- [ ] README / install / ARCHITECTURE / CHANGELOG 中英双份同步更新
- [ ] `version` 已递增（插件启动时的更新提示以此为发布标记）
- [ ] 工作区无未跟踪残留（`.investigate/`、临时夹具已删除）

## 风险与兼容性 / Risk and compatibility

<!-- 声明面是否最小（只声明被 import 的包）？peer 版本范围是否会误伤旧/新运行时？是否需要用户手工动作（重载 profile、重填引擎路径）？ -->

## 下线计划 / Deprecation

<!-- 本次若保留旧运行时兜底路径，写清触发下线条件与关联 Issue（例如 Ref #N），否则填「无」。 -->

Refs #
