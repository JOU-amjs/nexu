# Nexu 中 OpenClaw 的打包体积现状估算

## OpenClaw 对打包体积的贡献

约定：

- 以 Nexu 当前 pin 的 OpenClaw 版本 2026.3.7 为准（apps/gateway/Dockerfile）
- 假设 “Electron + 内置 OpenClaw + 单架构” 的打包方式
- 不考虑压缩，好计算

估算对 Nexu 打包体积的贡献：约 600MB ~ 700MB

### 口径一：npm install openclaw

```bash
# 1) 拉取 openclaw 包元信息（确认版本）
npm view openclaw@2026.3.7 version dist.unpackedSize

# 2) 单独安装 openclaw（不跑脚本，避免额外噪音）
mkdir -p /tmp/nexu-size-check/install-2026-3-7
cd /tmp/nexu-size-check/install-2026-3-7
npm init -y
npm i openclaw@2026.3.7 --ignore-scripts --no-fund --no-audit

# 3) 量体积
du -sh node_modules
du -sh node_modules/openclaw
```

体积：

- 整个 node_modules：约 667MB
- 其中本体 node_modules/openclaw：约 167MB
- 其余依赖：约 500MB

### 口径二：源码仓库 npm pack + npm install（2026.3.7 分支）

```bash
cd /Users/william/projects/openclaw
npm pack --ignore-scripts

mkdir -p /tmp/nexu-size-check/openclaw-local-pack-2026-3-7
cd /tmp/nexu-size-check/openclaw-local-pack-2026-3-7
npm init -y
npm i /Users/william/projects/openclaw/openclaw-2026.3.7.tgz --ignore-scripts --no-fund --no-audit

du -sh node_modules
du -sh node_modules/openclaw
```

体积：

- 整个 node_modules：约 617MB
- 其中本体 node_modules/openclaw：约 115MB
- 其余依赖：约 502MB

### 口径三：源码仓库 npm install（估算）（2026.3.7 分支）

```bash
rm -rf node_modules package-lock.json && npm install --omit=dev --ignore-scripts --no-fund --no-audit && du -sh node_modules
```

体积：532M