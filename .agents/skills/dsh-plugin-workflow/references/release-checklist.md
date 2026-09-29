# 发版清单（DSH 插件仓库）

按顺序执行；每一步都要有可核对的输出，不靠"应该没问题"。

## 0. 前置

- [ ] 变更已合并到 `main`（或即将合并的分支），工作区干净：`git status --short` 为空
- [ ] 改动涉及的领域验收已完成（见对应领域技能），**没有未勾选的验收项**
- [ ] 若改了依赖契约：`npm run check` 通过，且对「故意破坏契约的夹具」会失败

## 1. 版本

- [ ] `package.json` 的 `version` 递增（语义化版本）
  - 插件启动时的更新提示以该字段为发布标记：**只有远端版本更高时**，已装用户才会看到提示
  - 修复 → patch；新增能力 → minor；破坏兼容 → major
- [ ] `repository.url` 正确（fork 会自动跟随它做版本检查）

## 2. CHANGELOG（双语，缺一不可）

- [ ] `CHANGELOG.md` 与 `CHANGELOG.zh-CN.md` 同批更新，内容等价
- [ ] 分类用 Keep a Changelog：`Fixed` / `Changed` / `Added` / `Removed` / `Deprecated` / `Known limitation` / `Documentation`
- [ ] 底部补版本对比链接：`[x.y.z]: https://github.com/<owner>/<repo>/compare/v<prev>...v<x.y.z>`
- [ ] 破坏性变更显式标注，并说明用户需要做什么（迁移步骤）

## 3. 文档

- [ ] README / install / ARCHITECTURE（双语）中受影响的段落已同步
- [ ] 涉及行为、配置位置、限制的表述**与实际一致**（不要承诺尚未实现的能力；未实现但重要的能力写进「已知限制」并开跟踪 issue）
- [ ] 工具/命令数量、路径、示例输出等硬事实核对过

## 4. 打包内容

- [ ] `package.json` 的 `files` 白名单只包含运行时需要的资产
- [ ] 新增目录（如 `client/`、`scripts/`、`.agents/`、`.github/`）**没有被误打包**，或已被有意加入
- [ ] 入口与导出（`main` / `exports`）指向的文件确实存在于包内

## 5. 提交与合并

- [ ] 提交按主题分组，`chore(release)` 类提交单独放版本号 + CHANGELOG
- [ ] PR 已转出 Draft，描述里的验收项全部勾选
- [ ] 合并到 `main`，本地同步：`git checkout main && git pull`

## 6. 发布（人执行）

- [ ] 打 tag：`git tag v<x.y.z> && git push origin v<x.y.z>`
- [ ] 按发布渠道执行：`npm publish` / `dsh plugin --profile <p> add github:<owner>/<repo>` / 市场平台提交
- [ ] 发布由人执行——agent 不自行 push tag 或发布

## 7. 发布后核对

- [ ] 插件页显示新版本号
- [ ] 新会话里工具/能力按预期出现
- [ ] 已装旧版的用户会看到更新提示（远端版本高于本地时才出现）
- [ ] 相关 issue 按约定关闭（`Closes #N` 已在 PR 描述中）

## 回滚

- 若发布后出现阻塞性问题：优先**发一个新的 patch 版本**回退行为，而不是重写历史
- 保留失败版本的 CHANGELOG 条目，补一条新条目标明回退内容
