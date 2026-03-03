# Nexu 单应用多租户架构设计

## 1. 问题

现有模式下，每个团队需要自行创建 Slack App、配置 botToken 和 signingSecret、再接入 Nexu。这个流程要求用户理解 Slack API 的概念，配置门槛高，几乎过滤掉了所有非技术用户。

我们需要的是：**用户在 Slack 里点一下安装，就能用。**

## 2. 三层设计

本次重构的核心是三层递进式设计：从零配置安装，到用户身份识别，再到团队知识沉淀。

```
┌─────────────────────────────────────────────────────────┐
│  第三层：分层 Memory                                      │
│  团队知识（共享）+ 公共记忆（agent 积累）+ 会话记忆（隔离）  │
├─────────────────────────────────────────────────────────┤
│  第二层：用户认证                                         │
│  Slack 用户 → Nexu 账号关联 · per-peer session 隔离      │
├─────────────────────────────────────────────────────────┤
│  第一层：Workspace 自动配置                               │
│  一键 OAuth 安装 · 自动创建 agent · 零配置                │
└─────────────────────────────────────────────────────────┘
```

### 第一层：Workspace 自动配置

**用户视角**：点击 "Add Nexu to Slack" → 在 Slack 里授权 → @Nexu 开始对话。

**系统行为**：

```
用户点击安装
    ↓
Slack OAuth 授权
    ↓
Nexu 收到回调
    ├── 获取该 workspace 的 bot token
    ├── 创建 workspace agent（slug: slack-ws-{teamId}）
    ├── 配置 Slack account（botToken, webhookPath）
    ├── 创建 account binding → agent
    └── 发布配置快照 → Gateway 加载新 agent
    ↓
用户在 Slack @Nexu → 收到回复 ✓
```

所有 workspace 共用一个 Nexu Slack App，但每个 workspace 安装后获得独立的 bot token，映射为 OpenClaw 中的独立 Slack account + 独立 agent。workspace 之间完全隔离。

**未注册 workspace 的处理**：安装了 App 但还没注册 Nexu 账号的用户，由 Nexu API 层直接用低成本模型（Haiku）回复，附带注册链接。不经过 gateway，零资源消耗。注册后自动切换到完整 agent。

### 第二层：用户认证与 Session 隔离

**用户视角**：首次 @Nexu 收到注册引导 → 点击链接注册/登录 → 后续正常使用。

**系统行为**：

```
Slack 事件到达 Nexu API
    ↓
提取 slackUserId
    ↓
查询用户关联表
    ├── 未关联 → 回复注册链接（Slack API 直发，不经 gateway）
    └── 已关联 → 转发到 gateway → agent 处理
```

**关键设计**：每个 workspace 保持**单一共享 agent**，不为每个用户创建独立 agent。用户间的隔离通过 per-peer session 实现 — 同一个 agent 为 workspace 内所有用户服务，但每个用户拥有独立的会话上下文，互不可见：

```
agent:ws-T12345:slack:direct:U001   ← Alice 的会话
agent:ws-T12345:slack:direct:U002   ← Bob 的会话
```

认证检查在 Nexu API 层完成，gateway 只处理已认证用户的消息。这保证了：
- 未注册用户不消耗 gateway 资源
- 认证逻辑与 agent 逻辑解耦
- 注册引导可以随时调整，不影响 agent 行为

**用户身份识别**：通过 identity links 将 Slack userId 映射为友好名称，agent 在对话中能识别 "这是 Alice" 而不是 "这是 U001"。同一个用户在 Slack、Discord、飞书的身份可以统一，共享 session 上下文。

### 第三层：分层 Memory

单一共享 agent 的 memory 是这个架构中最关键也最复杂的部分。需要解决三个问题：

1. **用户偏好怎么存？** 人数多了不能全塞一个文件。
2. **跨 session 怎么通？** 私聊让 bot 做的事，群聊里怎么问进度？
3. **团队知识怎么注入？** 管理员维护的 SOP/FAQ 怎么让 agent 知道？

