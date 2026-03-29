# Nexu Desktop E2E Automation

Packaged desktop app 的端到端自动化测试。依赖独立安装，不影响主仓库 `pnpm install`。

## Quick Start

```bash
cd e2e/desktop
npm install           # 安装 Playwright（一次性）
npm run download      # 下载最新 nightly DMG + ZIP (~500MB)
npm run test:smoke    # 跑 smoke 验证基本流程
```

## 前置条件

- macOS（ARM64 或 x86_64）
- Node.js >= 22（`nvm install 22`）
- **辅助功能权限**：系统设置 → 隐私与安全性 → 辅助功能 → 给 Terminal / iTerm 开启权限（osascript 自动点击退出弹窗需要）

## 测试模式

| 命令 | 测试内容 |
|------|---------|
| `npm run test:smoke` | DMG 安装 → codesign 验证 → spctl Gatekeeper 检查 → cold start → runtime health |
| `npm run test:login` | Smoke → 点击「使用 nexu 账号」→ 浏览器 OAuth → 等 connected → workspace 跳转 → Agent 运行中 |
| `npm run test:model` | Smoke → fake provider 创建 → model A/B 切换 → 验证 runtime-model.json |
| `npm run test:update` | Smoke → 版本降级 → 本地 update feed → check + download + install |
| `npm test` | 以上全部（full） |
| `npm run cleanup` | 杀掉所有 Nexu 进程、bootout launchd 服务、释放端口 |

## 测试不同的包

### Nightly（默认）

```bash
npm run download && npm test
```

### Beta / Stable

通过环境变量指定下载 URL：

```bash
# Beta
NEXU_DESKTOP_E2E_DMG_URL=https://desktop-releases.nexu.io/beta/arm64/nexu-latest-beta-mac-arm64.dmg \
NEXU_DESKTOP_E2E_ZIP_URL=https://desktop-releases.nexu.io/beta/arm64/nexu-latest-beta-mac-arm64.zip \
npm run download && npm test

# Stable
NEXU_DESKTOP_E2E_DMG_URL=https://desktop-releases.nexu.io/stable/arm64/nexu-latest-stable-mac-arm64.dmg \
NEXU_DESKTOP_E2E_ZIP_URL=https://desktop-releases.nexu.io/stable/arm64/nexu-latest-stable-mac-arm64.zip \
npm run download && npm test
```

### 本地打的包（unsigned）

直接把 DMG 和 ZIP 复制到 `artifacts/` 目录，跳过签名检查：

```bash
# 在主仓库打包
pnpm dist:mac:unsigned:arm64

# 复制到 E2E artifacts
cp apps/desktop/release/*.dmg apps/desktop/release/*.zip e2e/desktop/artifacts/

# 跑测试（跳过 codesign/spctl）
cd e2e/desktop
NEXU_DESKTOP_E2E_SKIP_CODESIGN=true npm run test:model
```

### Login 模式注意事项

`test:login` 需要在浏览器中完成 OAuth 登录：

1. 首次运行时，脚本会自动打开浏览器跳转到 nexu.io 登录页
2. 在浏览器中登录你的 nexu 账号
3. 登录成功后脚本会自动检测到并继续
4. 登录状态保存在 `.tmp/home/`，后续运行会自动复用（不需要重新登录）
5. 如需重新登录，删除 `.tmp/home/.nexu/` 即可

## CI

GitHub Actions workflow: `.github/workflows/desktop-e2e.yml`

### 自动触发

E2E 在以下场景自动运行，**不阻塞** build/release 的状态：

| 触发来源 | 何时触发 | 测什么 |
|----------|---------|--------|
| `desktop-nightly.yml` | Nightly build 完成后 | 下载 nightly 包 → `model` 模式 |
| `desktop-release.yml` | Release 发布完成后 | 下载对应 channel (beta/stable) 包 → `model` 模式 |
| 定时任务 | 每天 03:00 UTC (11:00 CST) | 下载 nightly 包 → `model` 模式 |

Build/Release workflow 完成后会**异步触发** E2E workflow，E2E 的成功/失败不影响 build/release 的绿灯状态。

### 手动触发

在 GitHub Actions 页面手动触发时，可以选择三个参数：

| 参数 | 选项 | 说明 |
|------|------|------|
| **Source** | `download`（默认）/ `build` | `download` 下载已发布的包；`build` 从当前分支本地打包 unsigned 后测试 |
| **Channel** | `nightly`（默认）/ `beta` / `stable` | 仅 `download` 模式有效，决定下载哪个 channel 的包 |
| **Mode** | `smoke` / `login` / `model`（默认）/ `update` / `full` | 选择跑哪些测试场景 |

