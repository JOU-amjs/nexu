---
id: 20260330-credit-storage
name: Credit Storage
status: designed
created: '2026-03-30'
---

## Overview

现在希望为 nexu 设计积分方案。nexu 目前是无限量使用，只有每周和每 5 小时的限额。后续会改成积分方案，有利于商业化。

商业化背景方案参考 pricing.pdf

积分方案会涉及到云端的 nexu-cloud 和 nexu-link 仓库。相关仓库的作用见 /Users/william/projects/nexu-stack/AGENTS.md

积分方案的第一步是设计积分持久化方案，先聚焦一下数据怎么存，确定之后就可以分工搞了。基本的原则是：写入在 cloud 做，读取在 link 做。

补充约束：首发就必须支持 **到期积分**。至少包括：

- 每日赠送积分按天过期。
- 订阅月积分按计费周期过期。

这意味着积分在存储上不再是完全同质的总余额，必须能表达「某一批积分从何而来、何时过期、还剩多少、一次消耗实际扣了哪些 lot」。因此 v1 的持久化方案必须直接支持 expiring lot，而不是只做 aggregate balance。

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

### Architecture

选择 **方案 C（更新版）：shared 主账本 + expiring lot inventory**。

核心原则：

- **shared `public` schema 存积分权威账本与 lot 库存**，由 `nexu-cloud` 负责 migration 与写入。
- **`nexu-link` 只读 shared DB** 做准入判断，不拥有 `public` schema migration，也不写 `public.credit_*`。
- **`link.*` 只保留运行态遥测/对账信息**，不作为积分权威账本。
- **v1 必须支持到期积分**：`daily_gift` 当天过期；`subscription` 月积分在 `billing_period_end` 过期；默认 **no rollover**。
- **v1 采用 lot-based 模型**：每次入账都是一笔独立 `credit_recharges` lot，带 `remaining_credits`、`expires_at`、来源信息。
- **v1 固定按最早过期优先扣减**（FEFO：first-expiring-first-out）。
- **v1 采用 reservation / hold 结算**，由 link 发起、cloud 正式记账。
- **reservation 在 v1 是严格上界**：`actualAmountCredits` 不允许超过该请求的 `reserved_credits`；不做自动 overdraft / platform absorb。
- **v1 不做 debt / overdraft / postpaid / 对外余额 API**。

```text
充值 / 发奖 / 月积分发放
  -> nexu-cloud
  -> public.credit_recharges 插入一笔 lot
  -> public.credit_accounts.available_credits += amount

模型请求
  -> nexu-link 鉴权(api_key -> user_id)
  -> 读取 public.credit_accounts.available_credits / reserved_credits 做 fast-path precheck
  -> nexu-link 调用 nexu-cloud/internal/credits/reservations 创建 hold
  -> nexu-cloud 按 expires_at asc 选择可用 lots 并落 reservation
  -> nexu-link 调 provider
  -> nexu-link 调用 nexu-cloud/internal/credits/finalize 完成最终结算
  -> nexu-cloud 写 credit_usages + credit_usage_allocations
  -> nexu-link 写 link.usage_events

过期清理
  -> nexu-cloud cron 扫描已过期且未被 hold 占用的 lots
  -> 标记 expired 并同步扣减 credit_accounts.available_credits
```

### Data Model

- **`public.credit_accounts`**
  - 每个 `user_id` 一行，给 `nexu-link` 提供快速准入读取。
  - 这是账户级聚合投影；lot 级真相仍在 `credit_recharges` / `credit_usage_allocations` / `credit_reservation_allocations`。
  - 建议字段：
    - `id text primary key`
    - `user_id text not null unique`
    - `available_credits bigint not null default 0`
    - `reserved_credits bigint not null default 0`
    - `total_recharged_credits bigint not null default 0`
    - `total_used_credits bigint not null default 0`
    - `total_expired_credits bigint not null default 0`
    - `version bigint not null default 0`
    - `created_at timestamptz not null default now()`
    - `updated_at timestamptz not null default now()`
  - 约束：所有积分字段为 `bigint` 最小单位；`available_credits >= 0`；`reserved_credits >= 0`；`available_credits >= reserved_credits`。
  - 关键语义：`available_credits` 包含已 hold 但尚未 finalize 的额度；`spendable_credits = available_credits - reserved_credits`。

