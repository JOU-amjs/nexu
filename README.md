# Nexu

OpenClaw 多租户平台 — 让用户创建自己的 AI Bot，一键连接 Slack。

## 架构

```
用户浏览器 → Web (React + Ant Design)
                ↓
          API (Hono + Drizzle + Zod)  ←→  PostgreSQL / Redis
                ↓
          Webhook Router  →  Gateway Pool Pods (OpenClaw)
                                    ↓
                              Slack API
```

**核心思路**：利用 OpenClaw 原生多 Agent + 多 Account + Bindings 路由，一个 Gateway 进程通过配置服务多个用户的 Bot，无需改 OpenClaw 核心代码。

## 目录结构

```
nexu/
├── docs/
│   ├── designs/             # 架构设计
│   └── references/          # 编码参考（API 模式、Config schema、基础设施）
├── experiments/             # 验证实验脚本（已通过）
├── apps/
│   ├── api/                 # Hono + Drizzle + Zod OpenAPI 后端
│   └── web/                 # React + Ant Design 前端
├── packages/
│   └── shared/              # 共享 Zod schema / 类型
└── deploy/
    └── k8s/                 # K8s 部署配置
```

## 技术栈

| Layer | Technology |
|-------|-----------|
| **API** | Hono + @hono/zod-openapi + Drizzle + better-auth |
| **Web** | React + Ant Design + Vite + @hey-api/openapi-ts |
| **Validation** | Zod（全链路类型安全，禁止 any） |
| **Database** | PostgreSQL (dev: SQLite) + Drizzle ORM (no FK) |
| **Gateway Runtime** | OpenClaw (多 Agent 共享进程模式) |
| **Channels** | Slack (共享 App + OAuth) |
| **Lint/Format** | Biome |
| **Package Manager** | pnpm workspaces |
| **Infrastructure** | AWS EKS / RDS / ElastiCache / S3 |

## 开发

```bash
pnpm install
pnpm dev          # 启动所有 apps
pnpm typecheck    # 类型检查
pnpm lint         # Lint
pnpm generate-types  # API schema → 前端 SDK
```

## 相关仓库

- [agent-digital-cowork](https://github.com/refly-ai/agent-digital-cowork) — 产品规划、Spec、原型
- [cloudspec](https://github.com/refly-ai/cloudspec) — 技术栈参考（同栈）
- [openclaw](https://github.com/openclaw/openclaw) — 上游 OpenClaw 项目
- [refly-infra](https://github.com/refly-ai/refly-infra) — 基础设施