先看 OpenClaw 给我们的工具箱：

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Workspace（所有 session 共享）        │
│                                                              │
│  MEMORY.md  ← 每轮注入到 system prompt，跨 session 可见      │
│  memory/*.md ← QMD 向量索引，语义搜索召回                     │
│  任意文件    ← agent 可以自由读写，跨 session 持久化           │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  Session Transcripts（per-session 隔离）                      │
│                                                              │
│  agent:{id}:slack:direct:U001.jsonl  ← Alice DM             │
│  agent:{id}:slack:direct:U002.jsonl  ← Bob DM               │
│  agent:{id}:slack:channel:C001.jsonl ← #general 群聊         │
│                                                              │
│  默认不互通，但可通过 sessions_history 工具跨 session 读取     │
└──────────────────────────────────────────────────────────────┘
```

关键机制：
- **Workspace 文件**是跨 session 桥梁 — 一个 session 写的文件，另一个 session 立刻能读到
- **MEMORY.md** 特殊地位 — 每一轮对话都自动注入到 system prompt，无需 agent 主动召回
- **memory/*.md** 被 QMD 索引 — agent 调用 `memory_search` 时通过向量搜索召回相关片段
- **sessions_history 工具** — 配置 `tools.sessions.visibility: "agent"` 后，agent 可以读取自己的任何 session 历史

#### 用户偏好：代理层注入 + per-user 文件

**不用一个大文件。** 100 个用户的偏好塞到 `user-profiles.md` 里，每轮对话都注入，既浪费 token 又容易被截断。

正确做法分两层：

**即时层 — OpenClaw 原生身份识别 + Nexu 元数据补充**

OpenClaw 已经具备用户身份识别能力：Slack 消息处理链会提取 `message.user`（如 `U001`），通过 Slack API 解析出显示名（如 "Alice"），agent 每轮都知道"谁在跟我说话"。再配合 `identityLinks`，还能将 `slack:U001` 映射为跨 channel 的友好名称。

OpenClaw **不知道的**是 Nexu 侧的用户元数据：角色、团队、偏好设置、注册时间等。如果需要这些信息，Nexu 事件代理在转发消息前附加：

```
[Nexu Context] Role: 后端开发 | Team: 基础架构组 | Plan: Pro
---
帮我写个函数
```

这一层是可选的。只有在 agent 需要根据用户的 Nexu 属性（角色、权限、订阅等级等）做差异化响应时才需要注入。

**持久层 — per-user 记忆文件（按需读取）**

更丰富的用户上下文存储在 workspace 的 per-user 文件中：

```
{workspace}/
└── memory/
    └── users/
        ├── U001-alice.md    ← Alice 的深度偏好、历史摘要
        └── U002-bob.md      ← Bob 的深度偏好、历史摘要
```

这些文件被 QMD 索引。当 agent 需要更深的用户背景时（比如 Alice 说"继续上次的方案"），`memory_search` 能召回 Alice 的专属文件。但不会注入到其他用户的 prompt 中。

Nexu 负责在用户更新偏好时同步这些文件到 gateway workspace。

#### 跨 Session 通信：私聊做事，群聊问进度

**场景**：Alice 私聊 @Nexu "帮我调研一下竞品 X"，过了一会在 #general 群聊里问 "@Nexu Alice 那个竞品调研做得怎么样了？"

私聊和群聊是两个不同的 session：

```
私聊 session: agent:ws-T12345:slack:direct:U001
群聊 session: agent:ws-T12345:slack:channel:C001
```

默认情况下它们互相不可见。但有三条通路可以打通：

**通路一：MEMORY.md（自动，实时性最高）**

Agent 在私聊中执行任务时，将关键状态写入 `MEMORY.md`：

```markdown
## 进行中的任务
- [Alice] 竞品 X 调研：已完成市场分析，正在整理功能对比表。预计明天完成。
```

MEMORY.md **每轮对话都自动注入 system prompt**。所以当群聊中有人问进度时，agent 已经"知道"了 — 不需要搜索，不需要回忆，它就在 prompt 里。

这是最自然的跨 session 机制。代价是 MEMORY.md 的大小有限（默认截断到 20,000 字符），适合存摘要而非全文。

**通路二：memory_search（按需，语义召回）**

Agent 将更详细的工作产出写到 `memory/` 目录：

```
{workspace}/memory/tasks/competitive-analysis-x.md
```

这些文件被 QMD 索引。群聊中有人问"竞品 X 调研进度"时，agent 调用 `memory_search("竞品 X 调研")`，向量搜索召回相关文件内容。

适合存储详细的工作产出、分析报告、方案文档。不受 MEMORY.md 大小限制。

**通路三：sessions_history（显式，最完整）**

配置 `tools.sessions.visibility: "agent"` 后，agent 获得 `sessions_history` 工具，可以直接读取同 agent 下任意 session 的聊天记录：

```
agent 调用 sessions_history({ sessionKey: "agent:ws-T12345:slack:direct:U001", limit: 20 })
→ 返回 Alice 私聊的最近 20 条消息
```

这是最完整的跨 session 召回，能拿到原始对话上下文。但也是代价最高的 — 需要 agent 主动调用，会消耗 token 加载历史记录。

**推荐组合**：

| 信息类型 | 存储位置 | 召回方式 | 延迟 |
|----------|----------|----------|------|
| 任务状态摘要 | `MEMORY.md` | 每轮自动注入 | 即时 |
| 详细工作产出 | `memory/tasks/*.md` | `memory_search` 语义召回 | 按需 |
| 原始对话记录 | session transcript | `sessions_history` 工具 | 显式调用 |

Agent 的 system prompt（通过 SOUL.md 或 IDENTITY.md）指导它遵循这个约定：

```markdown
## 任务管理约定
- 当用户交给你一个任务时，在 MEMORY.md 的"进行中的任务"章节记录任务摘要和状态。
- 任务有重要产出时，写入 memory/tasks/{topic}.md。
- 任务完成时，更新 MEMORY.md 状态为"已完成"，并记录关键结论。
- 当被问到其他用户的任务进度时，先看 MEMORY.md，如果需要更多细节再用 memory_search。
```

#### 团队知识：两条路径

团队知识分两类，走不同机制：

**操作指南（SOP、工作流）→ Skill 系统**

Skill 的机制是**纯文本注入 system prompt**：所有 skill 的名称 + 描述 + 路径被格式化为列表注入 prompt，agent 自行判断相关性后用 `read` 工具读取完整内容。没有向量检索，没有 embedding。

上限：30,000 字符 / 150 个 skill。适合少量、结构化的操作指南。

```yaml
skills:
  load:
    watch: true            # 文件变更自动重载
    extraDirs:
      - "/data/team-skills/T12345"
```

Nexu 将 SOP 类知识渲染为 `SKILL.md` 格式写入 `extraDirs`，skill watcher 检测变更后自动重载。

**知识库文档（FAQ、产品文档、技术方案）→ Memory 语义召回**

大量知识内容不能走 skill（会撑爆 prompt token 预算），应该走 `memory/*.md` + QMD 向量索引：

```
Nexu UI 编辑知识 → 渲染为 Markdown → 写入 {workspace}/memory/knowledge/*.md → QMD 自动索引
```

QMD 将文件切片为 ~700 字符的片段，生成向量 embedding 存入 SQLite。agent 调用 `memory_search` 时通过向量 + BM25 混合搜索召回相关片段。无大小限制，适合大量文档。

**两者对比**：

| | Skill | Memory |
|--|-------|--------|
| 召回机制 | agent 从 prompt 列表中选择后 `read` 读取 | `memory_search` 向量 + BM25 混合搜索 |
| 索引 | 无（纯文本列表） | 向量 embedding + 全文索引 |
| 容量 | ~30K 字符 / 150 个 | 无硬上限 |
| 适合 | SOP、工作流、操作指南 | FAQ、产品文档、技术方案 |
| 热更新 | `watch: true` 文件监听 | 写入 memory/ 目录后自动索引 |

#### 完整 Memory 架构

```
{workspace}/
├── MEMORY.md                          ← 每轮自动注入 system prompt
│   ├── ## 进行中的任务                │   跨 session 即时可见
│   ├── ## 近期重要结论                │   适合摘要和状态
│   └── ## 团队公告                    │   大小限制 ~20K 字符
│
├── IDENTITY.md / SOUL.md              ← 每轮注入，定义 agent 人格和行为约定
│
├── memory/                            ← QMD 向量索引，语义搜索
│   ├── tasks/                         │
│   │   ├── competitive-analysis.md    │   详细工作产出
│   │   └── api-design-v2.md           │   跨 session 按需召回
│   └── users/                         │
│       ├── U001-alice.md              │   per-user 深度偏好
│       └── U002-bob.md                │   按需召回，不全量注入
│
├── sessions/                          ← per-session 隔离
│   ├── ...direct:U001.jsonl           │   Alice 私聊
│   ├── ...direct:U002.jsonl           │   Bob 私聊
│   └── ...channel:C001.jsonl          │   #general 群聊
│
└── (team-skills/{teamId}/)            ← 外部目录，skill 热加载
    ├── team-knowledge.md              │   团队知识库
    └── team-sop.md                    │   团队 SOP
```

| 层级 | 存储 | 注入方式 | 可见范围 | 适合内容 |
|------|------|----------|----------|----------|
| **MEMORY.md** | workspace 根目录 | 每轮自动注入 prompt | 所有 session | 任务状态、摘要、公告 |
| **memory/*.md** | workspace/memory/ | `memory_search` 语义召回 | 所有 session（按需） | 详细产出、用户偏好 |
| **Team Skills** | extraDirs 外部目录 | prompt 注入列表 + agent `read` | 所有 session | SOP、操作指南（少量） |
| **Team Knowledge** | memory/knowledge/*.md | `memory_search` 向量召回 | 所有 session（按需） | FAQ、产品文档（大量） |
| **Session 历史** | sessions/*.jsonl | `sessions_history` 工具 | 默认仅自身 session | 原始对话记录 |
| **OpenClaw 身份** | 消息上下文 | 原生提取 sender + identityLinks | 每轮自动 | 用户身份、显示名 |
| **Nexu 元数据** | 消息头部（可选） | 代理注入 | 当前消息 | 角色、团队、订阅等级 |

## 3. 消息流

### 完整消息路径（已注册用户）

```
用户 @Nexu "帮我写个函数"
    │
    ▼
Slack Event → POST /api/slack/events
    │
    ▼
Nexu API：签名验证（共享 signing secret，单 App 统一）
    │
    ▼
Nexu API：路由查询（teamId:appId → workspace route）
    │
    ▼
Nexu API：用户认证（已关联？）
    │
    ├── 未认证 → Haiku 生成引导回复 + 注册链接，Slack API 直发
    │
    └── 已认证 ↓
        │
        ▼
    转发到 Gateway（POST http://{podIp}:18789/slack/events/{accountId}）
        │
        ▼
    OpenClaw：account binding → 路由到 workspace agent
        │
        ▼
    OpenClaw：session key 解析（agent:{id}:slack:direct:{userId}）
        │
        ▼
    Agent 执行：加载会话上下文 + team skill + memory
        │
        ▼
    回复通过 Slack API 投递到用户
```

### 安装流程

```
                    ┌──────────┐
                    │  用户     │
                    └────┬─────┘
                         │ 1. 点击 "Add to Slack"
                         ▼
                    ┌──────────┐
                    │  Slack   │
                    │  OAuth   │
                    └────┬─────┘
                         │ 2. 授权回调（code + teamId）
                         ▼
              ┌──────────────────────┐
              │      Nexu API        │
              │                      │
              │ 3. 交换 bot token    │
              │ 4. 存储 installation │
              │ 5. 创建 agent config │
              │ 6. 发布配置快照      │
              └──────────┬───────────┘
                         │ 7. configVersion +1
                         ▼
              ┌──────────────────────┐
              │   OpenClaw Gateway   │
              │                      │
              │ 8. 检测版本变更      │
              │ 9. 拉取新配置        │
              │ 10. 加载新 agent     │
              └──────────────────────┘
```

## 4. 整体架构

```
┌─────────────────────────────────────────────────┐
│                    Slack                         │
│  Workspace A    Workspace B    Workspace C       │
│  @Nexu          @Nexu          @Nexu             │
└──────┬──────────────┬──────────────┬─────────────┘
       │              │              │
       │   同一个 Nexu Slack App     │
       │   不同 workspace 的 OAuth   │
       │   token 自动获取            │
       ▼              ▼              ▼
┌─────────────────────────────────────────────────┐
│              Nexu API（控制面）                    │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │ 事件代理  │  │ 用户认证  │  │ 配置生成器    │   │
│  │          │  │          │  │              │   │
│  │ 签名验证  │  │ 账号关联  │  │ DB → Config  │   │
│  │ 用户识别  │  │ 注册引导  │  │ 发布快照     │   │
│  └────┬─────┘  └──────────┘  └──────┬───────┘   │
│       │                             │            │
│       │    ┌────────────────────┐    │            │
│       └───►│  OpenClaw Gateway  │◄───┘            │
│            │    （数据面）        │                 │
│            │                    │                 │
│            │  Agent A (WS-A)   │                 │
│            │  Agent B (WS-B)   │                 │
│            │  Agent C (WS-C)   │                 │
│            └────────────────────┘                 │
└─────────────────────────────────────────────────┘
```

**Nexu 是控制面**：用户管理、认证、配置生成、事件路由、团队知识管理。
**OpenClaw 是数据面**：agent 执行、会话管理、消息投递、memory 存储。

两层职责清晰，Nexu 决定"谁能用、用什么配置"，OpenClaw 决定"怎么执行、怎么回复"。

## 5. 复用的 OpenClaw 能力

整个架构建立在 OpenClaw 的现有能力之上，不需要对 OpenClaw 做任何核心变更。

### 多账号 Slack HTTP 路由

单个 gateway 进程通过 `webhookPath` 区分多个 Slack workspace：

```yaml
channels:
  slack:
    mode: http
    accounts:
      workspace-A:
        botToken: "xoxb-workspace-a-token"
        webhookPath: "/slack/events/workspace-A"
      workspace-B:
        botToken: "xoxb-workspace-b-token"
        webhookPath: "/slack/events/workspace-B"
```

每个 workspace 安装 Nexu App 后的 bot token 映射为一个独立 account。

### Binding 路由

消息路由到正确 agent 的核心机制。支持多层匹配，优先级从高到低：

| 层级 | 匹配字段 | 本架构中的用途 |
|------|----------|--------------|
| Peer | `peer: { kind, id }` | 预留：未来可做 per-user agent |
| Account | `accountId` | **主要**：workspace → agent |
| Channel | `channel: "slack"` | 兜底路由 |

```yaml
bindings:
  - agentId: "ws-T12345"
    match:
      channel: slack
      accountId: "workspace-T12345"
```

### Per-Agent 隔离

每个 agent 拥有完全独立的工作目录、会话存储和 memory。不同 workspace 的 agent 之间零共享。

### Per-Peer Session 隔离

同一 agent 内按 `dmScope: "per-peer"` 自动为每个用户创建独立 session。无需创建多个 agent 就能实现用户间隔离。

### Identity Links

跨 channel 用户身份映射。同一个用户在 Slack、Discord、飞书的身份统一到一个逻辑名称，共享 session 上下文。

### Skill 热加载

- `watch: true`：文件变更后自动加载
- `extraDirs`：从额外目录加载 skill

团队知识渲染为 skill 文件后，管理员在 Nexu UI 编辑 → skill 文件更新 → agent 立即可用。

### Config 版本化

Nexu 生成配置快照（带版本号）→ Gateway 轮询版本 → 检测到变更自动重载。新 workspace 安装后的 agent 配置通过这个链路传播到 gateway。

## 6. 安全边界

| 边界 | 机制 |
|------|------|
| Workspace 间 | Per-agent workspace + session store 物理隔离 |
| 用户间 | Per-peer session key，同 agent 内会话不可见 |
| 未认证用户 | Nexu API 层拦截，不到达 gateway |
| 凭证 | Bot token AES-256-GCM 加密存储 |
| 事件验证 | HMAC-SHA256 签名验证（单 App 共享 signing secret） |
| 内网通信 | Gateway ← Nexu pod IP 直连，不暴露公网 |

## 7. 扩展方向

### 多 Channel 复用

同一套架构天然适用于 Discord 和飞书：
- Discord：OAuth2 Bot 安装 → 类似的 workspace agent 配置
- 飞书：已有 WebSocket 模式 + 动态 Agent 创建

通过 identity links，同一用户跨 channel 共享 session。

### 多 Gateway 横向扩展

workspace 数量增长时，通过 gateway pool 扩展：
- 每个 pool 承载一定数量的 workspace agent
- 新 workspace 自动分配到负载最低的 pool
- 已有 `gatewayPools` 表支持 `maxBots`、`currentBots` 字段

### Shared Context Block

OpenClaw 社区正在讨论 [Shared Context Block](https://github.com/openclaw/openclaw/issues/24832) — 允许同一 agent 的所有 session 共享一个上下文块，独立于 prompt cache。这将为分层 memory 提供更原生的支持：

- 团队知识作为 shared context block 注入，而非 skill
- 独立 cache breakpoint，修改不影响其他 prompt 缓存
- 真正的 per-turn 注入

当前设计使用 skill 注入作为替代，待此功能合并后可无缝迁移。