- **`public.credit_recharges`**
  - 权威 lot 库存表。每次入账都会生成一笔独立 lot；`remaining_credits` 会随结算/过期而变化。
  - 建议字段：
    - `id text primary key`
    - `user_id text not null`
    - `source text not null`
    - `amount_credits bigint not null`
    - `remaining_credits bigint not null`
    - `expires_at timestamptz null`
    - `billing_period_start timestamptz null`
    - `billing_period_end timestamptz null`
    - `status text not null default 'active'` -- `active | exhausted | expired`
    - `idempotency_key text not null unique`
    - `external_ref text null`
    - `metadata jsonb not null default '{}'::jsonb`
    - `created_at timestamptz not null default now()`
    - `updated_at timestamptz not null default now()`
  - 推荐 `source`：`daily_gift`、`subscription`、`purchase`、`reward_redemption`、`invite_reward`、`admin_grant`、`compensation_refund`。
  - 约束：`0 <= remaining_credits <= amount_credits`；`daily_gift` 必须有 `expires_at`；`subscription` 必须带 `billing_period_end`。
  - 索引：`(user_id, status, expires_at asc, created_at asc)`；必要时增加 `(source, external_ref)` 唯一约束。
  - 说明：这里沿用 `credit_recharges` 命名，但在语义上它已经是 expiring lot / credit grant inventory。

- **`public.credit_usages`**
  - 模型调用等消耗流水，append-only。
  - 建议字段：
    - `id text primary key`
    - `user_id text not null`
    - `api_key_id text null`
    - `request_id text not null unique`
    - `reservation_id text null`
    - `usage_type text not null`
    - `amount_credits bigint not null`
    - `provider text null`
    - `model text null`
    - `metadata jsonb not null default '{}'::jsonb`
    - `created_at timestamptz not null default now()`
  - v1 `usage_type` 可以先收敛为 `model_call`。
  - 索引：`(user_id, created_at desc)`、可选 `(api_key_id, created_at desc)`。
  - `request_id` 必须由网关生成，用作幂等键，避免重试导致重复扣费。

- **`public.credit_usage_allocations`**
  - 记录一笔 usage 实际消耗了哪些 lots。
  - 之所以需要这张表，是因为一笔 usage 可能跨多个 lot 扣减；只有保留 allocation 才能解释过期、审计和未来的退款/回滚。
  - 建议字段：
    - `id text primary key`
    - `usage_id text not null`
    - `recharge_id text not null`
    - `amount_credits bigint not null`
    - `created_at timestamptz not null default now()`
  - 索引：`(usage_id)`、`(recharge_id)`；约束 `amount_credits > 0`。

- **`public.credit_reservations`**
  - 请求前的 hold 记录，保证 prepaid 语义与并发正确性。
  - 建议字段：
    - `id text primary key`
    - `user_id text not null`
    - `api_key_id text null`
    - `request_id text not null unique`
    - `reserved_credits bigint not null`
    - `status text not null default 'active'` -- `active | finalized | released | expired`
    - `expires_at timestamptz not null`
    - `metadata jsonb not null default '{}'::jsonb`
    - `created_at timestamptz not null default now()`
    - `updated_at timestamptz not null default now()`

- **`public.credit_reservation_allocations`**
  - 记录一笔 reservation 预留了哪些 lots。
  - 这样才能在 lot 有过期机制时，把 hold 与具体 lot 绑定起来，避免并发下“余额够但同一批快过期 lot 被重复假定可用”的问题。
  - 建议字段：
    - `id text primary key`
    - `reservation_id text not null`
    - `recharge_id text not null`
    - `amount_credits bigint not null`
    - `created_at timestamptz not null default now()`

- **继续保留 `link.usage_events`**
  - 用于网关运行态观察、排障、对账。
  - 不是积分权威账本，不承载余额语义。

- **v1 不引入 `credit_balances` 作为权威表**
  - 如果后续需要单独的余额缓存表或 Redis 热缓存，只能作为 projection / cache，不能作为 source of truth。

- **业务域表与积分主账本解耦**
  - `subscription_plans`、`subscriptions`、`credit_pack_plans`、`reward_task_definitions`、`reward_claims`、`payment_records`、`model_definitions` 可以由 cloud 侧并行设计。
  - 但这些表在本轮不是积分权威账本的一部分，只通过 `source`、`external_ref`、`metadata`、`billing_period_*` 与主账本关联。

