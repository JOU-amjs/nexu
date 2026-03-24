# Desktop 启动流程

本文档描述 Nexu Desktop 的完整启动流程。适用于本地开发（`pnpm start`）和打包版（Nexu.app），两者共用同一套 launchd bootstrap 代码，区别仅在于路径解析和构建阶段。

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│ Electron BrowserWindow                                       │
│  └─ file://...desktop/dist/index.html  (desktop shell)      │
│       └─ <webview src="http://127.0.0.1:50810/workspace">   │
│            └─ API → 50810/api/* → proxy → controller:50800   │
├─────────────────────────────────────────────────────────────┤
│ Embedded Web Server (:50810)                                 │
│  ├─ 静态文件: apps/web/dist/*                                │
│  ├─ API 代理: /api/* → controller:50800                      │
│  └─ Mock auth: /api/auth/get-session → desktop local session │
├─────────────────────────────────────────────────────────────┤
│ launchd LaunchAgents                                         │
│  ├─ io.nexu.controller.dev  → Controller (:50800)            │
│  └─ io.nexu.openclaw.dev    → OpenClaw Gateway (:18789)      │
└─────────────────────────────────────────────────────────────┘
```

## 启动模式

| 模式 | 命令 | 说明 |
|------|------|------|
| **Launchd** | `pnpm start` | 生产行为。build → launchd 服务 → Electron。自带 controller file watch |
| **Orchestrator** | `pnpm --filter @nexu/desktop dev` | 前端开发用。vite HMR，tmux 编排 |
| **Packaged** | 打开 Nexu.app | 和 launchd 模式一致，macOS 默认启用 |

## Launchd 模式启动流程 (`pnpm start`)

### Phase 1: 构建 (dev-launchd.sh)

```
pnpm start
  └─ dev-launchd.sh start
       ├─ full_cleanup()          # 杀残留进程，bootout 旧 launchd 服务
       ├─ pnpm build              # 构建 shared → controller → web
       ├─ pnpm --filter @nexu/desktop build  # 构建 desktop shell（如需要）
       └─ purge_plists()          # 删旧 plist 文件
```

### Phase 2: 启动 Electron + launchd 服务

```
Electron main process 启动
  ├─ allocateDesktopRuntimePorts()   # 动态端口分配
  │    ├─ controller: 50800
  │    ├─ web: 50810
  │    └─ openclaw: 18789
  ├─ createMainWindow()              # 创建窗口，loadFile(dist/index.html)
  └─ runLaunchdColdStart()           # launchd bootstrap
       ├─ resolveLaunchdPaths()      # 解析二进制路径
       │    └─ (打包版) ensurePackagedOpenclawSidecar()  # 解压 tar
       └─ bootstrapWithLaunchd()
            ├─ 生成 controller plist  ─┐
            ├─ 生成 openclaw plist    ─┤── 并行
            ├─ 注册 + 启动服务         ─┤
            └─ startEmbeddedWebServer()┘
                 ├─ 静态文件: apps/web/dist/
                 ├─ API 代理: /api/* → controller
                 └─ Mock auth: /api/auth/get-session
```

### Phase 3: Controller 就绪

```
waitForControllerReadiness()
  ├─ 轮询 /health (自适应: 50ms → 250ms)
  └─ Controller 启动完成 (~2s)
       ├─ bootstrapController()
       │    ├─ prepare() + ensureRuntimeModelPlugin() + cloudModels  ──── 并行
       │    ├─ ensureValidDefaultModel()
       │    ├─ syncAllImmediate()         # 写 openclaw.json + skills
       │    ├─ openclawProcess.start()    # (launchd 模式下为空操作)
       │    ├─ wsClient.connect()         # WS 连接 OpenClaw gateway
       │    └─ startBackgroundLoops()     # health loop + sync loop
       └─ bootPhase: "booting" → "ready"  (WS 首次连接成功后)
```

### Phase 4: OpenClaw Gateway 就绪

```
OpenClaw gateway 启动 (~5-7s)
  ├─ 读取 openclaw.json
  ├─ 加载插件: feishu, openclaw-weixin, nexu-runtime-model, nexu-platform-bootstrap
  ├─ 启动 channels: feishu (WebSocket), weixin (long-polling)
  └─ Gateway WS 可达 → Controller WS 连接成功

Health loop 检测到 gateway 可达 → wsClient.retryNow() → 立即连接
```

### Phase 5: 界面渲染

```
Desktop Shell (file://...dist/index.html)
  ├─ 四色 Nexu Logo 动画 (loader overlay)
  ├─ 轮询 /api/internal/desktop/ready (每 2s)
  │    └─ controllerReady = true → 设置 webview src
  ├─ <webview> 加载 http://127.0.0.1:50810/workspace
  │    ├─ /api/auth/get-session → mock desktop session
  │    ├─ AuthLayout → session 验证通过
  │    └─ HomePage 渲染
  └─ webview did-finish-load → loader 消失 → 界面可见
```

## 状态流转

```
启动时序:
  status: starting → starting → active
  gateway: starting → starting → active (WS 连接成功)
  channels: connecting → connecting → connected
  bootPhase: booting → ready (WS 首次连接后)

界面状态:
  Nexu Alpha: "正在启动" (黄) → "运行中" (绿)
  Channels: "连接中" (黄) → "已连接" (绿)
  Agent: "启动中" (黄) → "运行中" (绿)
```

## 端口架构

| 组件 | 端口 | 来源 |
|------|------|------|
| Controller HTTP | 50800 | plist `PORT` env |
| OpenClaw Gateway | 18789 | `env.openclawGatewayPort` → `openclaw.json gateway.port` |
| Embedded Web Server | 50810 | `runtimeConfig.ports.web` |

所有 OpenClaw 端口统一从 `env.openclawGatewayPort`（默认 18789）取值。

## File Watch (自动热更新)

`pnpm start` 启动后自动监听文件变化：

| 改动 | 监听方式 | 生效方式 | 延迟 |
|------|---------|---------|------|
| Controller (`apps/controller/src/`) | `tsc --watch` | `launchctl kickstart -k` 重启服务 | ~2-3s |
| Web UI (`apps/web/src/`) | polling (3s) | `pnpm --filter @nexu/web build` | ~5-8s |
| Desktop Shell (`apps/desktop/src/`) | 无自动监听 | 需要 `pnpm restart` | ~20s |

## 退出行为

### Dev 模式 (`pnpm start`)
- 关闭窗口 / Dock 退出 → Electron 退出
- `dev-launchd.sh` 的 trap 自动执行 `stop_services`（bootout launchd 服务）

### 打包版
- 关闭窗口 → 弹出对话框：
  - **完全退出**: bootout 所有 launchd 服务 → 退出 app
  - **后台运行**: 隐藏窗口，服务继续运行，Dock 点击恢复
  - **取消**: 不做任何操作

## 关键文件

| 文件 | 职责 |
|------|------|
| `scripts/dev-launchd.sh` | Dev 启动脚本 (build + launchd + watch) |
| `apps/desktop/main/index.ts` | Electron main process 入口 |
| `apps/desktop/main/services/launchd-bootstrap.ts` | launchd 服务注册 + 启动 |
| `apps/desktop/main/services/plist-generator.ts` | 生成 launchd plist XML |
| `apps/desktop/main/services/embedded-web-server.ts` | 嵌入式 HTTP 服务器 |
| `apps/desktop/main/services/quit-handler.ts` | 退出对话框 + 服务清理 |
| `apps/desktop/main/services/launchd-manager.ts` | launchctl 命令封装 |
| `apps/controller/src/app/bootstrap.ts` | Controller bootstrap |
| `apps/controller/src/runtime/state.ts` | RuntimeState + bootPhase |
| `apps/controller/src/runtime/loops.ts` | Health loop + sync loop |
| `apps/desktop/src/components/surface-frame.tsx` | 四色 loader + webview |
