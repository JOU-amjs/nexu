# OpenClaw config.json Schema 参考

Config 生成器必须输出符合此格式的 JSON。OpenClaw gateway 通过 chokidar 监听文件变更自动热加载。

---

## 顶层结构

```jsonc
{
  "gateway":  { /* 必填：服务器配置 */ },
  "agents":   { /* 必填：Agent 列表 */ },
  "channels": { /* 必填：Channel 账号 */ },
  "bindings": [ /* 必填：路由规则 */ ],
  "models":   { /* 可选：LLM provider */ },
  "plugins":  { /* 可选：插件启用 */ }
}
```

---

## gateway

```json
{
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "loopback",
    "auth": { "mode": "token", "token": "gw-secret-token" },
    "reload": { "mode": "hybrid" }
  }
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `port` | number | 18789 | 监听端口 |
| `mode` | `"local"` \| `"remote"` | - | 必须设为 `"local"` |
| `bind` | `"loopback"` \| `"lan"` \| `"auto"` | `"loopback"` | 网络绑定 |
| `auth.mode` | `"none"` \| `"token"` | `"token"` | 认证模式 |
| `auth.token` | string | - | 共享 token（`mode: "token"` 时必填） |
| `reload.mode` | `"off"` \| `"hot"` \| `"hybrid"` | `"hybrid"` | 热加载策略 |

---

## agents

```json
{
  "agents": {
    "defaults": {
      "model": "anthropic/claude-sonnet-4-20250514"
    },
    "list": [
      {
        "id": "tenant-abc",
        "name": "ABC Corp Bot",
        "default": true,
        "workspace": "/data/workspaces/tenant-abc"
      }
    ]
  }
}
```

### agents.list[] 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | **是** | 唯一标识符，用于 `bindings[].agentId` 匹配 |
| `name` | string | 否 | 显示名称 |
| `default` | boolean | 否 | 标记为默认 agent（最多一个） |
| `workspace` | string | 否 | 工作目录路径 |
| `model` | string \| `{ primary, fallbacks }` | 否 | 模型覆盖 |

---

## channels

### 飞书 (feishu)

```json
{
  "channels": {
    "feishu": {
      "accounts": {
        "feishu-tenant-abc": {
          "enabled": true,
          "appId": "cli_a1b2c3d4",
          "appSecret": "secret_value",
          "connectionMode": "websocket"
        }
      }
    }
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | boolean | 启用/禁用 |
| `appId` | string | 飞书应用 ID |
| `appSecret` | string | 飞书应用密钥 |
| `connectionMode` | `"websocket"` \| `"webhook"` | 连接模式。webhook 模式需额外设 `verificationToken` |
| `verificationToken` | string | webhook 验证 token（webhook 模式必填） |
| `webhookPath` | string | webhook 路径（如 `/feishu/events/tenant-abc`） |
| `domain` | `"feishu"` \| `"lark"` | API 域名（国内用 feishu，国际用 lark） |
| `dmPolicy` | `"open"` \| `"pairing"` \| `"allowlist"` | 私聊策略 |
| `groupPolicy` | `"open"` \| `"allowlist"` \| `"disabled"` | 群聊策略 |

### Slack

```json
{
  "channels": {
    "slack": {
      "accounts": {
        "slack-team-T123": {
          "enabled": true,
          "botToken": "xoxb-...",
          "signingSecret": "abc123",
          "mode": "http",
          "webhookPath": "/slack/events/team-T123"
        }
      }
    }
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | boolean | 启用/禁用 |
| `botToken` | string | Bot token (`xoxb-...`)，始终必填 |
| `appToken` | string | App-level token (`xapp-...`)，Socket 模式必填 |
| `signingSecret` | string | Signing secret，HTTP 模式必填 |
| `mode` | `"socket"` \| `"http"` | 连接模式。多租户推荐 `"http"` |
| `webhookPath` | string | HTTP 模式的 webhook 路径 |
| `dmPolicy` | `"pairing"` \| `"allowlist"` \| `"open"` | 私聊策略 |
| `groupPolicy` | `"open"` \| `"allowlist"` \| `"disabled"` | 频道消息策略 |

---

## bindings

路由规则：将 channel 消息分发到指定 agent。

```json
{
  "bindings": [
    {
      "agentId": "tenant-abc",
      "match": {
        "channel": "feishu",
        "accountId": "feishu-tenant-abc"
      }
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | **是** | 必须匹配 `agents.list[].id` |
| `match.channel` | string | **是** | channel 类型（`"feishu"`, `"slack"` 等） |
| `match.accountId` | string | 推荐 | 必须匹配 `channels.<type>.accounts` 的 key |

### 路由优先级（从高到低）

1. peer 精确匹配（channel + account + peer）
2. guild + roles（Discord）
3. guild（Discord）
4. team（Slack）
5. **account（最常用：channel + accountId）**
6. channel 通配（`accountId: "*"`）
7. 默认 agent

---

## 完整示例：3 租户（2 飞书 + 1 Slack）

```json
{
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "lan",
    "auth": { "mode": "token", "token": "gw-secret-2026" },
    "reload": { "mode": "hybrid" }
  },
  "agents": {
    "defaults": {
      "model": "anthropic/claude-sonnet-4-20250514"
    },
    "list": [
      {
        "id": "acme-corp",
        "name": "Acme Corp Bot",
        "default": true,
        "workspace": "/data/workspaces/acme-corp"
      },
      {
        "id": "globex-inc",
        "name": "Globex Inc Bot",
        "workspace": "/data/workspaces/globex-inc"
      },
      {
        "id": "initech-llc",
        "name": "Initech LLC Bot",
        "workspace": "/data/workspaces/initech-llc",
        "model": { "primary": "openai/gpt-4o" }
      }
    ]
  },
  "channels": {
    "feishu": {
      "accounts": {
        "feishu-acme": {
          "enabled": true,
          "appId": "cli_a1b2c3d4e5",
          "appSecret": "secret_acme"
        },
        "feishu-globex": {
          "enabled": true,
          "appId": "cli_f6g7h8i9j0",
          "appSecret": "secret_globex",
          "domain": "lark"
        }
      }
    },
    "slack": {
      "accounts": {
        "slack-initech": {
          "enabled": true,
          "botToken": "xoxb-initech-token",
          "signingSecret": "initech-signing-secret",
          "mode": "http",
          "webhookPath": "/slack/events/initech"
        }
      }
    }
  },
  "bindings": [
    { "agentId": "acme-corp",   "match": { "channel": "feishu", "accountId": "feishu-acme" } },
    { "agentId": "globex-inc",  "match": { "channel": "feishu", "accountId": "feishu-globex" } },
    { "agentId": "initech-llc", "match": { "channel": "slack",  "accountId": "slack-initech" } }
  ],
  "plugins": {
    "entries": {
      "feishu": { "enabled": true }
    }
  }
}
```

---

## 常见坑点

1. **`accountId` 是 accounts 对象的 key，不是 appId**
   ```
   正确: "accountId": "feishu-acme"     (匹配 accounts.feishu-acme)
   错误: "accountId": "cli_a1b2c3d4e5"  (这是 appId，不是 key)
   ```

2. **`agentId` 大小写不敏感**，内部会 normalize 为小写

3. **省略 `accountId` 匹配的是 "default" 账号**，不是通配。通配用 `"*"`

4. **飞书 webhook 模式必须设 `verificationToken`**，否则 schema 校验报错

5. **Slack HTTP 模式必须设 `signingSecret`**，Socket 模式必须设 `appToken`

6. **`workspace` 目录必须存在**，gateway 不会自动创建

7. **`plugins.entries.feishu.enabled: true`** 是必需的，否则飞书插件不加载

8. **一个 config 中只能有一个 `default: true` 的 agent**