### Expiry and Deduction Policy

- **扣减顺序固定为 FEFO**：按 `expires_at asc nulls last, created_at asc` 选择可用 lot。
- **`daily_gift`**：当天 `23:59:59 UTC` 过期。
- **`subscription` 月积分**：在该 lot 的 `billing_period_end` 过期。
- **默认 no rollover**：上一计费周期未用完的 `subscription` lot 直接过期，不滚入下周期。
- **其他来源**：`purchase` / `reward` / `admin_grant` 是否过期由该来源显式写入 `expires_at` 决定；若允许永久有效则为 `NULL`。
- **reservation 与 expiry 的关系**：已被 active reservation 占用的额度视为被 pin 住，不在同一次 expiry sweep 中直接过期；待 reservation finalize / release 后再处理剩余 free amount。
- **跨过期边界的 finalize**：只要 reservation 在 lot 过期前已成功创建，就允许在 `expires_at` 之后用这部分 pinned amount 完成 finalize。
- **过期后释放未消费 hold**：若 reservation release 时对应 lot 已经过期，则释放出来的未消费 remainder 立即转为 expired，不重新变成 spendable。

### Read / Write Boundaries

- **Cloud 写入职责**
  - `nexu-cloud` 是 `public.credit_*` 的唯一 writer。
  - 固定负责入账、reservation 创建、usage finalize、release、expiry sweep。
  - cloud 同时是 **积分金额计算的权威执行者**：最终 `actualAmountCredits` 由 cloud 根据 provider usage / pricing context 计算，不信任 link 直接传入已计算好的扣减值。
  - 所有对 `credit_accounts`、`credit_recharges`、`credit_usages`、`credit_usage_allocations`、`credit_reservations`、`credit_reservation_allocations` 的修改，都必须发生在 cloud 的本地 DB transaction 中。

- **Link 读取职责**
  - 基于 `api_key -> user_id` 读取 `public.credit_accounts.available_credits` 与 `reserved_credits`。
  - 只做 fast-path admission precheck，不直接写 shared 主账本。
  - v1 不再依赖现有时间窗 / usage limit 作为主准入逻辑。

- **内部接口约定（非用户侧 API）**
  - `PostCreditGrant(userId, amountCredits, source, expiresAt?, billingPeriodStart?, billingPeriodEnd?, externalRef?, idempotencyKey, metadata?)`
  - `CreateReservation(userId, apiKeyId?, requestId, reserveAmount, pricingContext)`
  - `FinalizeUsage(userId, apiKeyId?, requestId, usageType, providerUsage, pricingContext, dimensions)`
  - `ReleaseReservation(requestId, reason)`
  - `GetAvailableCredits(userId)` 仅作为 link 的读模型，不在本轮设计外部接口。

### Why Service Call + DB Write Are Split

这部分需要明确区分 **“谁感知到一次消耗”** 和 **“谁真正把消耗记到账本里”**：

- **`nexu-link` 感知消耗发生**
  - 所有模型请求先到 link，link 最清楚“哪个用户发起了哪次模型调用”。
  - 所以 link 负责生成 `request_id`、构造 pricing context / admission guard、把 provider usage 原始维度传给 cloud，并发起内部结算控制调用。

- **`nexu-cloud` 真正执行记账**
  - 因为既定原则是“写入在 cloud 做”。
  - 所以 reservation 创建、lot 选择、最终金额计算、余额扣减、usage 流水写入，都必须由 cloud 在本地 DB transaction 中完成。

- **因此会同时存在两层记录**
  - `public.credit_usages` + `public.credit_usage_allocations`：权威积分账本，由 cloud 写。
  - `link.usage_events`：网关运行事件，由 link 写。

一句话：

```text
link 负责“发起结算控制”
cloud 负责“正式记账”
```

### Sequence: LLM Settlement Flow

