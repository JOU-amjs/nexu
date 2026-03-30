---
id: 20260330-credit-storage
name: Credit Storage
status: researched
created: '2026-03-30'
---

## Overview

现在希望为 nexu 设计积分方案。nexu 目前是无限量使用，只有每周和每 5 小时的限额。后续会改成积分方案，有利于商业化。

商业化背景方案参考 pricing.pdf

积分方案会涉及到云端的 nexu-cloud 和 nexu-link 仓库。相关仓库的作用见 /Users/william/projects/nexu-stack/AGENTS.md

积分方案的第一步是设计积分持久化方案，先聚焦一下数据怎么存，确定之后就可以分工搞了。基本的原则是：写入在 cloud 做，读取在 link 做。

## Research

### 现有系统

- **nexu 当前接入方式是桌面端本地控制器拉取云端身份与模型信息**：控制器通过 cloud profile 选择 `cloudUrl` / `linkUrl`，走 device auth 拿到 API key，再从 `linkUrl/v1/models` 拉模型列表，并把结果持久化到本地 `desktop.cloud` / `desktop.cloudSessions`。关键位置：`apps/controller/src/store/nexu-config-store.ts:70`、`apps/controller/src/routes/desktop-compat-routes.ts:40`、`apps/controller/src/lib/openclaw-config-compiler.ts:273`。
- **nexu 运行时对 link 的使用方式是“读模型目录 + 带 Bearer key 走 OpenAI 兼容接口”**：编译器把 cloud session 注入为 `providers.link`，模型 ID 解析时只在 cloud models 中存在时才回退到 `link/...`。关键位置：`apps/controller/src/lib/openclaw-config-compiler.ts:277`、`apps/controller/src/lib/openclaw-config-compiler.ts:353`。
- **nexu 当前没有真正的积分/余额持久化实现**：现有显式限额只有 `/api/v1/bot-quota`，实现是固定返回 `available: true` 和 `now + 24h`，未落库。关键位置：`apps/controller/src/routes/channel-routes.ts:283`、`apps/controller/src/services/channel-service.ts:664`。
- **nexu 本地持久化模式当前以 JSON 文件为主**：`config.json` 保存控制器配置，`cloud-profiles.json` 保存 cloud profiles，`skill-ledger.json` 和 `analytics-state.json` 也都走原子 JSON 写入。关键位置：`apps/controller/src/app/env.ts:82`、`apps/controller/src/store/lowdb-store.ts:36`、`apps/controller/src/services/skillhub/skill-db.ts:43`。
- **nexu-cloud 当前职责偏身份与 API key 生命周期**：Better Auth 管登录态；桌面授权流分为 device-register、desktop-authorize、device-poll 三步；授权成功后生成 `nxk_...` API key，写入 `api_keys`，并把明文 key 加密暂存到 `device_authorizations` 供轮询取回。关键位置：`/Users/william/projects/nexu-stack/nexu-cloud/apps/api/src/routes/desktop-auth-routes.ts:19`、`:182`、`/Users/william/projects/nexu-stack/nexu-cloud/apps/api/src/db/schema/index.ts:109`。
- **nexu-cloud 当前数据表仍以 auth / user / api key 为主**：基线 migration 只有 `user`、`session`、`account`、`verification`、`users`、`api_keys`、`device_authorizations`，未发现 credit / billing / quota 表。关键位置：`/Users/william/projects/nexu-stack/nexu-cloud/apps/api/migrations/0000_baseline.sql:1`。
- **nexu-link 当前职责偏网关鉴权、限额执行、使用记录**：所有 `/v1/*` 都先过 API key 鉴权，中间件在请求进入 handler 前检查 usage limit；请求结束后把 usage event 写入 `link.usage_events`。关键位置：`/Users/william/projects/nexu-stack/nexu-link/internal/server/server.go:274`、`/Users/william/projects/nexu-stack/nexu-link/internal/middleware/auth.go:27`、`/Users/william/projects/nexu-stack/nexu-link/internal/usage/usage.go:48`。
- **nexu-link 当前的“额度”是 USD 窗口计数，不是积分余额**：配置从共享表 `public.api_key_usage_limits` 读取；消耗累计写入 `link.usage_limit_counters`；超限时返回 `429 usage_limit_exceeded`。关键位置：`/Users/william/projects/nexu-stack/nexu-link/internal/repositories/postgres.go:106`、`:339`、`/Users/william/projects/nexu-stack/nexu-link/internal/usage/limits.go:101`。
- **Refly 的积分方案是双账本模式：充值账本 + 消耗账本 + 欠款账本**：`credit_recharges` 记录每笔入账及剩余余额，`credit_usages` 记录每次扣费，`credit_debts` 记录透支；余额查询时会用可用 recharge 减去 active debt。关键位置：`/Users/william/projects/refly/apps/api/prisma/schema.prisma:1328`、`:1364`、`:1390`、`/Users/william/projects/refly/apps/api/src/modules/credit/credit.service.ts:1314`。
- **Refly 的扣费顺序是按即将过期的 recharge 先扣，余额不足则生成 debt**：扣费时先查询 `enabled && expiresAt >= now && balance > 0` 的 recharge，按 `expiresAt asc` 扣减；若剩余未扣完，则新增 `credit_debts`。关键位置：`/Users/william/projects/refly/apps/api/src/modules/credit/credit.service.ts:762`。
- **Refly 的价格配置与余额账本分离**：模型类价格由 `provider_items.credit_billing` 提供，工具类价格由 `tool_billing` 提供；最终扣费都汇总到 `credit_usages`。关键位置：`/Users/william/projects/refly/apps/api/prisma/schema.prisma:1390`、`/Users/william/projects/refly/apps/api/src/modules/skill/skill-invoker.service.ts:2131`、`/Users/william/projects/refly/apps/api/src/modules/tool/billing/billing.service.ts:114`。
- **Refly 生产库验证了该方案已在真实业务中运行**：生产库 `refly` schema 下存在 `credit_recharges`、`credit_usages`、`credit_debts`、`subscriptions`、`subscription_plans`、`credit_pack_plans`、`provider_items`、`tool_billing`、`token_usage_meters`。其中行数约为：`credit_recharges=106248`、`credit_usages=617586`、`credit_debts=4186`、`subscriptions=904`、`subscription_plans=13`、`credit_pack_plans=4`、`tool_billing=18`、`provider_items=269077`、`token_usage_meters=99818`。
- **Refly 生产库样本验证了多来源充值 + 欠款并存**：`credit_recharges.source` 真实出现 `gift`、`invitation`、`commission`，同一用户可同时存在多笔 recharge 且 `balance` 不同；`credit_debts.source` 真实出现 `usage_overdraft`。
- **Refly 生产库样本验证了 usage 表承载实际扣费流水**：`credit_usages` 中同时存在 `model_call` 与 `tool_call`，`amount` 与 `due_amount` 一并保存，`tool_call` 记录带 `tool_call_id`。
- **Refly 生产库样本验证了订阅配额与积分配额并行存在**：`subscription_plans` 同时保存 `credit_quota`、`daily_gift_credit_quota`、`t1/t2 count quota`、`t1/t2 token quota`，说明积分额度与请求/Token 配额在同一订阅计划里并行管理。
- **Refly 生产库样本验证了模型价格配置粒度**：`provider_items.credit_billing` 中同时存在 `1m_tokens` 与 `5k_tokens` 两种计费单位，并包含 `inputCost` / `outputCost` / `minCharge` / `isEarlyBirdFree` 等字段。
- **Refly 生产库样本验证了工具价格配置粒度**：`tool_billing.billing_rules` 已覆盖 audio / image / video 等不同媒介，按 `inventory_key + method_name` 存储规则，`billing_rules` 与可选 `token_pricing` 分开保存。

