# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

多模型长篇小说生成 harness 插件（`novel-harness`），以 cordis 插件形式挂载于 **deepseek-harness（dsh）** 底座。TypeScript + ESM（NodeNext），Node ≥ 22.19，zod 做配置校验。代码注释、日志与用户可见文案均为中文。

规范文档（权威来源）：`.codeartsdoer/specs/multi_novel_harness/` 下 spec.md（需求）/ design.md（设计）/ tasks.md（任务分解）。上游 dsh 源码快照在 `dsh-upstream/`（gitignore，仅作 API 参考）。

## 常用命令

```bash
npm run build          # tsc 编译到 dist/（插件入口 dist/index.js）
npm run typecheck      # tsc --noEmit
npm test               # vitest run（全部测试）
npm run test:watch     # vitest 监听模式
npm run test:coverage  # 覆盖率

# 运行单个测试文件
npx vitest run test/memory/rules.test.ts
# 按用例名过滤
npx vitest run -t "用例名称片段"

# 服务商连通性探针（密钥仅经环境变量传入）
DEEPSEEK_API_KEY=... MINIMAX_API_KEY=... GLM_PLAN_TOKEN=... npx tsx scripts/probe-providers.mts

# 真实模型端到端（3 章全流程，tasks.md 10.4）
DEEPSEEK_API_KEY=... MINIMAX_API_KEY=... GLM_PLAN_TOKEN=... npx tsx scripts/e2e-real.mts
```

无 lint 配置，类型检查即质量底线；提交前应保证 `typecheck` 与 `test` 通过。

## 与 dsh 底座的集成（关键约束）

- **装载**：`dsh plugin --profile <name> add file:<本仓库路径>`；本包 `package.json` 声明 `dsh.bundle.patch`（指向 `cordis.patch.yml`），安装后自动进入组合层。**不修改底座核心代码**（spec 4.5.3）。
- **命令**：经 `ctx.commands.register` 注册（dsh 命令名只允许小写/数字/`-`/`_`，故 `novel.create` 注册为 `novel-create`）；handler 自行解析 `rawInput`（`--key value` 语法，见 `src/command-line.ts`），返回 `CommandResult({kind, text})`。命令行与 UI 走同一 `executeCommand` 服务层。
- **凭据**：POSIX 环境变量名式 `CredentialRef`（如 `NOVEL_GLM_PLAN_TOKEN_CN`），经 `ctx.credentials.set/resolve` 按次解析，永不缓存、永不落盘明文；服务商元数据索引落 `<dataRoot>/providers.json`。
- **数据根**：默认 `$DSH_HOME/novels`（`dshHomePath('novels')`），可由插件配置覆盖。
- **依赖**：`@deepseek-ai/cordis`（不是公共 npm 的 cordis）+ dsh-commands/dsh-credentials/dsh-home-paths，均声明为 peerDependencies。
- **无 UI 面板扩展点**：dsh web 为固定编译产物，不存在动态面板注册；进度呈现经 `novel-status` 命令与 webhook（spec 5.7）。

## 架构

### 组合根与入口

- `src/index.ts`：cordis 插件入口（`inject: ['commands', 'credentials']`）。`apply` 内将 `NovelHarnessApp` 包成 `NovelAppService` 挂到 `ctx.novelApp`（随 fiber 自动注销），并注册全部 `novel-*` 命令。含密钥入参的命令（`novel.admin.provider`）`recordInput: false`，防密钥入会话日志。
- `src/app.ts`：`NovelHarnessApp` 是组合根，装配全部服务；`executeCommand('novel.*')` 是命令分发共享入口（点号名为内部规范名）。
- `src/host/types.ts`：`HostProvider` 接口是插件与底座的唯一边界。
- `src/host/dsh-adapter.ts`：**全仓唯一允许 import 底座具体 API 的文件**（design 2.1.2 第 6 条）。`DshHostAdapter(ctx)` 对接真实底座；`FakeHost` 为内存实现（单测与离线开发）。

### 各层职责

- **model/**（模型接入）：`ModelGateway` 统一调用入口，按流水线角色（planner/outliner/outline-reviewer/writer/reviewer/archivist）绑定主模型+降级链；`ProviderRegistry` 管理服务商（openai-compat、glm-plan-cn/intl）与"接入方式↔端点↔凭据类型"三元匹配；`ChannelManager` 通道降级与限额冷却；`GlobalRateLimiter` 令牌桶。`openai-compat.ts` 的 `stripThink` 剥离推理模型内联 `<think>` 块（MiniMax-M3 实测必需）。
- **project/**：zod schema（`ProjectConfig`/`ProjectCreateInput`）、`ProjectService`（创建/启停/重生成票）、六态状态机（pending→planning→generating⇄paused→completed/aborted）。
- **pipeline/**：`PipelineScheduler` 主编排——断点续传（`ResumeScanner`）、隔离台账（`IsolationLedger`）、并发槽位（`ChapterSlotManager`）、章纲前瞻水位。阶段实现于 `stages/`，均继承 `Stage` 基类。
- **quality/**：`checkDraft` = 结构化检查 + 去AI味七项硬检查（de-ai/ 子模块）。严重命中 → 直接重写。风格包从 `style-packs/<id>/pack.json` 装载（generic、gulong）。
- **memory/**：`MatrixStore` 六类条目（伏笔/意象/悬念/主题/角色状态/时空）、`extractor` 章后提取、`injection-builder` 注入摘要、`archivist` LLM 兜底提取。
- **guidance/**：`GuidanceService`（暂停态附加意见）+ `RegenOrchestrator`（带终稿备份回滚的重生成）。
- **notify/**：领域事件（发布到 cordis 总线 `novel/event` + webhook 聚合推送）、两级进度视图。
- **output/**：终稿合并与交付包导出。
- **storage/**：`layout.ts` 的 `projectPaths()` 是目录结构唯一权威来源；`atomic.ts` 原子写；`audit.ts` JSONL 审计。

### 数据布局

数据根 `$DSH_HOME/novels`，项目在 `novels/<projectId>/` 下：`project.json`、`premise.txt`、世界观/人物/地点 JSON、`chapters/{outline,outlineReview,draft,review,final}`、`memory/`、`guidance/`、`state/`、`logs/`（含 `raw_responses/` 原始请求响应留存，请求快照不含明文凭据）。

## 约定

- **ESM 导入必须带 `.js` 后缀**（NodeNext 解析），如 `import { x } from './app.js'`。
- 测试位于 `test/`，目录结构与 `src/` 镜像；宿主用 `FakeHost`（配 `mkdtemp` 临时目录），网络用注入 `fetchImpl`/`gateway`，不发真实请求。`test/index.test.ts` 与 `test/host/dsh-adapter.test.ts` 使用**真实** cordis Context + dsh-commands/dsh-credentials 包做集成验证。
- 真实 API 密钥只经环境变量传入脚本（`scripts/probe-providers.mts`、`scripts/e2e-real.mts`），严禁写入任何文件/日志/提交。
- 新增命令需同步两处：`src/app.ts` 的 `commands()`/`executeCommand()`（点号规范名）、入口自动完成 `novel-*` 注册。
- 提交信息用中文，格式如 `feat: 描述`。