```text
User/API client
  -> nexu-link: 发起模型请求 + API key

nexu-link
  -> public.credit_accounts: 读取 available_credits / reserved_credits（仅预检查）
  -> nexu-cloud/internal/credits/reservations: 创建 hold

nexu-cloud
  -> DB transaction:
       1. 按 expires_at asc 选择 spendable lots
       2. 插入 credit_reservations
       3. 插入 credit_reservation_allocations
       4. credit_accounts.reserved_credits += reserveAmount
  -> nexu-link: 返回 success / insufficient_credits

If success:
  nexu-link -> model provider: 发起模型调用
  provider -> nexu-link: 返回最终 usage
  nexu-link -> nexu-cloud/internal/credits/finalize: 传 provider usage 与 pricing context

nexu-cloud finalize transaction:
  0. 根据 provider usage + pricing context 计算 actualAmountCredits
  0.5 若 actualAmountCredits > reserved_credits，则按 settlement_invariant_violation 失败，写告警，不走自动 overdraft / absorb
  1. 插入 credit_usages
  2. 插入 credit_usage_allocations
  3. 对被消费的 lots 扣减 remaining_credits
  4. credit_accounts.available_credits -= actualAmountCredits
  5. credit_accounts.reserved_credits -= reserveAmount
  6. 释放未使用部分 hold，更新 reservation status

Always:
  nexu-link -> link.usage_events: 记录运行态事件
```

### What Is And Is Not A Transaction

- **是事务的部分**
  - `nexu-cloud` 内部对 Postgres 的一次本地事务。
  - 例如：创建 reservation 并选择具体 lots，或 finalize usage 并写入 allocations。

- **不是事务的部分**
  - `nexu-link -> nexu-cloud` 的 HTTP / internal service call。
  - `nexu-link -> model provider` 的外部模型调用。

- **所以这不是跨服务分布式事务**
  - 没有 2PC。
  - 没有要求 link 和 cloud 同时 commit。
  - 真正的强一致只发生在 cloud 自己那次 DB transaction 里。

### Responsibility Matrix

| 动作 | 发起者 | 真正执行者 | 落库位置 |
|---|---|---|---|
| 读取余额预检查 | link | link | `public.credit_accounts` 只读 |
| 创建 reservation | link | cloud | `public.credit_accounts` + `public.credit_reservations` + `public.credit_reservation_allocations` |
| 调模型 | link | link | 不写主账本 |
| 最终 usage 结算 | link | cloud | `public.credit_accounts` + `public.credit_usages` + `public.credit_usage_allocations` + `public.credit_recharges` |
| 释放失败/超时 reservation | link/cloud | cloud | `public.credit_accounts` + `public.credit_reservations` |
| 清理过期 reservation | cloud job | cloud | `public.credit_accounts` + `public.credit_reservations` |
| 过期 sweep | cloud job | cloud | `public.credit_accounts` + `public.credit_recharges` |
| 运行态 usage 记录 | link | link | `link.usage_events` |

### Why Link Still Writes `usage_events`

link 仍然要写 `link.usage_events`，原因是：

- 它是模型网关，天然拥有请求耗时、provider、model、状态码等运行态信息。
- 这些信息适合做排障、监控、对账。
- 但它们**不等于**权威余额账本；真正的余额语义仍以 shared 主账本里的 usage / allocation / lot 库存为准。

可以把它理解成：

```text
credit_usages + allocations = 财务账
usage_events                = 运营日志
```

### Implementation Steps

1. **定义 shared schema**
   - 在 `nexu-cloud` 管理的 shared/public schema 中增加 `credit_accounts`、`credit_recharges`、`credit_usages`、`credit_usage_allocations`、`credit_reservations`、`credit_reservation_allocations`。
   - 为 `user_id`、`request_id`、`expires_at`、lot 扣减查询建立索引。

2. **实现 cloud 写路径**
  - 入账写入：新增 expiring lot，并原子更新 `credit_accounts`。
  - 模型消耗写入：通过 internal API 执行 reservation / finalize / release 事务。
  - reservation 清理：实现 stale reservation cleanup，释放 `reserved_credits`，并在必要时把已过期 lot 的 released remainder 立即转成 expired。
  - 过期写入：实现 expiry sweep，把 lot 的剩余未消费额度转成 expired 并同步更新账户投影。

3. **切换 link 准入读取**
   - `nexu-link` 在鉴权后按 `user_id` 读取 `credit_accounts.available_credits` / `reserved_credits`。
   - `spendable_credits` 不足时直接拒绝；其余请求进入 reservation / finalize 链路。

4. **保留运行态记录与对账能力**
   - `link.usage_events` 继续记录请求结果与成本维度。
   - 用于事后排障、补记、对账，不直接驱动余额。