### 可用技术路径

- **路径 A：在 nexu-cloud 的共享身份侧落积分主账本，在 nexu-link 只做读取与消费记录**。这与当前 `public.api_keys` / `public.api_key_usage_limits` 由共享 schema 提供、`nexu-link` 负责读取和执行的模式一致。
- **路径 B：在 nexu-cloud 增加“余额/充值/债务”类账本表，在 nexu-link 增加“消费事件/聚合计数”类表**。这与 Refly 的 `credit_recharges` / `credit_usages` / `credit_debts` 分账方式，以及 nexu-link 现有 `usage_events` / `usage_limit_counters` 读写分层相似。
- **路径 C：保留 nexu-link 现有 USD 窗口限额能力，同时新增积分账本作为独立准入维度**。现有 `usage_limit_counters` 与 `usage_events` 可以继续记录成本与窗口消耗，积分账本只负责余额语义。
- **路径 D：把积分余额做成共享 schema 数据，把网关运行态统计继续保留在 `link.*`**。这与父级文档描述的“shared/default schema 存身份与共享配置、`link` schema 存网关运行数据”一致。关键位置：`/Users/william/projects/nexu-stack/AGENTS.md:54`。

### 约束与依赖

- **既定原则是“写入在 cloud 做，读取在 link 做”**，这是当前 spec 已给出的边界。`specs/change/20260330-credit-storage/spec.md:16`
- **nexu-cloud 与 nexu-link 被视为同一个逻辑 Postgres、不同 schema 的协作系统**，共享身份/配置类数据放 `public`，网关运行数据放 `link`。`/Users/william/projects/nexu-stack/AGENTS.md:54`
- **nexu-link 仓库明确不拥有 shared `public` schema 的 migration**；如果需要新增共享表，应视为 shared-schema 决策，而不是直接放进 link repo migration。`/Users/william/projects/nexu-stack/nexu-link/AGENTS.md:29`
- **nexu-cloud 当前 API key 表已经是 link 鉴权的数据源**，因此积分若与 key / user 绑定，link 侧已有读取共享表的既有模式。`/Users/william/projects/nexu-stack/nexu-cloud/apps/api/src/db/schema/index.ts:109`、`/Users/william/projects/nexu-stack/nexu-link/internal/repositories/postgres.go:43`
- **nexu 当前前端/控制器还没有积分 API 契约**，共享 schema 中与额度相关的公开响应只有 `botQuotaResponseSchema`。`packages/shared/src/schemas/channel.ts:124`
- **Refly 测试库有积分相关表结构，但样本业务数据接近空**：`credit_recharges` / `credit_usages` / `credit_debts` / `subscriptions` / `subscription_plans` 在测试库均为 0 行，仅 `tool_billing` 和单条 `provider_items.credit_billing` 可作为配置样本参考；本地库也未提供可用样本数据。
- **Refly 生产库只在 `refly` schema 下发现积分相关业务表**，未在 `public` schema 下发现对应表；这说明其生产环境业务数据主要收敛在业务 schema，而不是 `public`。
- **Refly 的账本支持过期余额、来源区分、透支补扣**：`credit_recharges` 有 `source`、`balance`、`expiresAt`，`credit_debts` 单独记录欠款，后续充值先还债。`/Users/william/projects/refly/apps/api/prisma/schema.prisma:1335`、`:1371`、`/Users/william/projects/refly/apps/api/src/modules/credit/credit.service.ts:52`