#### Source = download（测试已发布的包）

```
手动触发 → 下载指定 channel 的签名包 → 跑 E2E
```

典型场景：验证刚发布的 nightly/beta/stable 包是否正常。

#### Source = build（测试当前分支）

```
手动触发 → checkout 当前分支 → pnpm install → 本地打 unsigned 包 → 跑 E2E（跳过签名验证）
```

典型场景：在 feature 分支上验证改动是否影响打包后的行为，不需要先发布。

### 失败诊断

CI 失败后自动上传 `captures/` 为 GitHub Actions artifact（保留 14 天），包含录屏、截图、日志、状态快照。在 Actions run 页面的 Artifacts 区域下载查看。

### Mac mini Self-hosted Runner 部署

```bash
# 首次设置
cd e2e/desktop
npm install

# 确保辅助功能权限已开启（系统设置 → 隐私与安全性 → 辅助功能）
# 需要给 GitHub Actions runner 进程或其父 shell 开启权限

# 日常使用（CI 自动触发，或手动）
npm run download && npm test
```

## 诊断和排错

测试运行时会自动采集诊断信息到 `captures/` 目录：

### 始终采集

| 文件 | 内容 |
|------|------|
| `captures/screen-recording.mov` | 系统级全屏录制（OS 弹窗、浏览器登录、退出对话框全部可见） |
| `captures/packaged-app.log` | Electron 主进程完整日志 |
| `captures/packaged-logs/` | Desktop runtime 日志 |
| `captures/runtime-unit-logs/` | Controller、OpenClaw 各 unit 日志 |
| `captures/codesign-verify.log` | codesign 验证详情 |
| `captures/spctl-assess.log` | Gatekeeper 评估结果 |
| `captures/kill-all.log` | 进程清理日志 |

### 测试结束时采集

| 文件 | 内容 |
|------|------|
| `captures/state-snapshot/dot-nexu/config.json` | nexu 配置（API key 已脱敏） |
| `captures/state-snapshot/openclaw-state/openclaw.json` | OpenClaw 运行时配置 |
| `captures/state-snapshot/openclaw-state/nexu-runtime-model.json` | 当前选中的模型 |
| `captures/state-snapshot/runtime-snapshot.txt` | 进程列表、端口占用、launchd 状态、controller/openclaw health |

### 失败时额外采集

| 文件 | 内容 |
|------|------|
| `captures/failure-screenshot.png` | 失败瞬间的系统截图 |
| `captures/{scenario}-failure-screenshot.png` | Playwright 对 webview 页面的截图 |
| `captures/{scenario}-failure-page.html` | 失败时的页面 HTML |

### 如何排错

1. **看录屏** — `screen-recording.mov` 能看到整个测试过程，包括 OS 弹窗
2. **看截图** — 失败截图能快速定位 UI 状态
3. **看 packaged-app.log** — 搜 `error`、`fail`、`ERR_` 关键字
4. **看状态快照** — `runtime-snapshot.txt` 能看到失败时谁占了什么端口
5. **看 runtime-model.json** — model switch 失败时检查 `selectedModelRef` 值

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NEXU_DESKTOP_E2E_DMG_URL` | nightly arm64 DMG | 要测试的 DMG 下载地址 |
| `NEXU_DESKTOP_E2E_ZIP_URL` | nightly arm64 ZIP | 要测试的 ZIP 下载地址 |
| `NEXU_DESKTOP_E2E_SKIP_CODESIGN` | `false` | 设为 `true` 跳过签名验证（本地 unsigned 包） |

## 项目结构

```
e2e/desktop/
├── package.json              # 入口：npm install / npm test / npm run download
├── .gitignore                # node_modules, artifacts, captures, .tmp
├── README.md
├── scripts/
│   ├── setup.sh              # 环境检查 + Playwright browser 安装
│   ├── download-nightly.sh   # 下载签名构建产物
│   ├── run-e2e.sh            # 主测试入口（bash）
│   └── kill-all.sh           # 清场：launchd + 进程 + 端口
├── tests/
│   └── packaged-e2e.mjs      # Playwright 场景（login、model switch、update）
├── artifacts/                # 下载的 DMG/ZIP（gitignored）
├── captures/                 # 测试日志和诊断（gitignored）
└── .tmp/                     # 持久化 HOME 目录，保存登录状态（gitignored）
```