5. **分阶段上线**
  - 先落 shared schema 与 internal API。
  - 再实现 cloud expiry sweep。
  - 再切 link 的 admission gate 与 settlement client。
  - 最后补齐对账/回放与运营工具能力。

### Pseudocode

#### Admission Check in Link

```text
Authenticate apiKey
Resolve userId from apiKey
Load creditAccount by userId
Compute admission_guard_amount from pricing context

If creditAccount missing:
  Reject as insufficient credits

If (available_credits - reserved_credits) < admission_guard_amount:
  Reject as insufficient credits

CreateReservation(userId, apiKeyId, requestId, reserveAmount)
Proceed only if reservation succeeds
```

#### Credit Grant Posting in Cloud

```text
Begin transaction
Insert credit_recharges row with:
  amount_credits = grantAmount
  remaining_credits = grantAmount
  source = daily_gift | subscription | purchase | reward_redemption | ...
  expires_at / billing_period_* according to source policy
Upsert credit_accounts by userId
Increase available_credits
Increase total_recharged_credits
Commit transaction
```

#### Reservation Posting in Cloud

```text
Begin transaction
Load active, unexpired recharge lots ordered by expires_at asc, created_at asc
Subtract amounts already pinned by active reservation allocations
If spendable total < reserveAmount:
  Rollback as insufficient credits

Insert credit_reservations row
Insert credit_reservation_allocations rows
Increase credit_accounts.reserved_credits by reserveAmount
Commit transaction
```

#### Usage Finalization in Cloud

```text
Begin transaction
Load active reservation by request_id
Compute actualAmountCredits from provider usage + pricing context
If actualAmountCredits > reservedAmount:
  Fail as settlement_invariant_violation
  Write alert / anomaly event
  Rollback automatic finalize
Insert credit_usages row
Insert credit_usage_allocations rows from the reserved lots actually consumed
Decrease credit_recharges.remaining_credits on consumed lots
Mark exhausted lots when remaining_credits = 0
Decrease credit_accounts.available_credits by actualAmountCredits
Decrease credit_accounts.reserved_credits by reservedAmount
Mark reservation as finalized / released
Commit transaction
```

#### Expiry Sweep in Cloud

```text
Begin transaction
Select active recharge lots where expires_at <= now()
Exclude amounts pinned by active reservation allocations
For each lot with free remaining_credits > 0:
  Mark lot expired
  Decrease credit_accounts.available_credits by expiredFreeAmount
  Increase credit_accounts.total_expired_credits by expiredFreeAmount
Commit transaction
```

#### Reservation Cleanup in Cloud

```text
Begin transaction
Select active reservations where expires_at <= now()
Mark reservations expired
Decrease credit_accounts.reserved_credits by reservedAmount
If any released remainder belongs to already expired lots:
  Expire that remainder immediately
Commit transaction
```

### Lifecycle Flows

#### Flow 1: 用户新注册

```text
Create user in cloud auth tables
Insert credit_accounts row with zero balance
Do not create recharge/usage rows
```

- 建议在注册时就创建 `credit_accounts`，避免后续“是否开户”分支。
- 若存在历史用户回填，link 仍应把缺失账户视为 0 余额。

#### Flow 2: 每日赠送积分

```text
Daily gift job validates eligibility
Begin transaction
Insert credit_recharges with:
  source = daily_gift
  amount_credits = grantAmount
  remaining_credits = grantAmount
  expires_at = same day 23:59:59 UTC
  idempotency_key = daily_gift_event_id
Update credit_accounts:
  available_credits += grantAmount
  total_recharged_credits += grantAmount
Commit transaction
```

#### Flow 3: 订阅月积分发放

```text
Billing cycle starts / renews
Begin transaction
Insert credit_recharges with:
  source = subscription
  amount_credits = monthlyQuota
  remaining_credits = monthlyQuota
  billing_period_start = cycleStart
  billing_period_end = cycleEnd
  expires_at = cycleEnd
  idempotency_key = subscription_cycle_id
  external_ref = subscription_id or invoice_id
Update credit_accounts:
  available_credits += monthlyQuota
  total_recharged_credits += monthlyQuota
Commit transaction
```

- v1 默认 **no rollover**，上一周期未消费完的 lot 由 expiry sweep 过期，不转入新周期。

