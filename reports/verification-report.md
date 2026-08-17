# 测试与端到端验证报告

> 对应 tasks.md 任务组 10（spec 第 4 章 DFX 验收）

## 10.1 核心单元测试与覆盖率 — 已通过

- 测试规模：34 个测试文件 / 193 个用例，全部绿色（`npx vitest run`）
- 覆盖率（`npx vitest run --coverage`，行覆盖）：

| 模块 | 行覆盖 |
|---|---|
| 全仓 | 88.78% |
| quality（含 de-ai 七项检查） | 93.77% |
| memory（跨章记忆矩阵） | 97.37% |
| model（模型接入层） | 85.19% |
| pipeline（scheduler） | 83.63% |
| project | 95.92% |
| storage | 93.00% |

核心模块（quality/pipeline/model/memory）行覆盖均 ≥ 80%，满足验收条件。

## 10.2 Mock 集成测试：全流程闭环 — 已通过

- `test/pipeline/scheduler.integration.test.ts`：规划门控 → 章纲 → 审查 → 写作 → 审查 → 终稿 → 状态转 completed
- 故障注入用例：指定章评分恒低 → 审查超限隔离、其余章正常完成（spec 5.6.1 规则 3 验收）
- 审查服务不可用 → 初稿保持待审查、绝不自动转终稿（spec 5.3.1 规则 9 验收）
- 产物目录完整性、总结报告与落盘统计一致性在 `test/app/app-smoke.test.ts` 冒烟验证

## 10.3 断点续传与容错 — 已通过

- `test/pipeline/resume.integration.test.ts`：
  - 第 1 章终稿后 abort → 重启 → 2、3 章续传完成，第 1 章零重复生成（writer 调用计数=1）
  - 模拟崩溃后无 `.tmp` 半成品残留（原子写保证）
- `test/project/service.test.ts`：同项目双实例并发启动第二实例被拒（ALREADY_RUNNING）；陈旧锁（死 PID）自动覆盖
- 损坏产物文件按"不存在"语义处理并在 `test/storage/atomic.test.ts`、`test/pipeline/resume.test.ts` 覆盖

## 10.4 真实模型小规模端到端 — 待真实凭据执行

本环境无 DeepSeek/GLM 真实凭据。执行步骤：

1. 准备凭据：`novel.admin.provider`（providerId=deepseek，kind=openai-compat，baseURL=https://api.deepseek.com/v1，apiKey=sk-xxx）；再注册 GLM 按量通道（baseURL=https://open.bigmodel.cn/api/paas/v4）
2. 创建 3~5 章项目并启动，验证：
   - 角色路由：writer 绑 GLM、reviewer 绑 DeepSeek 时 `logs/raw_responses/` 中两类请求 baseURL 可区分
   - 审查独立性：审查请求落盘内容不含写作模型标识
   - 原始响应留存：每次调用有 `{时间戳}_{角色}_{章号}.json` 且请求已脱敏

## 10.5 多模型降级与 Coding Plan 双通道 — 待真实凭据执行

- 降级链验证：为主模型配置错误凭据（触发连续 401）→ 自动切换备选模型并收到 `model.fallback` 通知事件
- GLM Coding Plan：分别注册 glm-plan-cn（https://open.bigmodel.cn/api/coding/paas/v4 + 国内版 token）与 glm-plan-intl（https://api.z.ai/api/coding/paas/v4 + 国际版 token）；端点-版本不匹配已在单测拦截（ENDPOINT_TOKEN_MISMATCH）
- 限额等待：订阅额度耗尽 → 通道进入 limit-wait（进度页可见"限额等待"）→ 窗口结束自动恢复（单测已覆盖状态机全路径）

## 10.6 性能与 DFX 终验 — 待真实环境执行

- 限流红线：单测已验证 4 并发 acquire 满足 QPS 间隔（test/model/rate-limiter.test.ts）；真实环境用 2 项目 × 2 worker 打同一服务商观察无 429
- 端到端吞吐：30 章 × 2500 字目标 ≤ 6 小时；建议按"3 章实测耗时 × 10 + 重写余量 30%"折算验证
- 通知脱敏：单测已验证 webhook payload 不含凭据/原始响应（test/notify/progress-webhook.test.ts）

## 已知限制

1. `src/host/dsh-adapter.ts` 以结构化接口（DshHostRuntime）适配底座；真实 deepseek-harness 底座装载时需按其实际 API 在该单点文件内适配（design 2.1.2 降耦保障）
2. cordis 版本锁定 3.x（npm 上无 6.x）
3. Windows 下并发原子写通过 rename 重试兜底（src/storage/atomic.ts）