### 关键参考

- `apps/controller/src/store/nexu-config-store.ts:70` - nexu 默认 cloud/link profile 与本地 cloud session 持久化入口。
- `apps/controller/src/lib/openclaw-config-compiler.ts:277` - nexu 将 cloud session 编译成 `providers.link`。
- `apps/controller/src/services/channel-service.ts:664` - nexu 当前 bot quota 仅为 stub。
- `apps/controller/src/store/lowdb-store.ts:36` - nexu JSON 文件原子写入模式。
- `/Users/william/projects/nexu-stack/nexu-cloud/apps/api/src/routes/desktop-auth-routes.ts:19` - nexu-cloud device auth register/poll/authorize 流程。
- `/Users/william/projects/nexu-stack/nexu-cloud/apps/api/src/db/schema/index.ts:109` - nexu-cloud `api_keys` 表定义。
- `/Users/william/projects/nexu-stack/nexu-cloud/apps/api/migrations/0000_baseline.sql:1` - nexu-cloud 当前基线表结构。
- `/Users/william/projects/nexu-stack/nexu-link/internal/middleware/auth.go:56` - nexu-link 请求前 usage limit 检查。
- `/Users/william/projects/nexu-stack/nexu-link/internal/repositories/postgres.go:106` - nexu-link 从 `public.api_key_usage_limits` 读取共享限额配置。
- `/Users/william/projects/nexu-stack/nexu-link/internal/repositories/postgres.go:227` - nexu-link 记录 `link.usage_events`。
- `/Users/william/projects/nexu-stack/nexu-link/migrations/004_usage_limit_counters.up.sql:1` - nexu-link 的窗口计数表。
- `/Users/william/projects/refly/apps/api/prisma/schema.prisma:1328` - Refly `credit_recharges` 账本定义。
- `/Users/william/projects/refly/apps/api/prisma/schema.prisma:1364` - Refly `credit_debts` 欠款表定义。
- `/Users/william/projects/refly/apps/api/prisma/schema.prisma:1390` - Refly `credit_usages` 消耗表定义。
- `/Users/william/projects/refly/apps/api/src/modules/credit/credit.service.ts:762` - Refly 扣费与透支处理。
- `/Users/william/projects/refly/apps/api/src/modules/credit/credit.service.ts:1314` - Refly 余额聚合逻辑。
- `/Users/william/projects/refly/apps/api/src/modules/tool/billing/billing.service.ts:114` - Refly 工具计费配置加载。
- `/Users/william/projects/refly/apps/api/src/modules/skill/skill-invoker.service.ts:2131` - Refly 模型计费配置映射到批量积分扣费。

## Design

<!-- Technical approach, architecture decisions -->

## Plan

<!-- Break down implementation and verification into steps -->

- [ ] Phase 1: Implement the first part of the feature
  - [ ] Task 1
  - [ ] Task 2
  - [ ] Task 3
- [ ] Phase 2: Implement the second part of the feature
  - [ ] Task 1
  - [ ] Task 2
  - [ ] Task 3
- [ ] Phase 3: Test and verify
  - [ ] Test criteria 1
  - [ ] Test criteria 2

## Notes

<!-- Optional: Alternatives considered, open questions, etc. -->