#### Flow 4: 购买积分包 / 奖励兑换 / 邀请奖励 / 后台赠送

```text
Source system validates eligibility or payment success
Begin transaction
Insert credit_recharges with:
  source = purchase | reward_redemption | invite_reward | admin_grant
  remaining_credits = amount_credits
  expires_at = source policy
  idempotency_key = source event id
  external_ref = order_id / reward_id / campaign_id / admin_action_id
Update credit_accounts:
  available_credits += amount_credits
  total_recharged_credits += amount_credits
Commit transaction
```

#### Flow 5: 使用模型并消耗积分

```text
Link authenticates api_key and resolves user_id
Link reads credit_accounts for fast-path precheck
Link generates request_id
Cloud creates reservation over concrete lots
If reservation succeeds:
  Link dispatches model request
  Provider returns final usage
  Cloud finalizes usage, writes usage allocations, and releases unused hold
If provider call fails / times out:
  Cloud releases reservation without writing credit_usages
```

- v1 明确使用 **reservation / hold**，不采用 platform absorb。
- `reserveAmount` 必须是 v1 的严格上界；没有可计算上界的请求类型不在本轮范围内。
- v1 明确 **不引入 debt 表**；若后续要支持 overdraft / postpaid，再单独设计 debt ledger。

### Files / Repos Likely Affected

- **This repo**
  - `specs/change/20260330-credit-storage/spec.md` — 设计与实施计划。

- **nexu-cloud**
  - `apps/api/src/db/schema/index.ts` — 新增 shared/public 积分表定义。
  - `apps/api/migrations/` — 新增积分表 migration。
  - `apps/api/src/services/credit/*` — 入账事务、reservation / finalize / release、expiry sweep。
  - `apps/api/src/routes/internal/*` — link -> cloud 的内部结算接口。

- **nexu-link**
  - `internal/repositories/postgres.go` — 读取 `public.credit_accounts`。
  - `internal/middleware/auth.go` — 用积分余额替换旧的 usage-limit admission gate。
  - `internal/server/server.go` / `internal/domain/types.go` — 注入 credit read model 与 cloud settlement client。

### Edge Cases

- **重复结算**：`credit_usages.request_id` 唯一，重试只会命中同一笔 usage。
- **重复支付通知 / 重复奖励发放 / 重复发月积分**：`credit_recharges.idempotency_key` 唯一，防止重复入账。
- **并发 reservation / finalize**：lot 选择、allocation 写入、账户投影更新必须在 cloud 的单次事务中完成，防止重复占用同一批额度。
- **lot 部分消费**：通过 `credit_usage_allocations` 显式记录，不靠“猜测总余额变化”。
- **lot 过期与 hold 竞争**：active reservation 已 pin 的额度不在同一次 expiry sweep 中直接过期；先等 finalize / release。
- **finalize 超出 hold**：若 `actualAmountCredits > reserved_credits`，按 `settlement_invariant_violation` 处理，触发告警与人工补偿路径；v1 不自动 debt / absorb。
- **stale reservation**：由 cloud job 统一清理，不依赖 link 一定回调释放。
- **用户尚未开户**：正常新注册流程应创建 `credit_accounts`；仅在历史回填/异常场景下把缺失账户视为 0 余额。
- **api key 轮换**：余额归属 `user_id`，不归属单个 key，避免 key 更换导致余额碎片化。
- **数值精度**：积分统一使用整数最小单位，不使用浮点。
- **daily gift 时间边界**：统一以 UTC 计算，避免桌面时区差异导致的过期不一致。
- **subscription 周期边界**：统一以 `billing_period_end` 为准，不通过“自然月”隐式推导。
- **本轮明确不做**：debt、postpaid、对外余额 API、把 `credit_balances` / Redis 作为权威账本。

## Plan

- [ ] Phase 1: 冻结 shared schema、lot/expiry 语义和 cloud 单写边界
- [ ] Phase 2: 在 cloud 落地 credit write path、reservation/finalize internal API、expiry sweep
- [ ] Phase 3: 将 link 准入从窗口限额切换为积分余额 + reservation 结算链路
- [ ] Phase 4: 补齐对账、上线保护与运行验证

## Notes

<!-- Optional: Alternatives considered, open questions, etc. -->
