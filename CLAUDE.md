# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

多模型长篇小说生成插件（`novel-harness`），以 [cordis](https://cordis.js.org/) 插件形式接入 dsh 宿主底座。TypeScript + ESM（NodeNext），Node >= 20，zod 做配置校验。代码注释、日志与用户可见文案均为中文。

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
```

无 lint 配置，类型检查即质量底线；提交前应保证 `typecheck` 与 `test` 通过。

## 架构

### 组合根与入口

- `src/index.ts`：cordis 插件入口（`apply`），根据配置选择 `DshHostAdapter` 或 `FakeHost`，实例化 `NovelHarnessApp` 挂到 `ctx.novelApp`。
- `src/app.ts`：`NovelHarnessApp` 是组合根，装配全部服务，并通过 `executeCommand('novel.*')` 分发命令（命令清单须与 `plugin-manifest.json` 保持同步）。
- `src/host/types.ts`：`HostProvider` 接口是插件与宿主底座的唯一边界——凭据（加密存储）、事件发布、UI 面板注册、数据根目录。`src/host/dsh-adapter.ts` 提供 `DshHostAdapter`（真实底座）与 `FakeHost`（测试用内存/文件实现）。

**凭据红线：本插件绝不落盘明文 API Key/订阅 token，一律经 `host.credentials.put()` 写入底座加密体系。**

### 各层职责

- **model/**（模型接入）：`ModelGateway` 统一调用入口，按流水线角色（planner/outliner/outline-reviewer/writer/reviewer/archivist，见 `project/schema.ts` 的 `PipelineRole`）绑定主模型+降级链（`ModelBinding`）；`ProviderRegistry` 管理 provider（openai-compat、glm-plan-cn/intl）；`ChannelManager` 做通道级降级与限额冷却；`GlobalRateLimiter` 做 QPS 限流。
- **project/**（项目管理）：zod schema 定义 `ProjectConfig`；`ProjectService` 负责创建/启停；`state-machine.ts` 状态机（pending→planning→generating→paused/completed/aborted），非法迁移抛 `InvalidStateError`；`migrate-node-config.ts` 兼容旧配置迁移。
- **pipeline/**（生成流水线）：`PipelineScheduler` 是核心编排器——断点续传（`ResumeScanner`/`ProgressMatrix`）、章节隔离账本（`IsolationLedger`）、并发槽位（`ChapterSlotManager`/worker-pool）、提示词构建与评审反馈压缩。阶段实现于 `pipeline/stages/`，均继承 `Stage` 基类（统一计时与日志）。
- **quality/**（质量门）：`checkDraft` = 结构化检查（structured-checker）+ 去AI味检查（de-ai/ 下 6 个子模块：连词、行话、标点、反问句式、修辞模式、句子节奏）。**严重 AI 味命中或结构化失败 → 直接重写（directRewrite），不走定向修改**。风格包从 `style-packs/<id>/pack.json` 加载（内置 generic、gulong）。
- **memory/**（记忆矩阵）：`MatrixStore` 持久化人物状态/伏笔/意象/悬念/主题；`extractor` 从终稿提取；`injection-builder` 构建注入提示词的摘要；`archivist` 用 LLM 做时空信息归档；`rules` 计算一致性信号。
- **guidance/**（人工指导）：`GuidanceService` 仅允许在 paused/completed 态附加意见；`RegenOrchestrator` 按意见重生成章节（终稿先备份，失败自动回滚 `.regen-backup.txt`）。
- **notify/**（通知输出）：领域事件流（`DomainEvent`）、两级进度视图、Webhook 通知。
- **output/**：终稿合并编译与交付包导出。
- **storage/**：`layout.ts` 的 `projectPaths()` 定义每个项目的目录结构（唯一权威来源）；`atomic.ts` 提供临时文件+rename 的原子写；`audit.ts` 审计日志。

### 数据布局

数据根目录来自 `host.storage.dataRoot()`，项目数据在 `novels/<projectId>/` 下：`project.json`、`premise.txt`、世界观/人物/地点 JSON、`chapters/{outline,outlineReview,draft,review,final}`、`memory/`（matrix+快照）、`guidance/`、`state/`（锁、进度、隔离、通道）、`logs/`。所有落盘必须走 `storage/atomic.ts`，路径必须来自 `projectPaths()`。

## 约定

- **ESM 导入必须带 `.js` 后缀**（NodeNext 解析），如 `import { x } from './app.js'`。
- 测试位于 `test/`，目录结构与 `src/` 镜像；宿主用 `FakeHost`（配 `mkdtemp` 临时目录），网络用注入的 `fetchImpl` / `gateway`，不发真实请求。
- `test/` 不参与编译（tsconfig exclude），类型检查只覆盖 `src/`。
- 新增命令时同步改三处：`src/app.ts` 的 `commands()`/`executeCommand()`、`plugin-manifest.json`、相应测试。
- 提交信息用中文，格式如 `feat: 描述`。
