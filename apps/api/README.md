# @nexu/api

Hono + Drizzle + Zod OpenAPI 后端。

## 职责

- Bot CRUD（创建/更新/删除用户的 bot）
- Channel 连接管理（Slack OAuth、飞书凭证）
- Gateway 池管理（分配 bot 到 Pod、Config 生成）
- 用量追踪和配额管理

## 技术栈

- **Hono** + `@hono/zod-openapi` — Type-safe API routes
- **Drizzle ORM** — Type-safe DB (no FK)
- **Zod** — Validation + type source
- **better-auth** — Authentication
- **PostgreSQL** (dev: SQLite)

## 开发

```bash
pnpm --filter @nexu/api dev
```
