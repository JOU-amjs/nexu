# Electron + OpenClaw 打包调研报告

日期：2026-03-13

## 1. 目的

本文基于对 `QClaw` 与 `AutoClaw` 安装包的拆解，整理它们将 `openclaw` 集成到 Electron 应用中的基本思路、相同点、不同点，以及这些做法对新项目的启发。

本文的目标不是复盘品牌定制细节，而是为新的 `Electron + OpenClaw` 项目提供一份可落地的打包设计参考。

## 2. 结论先行

两个项目都没有把 `openclaw` 简单塞进 `app.asar` 后直接使用，而是把 `openclaw` 作为 **asar 外部的独立运行时** 来管理。

共同思路是：

1. Electron 主应用负责桌面 UI、主进程控制、配置注入与生命周期管理
2. `openclaw` 作为单独的 gateway/runtime 放到 `Contents/Resources` 下
3. `openclaw` 的直接依赖和大部分传递依赖也一起放到 `asar` 外
4. Electron 主进程通过子进程方式拉起 `openclaw`

两者最大的差异在于：

- `QClaw` 更像“外置 npm 项目式运行时”
- `AutoClaw` 更像“独立 Node + 独立 gateway runtime”

如果面向新项目做设计：

- 想快速落地、结构较简单，可以参考 `QClaw`
- 想要更强隔离、更稳定的运行时控制、更方便后续裁剪和运维，可以更偏向 `AutoClaw`

## 3. QClaw 的打包思路

### 3.1 基本结构

`QClaw` 将 `openclaw` 放在：

- `qclaw-dmg-expanded/QClaw.app/Contents/Resources/openclaw`

这个目录本身不是 `openclaw` 包本体，而是一个外置的 npm 项目根，里面有：

- `package.json`
- `package-lock.json`
- `node_modules/`

真正的 `openclaw` 包位于：

- `qclaw-dmg-expanded/QClaw.app/Contents/Resources/openclaw/node_modules/openclaw`

所以它的组织方式更接近：

1. 准备一个单独目录 `Resources/openclaw`
2. 在里面放一个最小宿主 `package.json`
3. 安装 `openclaw` 及其依赖
4. 打包时把整个目录复制到 Electron 应用的 `Resources` 下

### 3.2 启动方式

`QClaw` 主进程并不是直接执行某个独立 `openclaw` 二进制，而是：

1. 解析 `openclaw` 路径为 `Contents/Resources/openclaw/node_modules/openclaw`
2. 定位入口 `openclaw.mjs`
3. 使用一个 Node 可执行体来执行这个入口

从主进程代码看，macOS 下优先使用：

- `QClaw.app/Contents/Frameworks/QClaw Helper.app/Contents/MacOS/QClaw Helper`

否则回退到 `process.execPath`。

实际调用形态接近：

```bash
<QClaw Helper or process.execPath> \
  <Resources/openclaw/node_modules/openclaw/openclaw.mjs> \
  gateway
```

### 3.3 依赖放置方式

- `openclaw` 本体：在 `Resources/openclaw/node_modules/openclaw`
- `openclaw` 的大部分传递依赖：hoist 在 `Resources/openclaw/node_modules`
- 不放在 `app.asar` 内

这意味着 QClaw 把 `openclaw` 视为一个外置 Node 项目运行时，而不是 Electron 主应用本身的一部分。

## 4. AutoClaw 的打包思路

### 4.1 基本结构

`AutoClaw` 将 `openclaw` 放在：

- `autoclaw-dmg-expanded/AutoClaw.app/Contents/Resources/gateway/openclaw`

这个目录本身就是 `openclaw` 包体，直接包含：

- `openclaw.mjs`
- `dist/`
- `docs/`
- `extensions/`
- `skills/`
- `node_modules/`
- `package.json`

与 `QClaw` 不同，`AutoClaw` 没有再套一层 `Resources/openclaw/package.json` 宿主目录，而是把 `openclaw` 自己当成 runtime 根目录。

### 4.2 启动方式

`AutoClaw` 的启动方式更明确，也更独立：

1. 解析 gateway 根目录为 `Contents/Resources/gateway/openclaw`
2. 定位入口 `Contents/Resources/gateway/openclaw/openclaw.mjs`
3. 使用单独打包的 Node 可执行文件启动它

独立 Node 路径为：

- `autoclaw-dmg-expanded/AutoClaw.app/Contents/Resources/node/node`

实际调用形态接近：

```bash
Contents/Resources/node/node \
  --no-warnings \
  Contents/Resources/gateway/openclaw/openclaw.mjs \
  gateway run --port 18789 --bind loopback --force --allow-unconfigured --auth token --token <embedded-token>
```

### 4.3 依赖放置方式

- `openclaw` 包本体：`Contents/Resources/gateway/openclaw`
- 直接依赖和大部分传递依赖：`Contents/Resources/gateway/openclaw/node_modules`
- 独立 Node 运行时：`Contents/Resources/node/node`
- 也不依赖 `app.asar`

因此，`AutoClaw` 的结构更像：

1. Electron UI/主进程
2. 独立 Node runtime
3. 独立 gateway/openclaw runtime

## 5. 相同点

### 5.1 都把 openclaw 放在 asar 外

这是两者最重要的共同点。

原因和收益包括：

- 避免 `asar` 对真实文件路径、动态加载、插件扫描、文档/skills 访问的干扰
- 更方便子进程直接执行 `openclaw.mjs`
- 更方便保留 `openclaw` 的标准 npm 包结构
- 更方便后续做裁剪、替换、热修复或增量更新

### 5.2 都把 openclaw 视为独立运行时

两者都不是把 `openclaw` 当成前端依赖或 Electron 主应用普通依赖来处理，而是当成一个独立 gateway/runtime：

- 有独立入口
- 有独立工作目录
- 有独立状态目录
- 由主进程通过 `spawn` 管理生命周期

### 5.3 openclaw 的传递依赖也都在 asar 外

两个项目都没有只拷贝一个 `openclaw` 包空壳，而是将它的依赖树也作为外部资源打进去。

因此如果新项目要模仿这套思路，必须一起考虑：

- `openclaw` 包本体
- `node_modules`
- 运行所需的配置、扩展、skills、文档、资源文件

### 5.4 都由 Electron 主进程负责启动与管理

两者都在主进程中：

- 拼装资源路径
- 构造启动参数
- 注入环境变量
- 管理子进程 stdout/stderr
- 管理健康检查、重启、停止逻辑

## 6. 不同点

### 6.1 runtime 根目录组织方式不同

`QClaw`：

- `Resources/openclaw` 是一个宿主 npm 项目
- 真正的 `openclaw` 在 `node_modules/openclaw`

`AutoClaw`：

- `Resources/gateway/openclaw` 直接就是 `openclaw` runtime 根
- `openclaw.mjs` 就在根目录

含义：

- `QClaw` 更贴近“安装 npm 包”的思路
- `AutoClaw` 更贴近“分发一套整理好的运行时目录”的思路

### 6.2 Node 运行时来源不同

`QClaw`：

- 优先使用 Electron Helper / `process.execPath`
- 没有单独打包 Node 目录的明确证据

`AutoClaw`：

- 明确单独打包了一份 Node
- 运行时来自 `Contents/Resources/node/node`

含义：

- `QClaw` 更省一层独立 Node 体积，但更依赖 Electron 自身行为
- `AutoClaw` 的 Node 版本和运行特性更可控，运行时边界更清晰

### 6.3 启动命令完整度不同

`QClaw` 的调用更接近：

```bash
node openclaw.mjs gateway
```

`AutoClaw` 的调用更接近：

```bash
node openclaw.mjs gateway run --port ... --bind ... --auth token ...
```

说明 `AutoClaw` 更像把 gateway 当成一个被精细托管的外部服务来跑。

### 6.4 对 openclaw runtime 的改造深度不同

`QClaw` 更偏向：

- 目录层面的外置与裁剪
- 通过宿主层接管配置、状态、品牌、启动流程

`AutoClaw` 更偏向：

- 外置运行时
- 独立 Node
- 更激进的依赖裁剪
- 少量包内 patch / stub / 环境变量注入

## 7. 对新 Electron + OpenClaw 项目的指导意义

### 7.1 不建议默认把 openclaw 直接打进 app.asar

虽然直接依赖 `openclaw` 并随 Electron 一起打进 `app.asar` 可以工作，但它不太适合长期产品化。原因是：

- 难以单独裁剪 `openclaw`
- 难以独立替换 gateway runtime
- 对文件路径、资源扫描、插件/skills 管理不够友好
- 子进程拉起和后续分析不如外置方案直接

如果项目目标只是快速验证，`asar` 内集成可以作为临时方案；如果目标是可维护的桌面产品，建议尽快转向外置 runtime 方案。

### 7.2 推荐把 openclaw 作为外置 runtime 打包

新项目至少可以参考下面的稳定思路：

1. Electron 主应用继续正常打到 `app.asar`
2. 将 `openclaw` runtime 放到 `Contents/Resources` 外置目录
3. 主进程通过 `spawn` 拉起 `openclaw.mjs`
4. 使用环境变量控制 state/config/path/token

推荐的两种实现模型：

#### 模型 A：QClaw 式

目录结构：

```text
Contents/Resources/openclaw/
  package.json
  node_modules/
    openclaw/
    ...dependencies
```

适用场景：

- 希望快速复用 npm 安装结果
- 希望构建脚本简单
- 当前可以接受依赖 Electron Helper/execPath 运行

优点：

- 构建逻辑简单
- 与 npm 目录结构一致
- 容易做初步依赖裁剪

缺点：

- 启动器与 Electron 耦合更高
- 运行时边界不如独立 Node 清晰

#### 模型 B：AutoClaw 式

目录结构：

```text
Contents/Resources/node/node
Contents/Resources/gateway/openclaw/
  openclaw.mjs
  dist/
  node_modules/
  extensions/
  skills/
```

适用场景：

- 希望运行时完全可控
- 希望更稳定地管理 gateway 子进程
- 希望后续对 `openclaw` 进行较深的裁剪、stub、patch

优点：

- Node 版本与行为可控
- gateway 与 Electron 边界更清晰
- 更适合产品化和长期维护

缺点：

- 包体更大
- 构建与发布流程更复杂

### 7.3 新项目建议优先考虑的几个问题

在设计新项目打包方案时，应先回答以下问题：

1. 是否需要把 `openclaw` 当独立服务运行？
2. 是否需要后续对 `openclaw` 的依赖树做裁剪？
3. 是否需要单独控制 Node 版本？
4. 是否会用到大量 skills、extensions、动态资源或真实路径访问？
5. 是否需要未来支持对 gateway runtime 的独立升级？

如果其中大部分答案是“需要”，那就更应采用外置 runtime 方案。

## 8. 实施建议

### 8.1 推荐的新项目默认方案

对于一个新的 `Electron + OpenClaw` 项目，推荐默认从“外置 runtime”起步，而不是从 `app.asar` 集成起步。

推荐优先级：

1. 长期产品：优先 `AutoClaw` 式
2. 快速上线/验证：可先 `QClaw` 式
3. 临时 demo：才考虑把 `openclaw` 放进 `app.asar`

### 8.2 建议的打包步骤

一个比较稳妥的构建流程可以是：

1. 生成 Electron 主应用产物
2. 单独准备 `openclaw` runtime 目录
3. 在该目录内安装并裁剪依赖
4. 如有需要，注入 patch / stub / config
5. 将 runtime 目录复制到 `Contents/Resources`
6. 主进程根据 `process.resourcesPath` 计算入口并 `spawn`

### 8.3 环境变量与运行边界建议

建议由主进程显式设置：

- `OPENCLAW_STATE_DIR`
- `OPENCLAW_CONFIG_PATH`
- gateway token / auth 相关变量
- bundled plugins / bundled skills 相关路径

这样可以把用户状态、应用配置、内置资源三者分离开，避免运行时逻辑散落在多个目录里。

## 9. 最终建议

综合 `QClaw` 与 `AutoClaw` 的做法，可以得出适合新项目的总原则：

- 把 `openclaw` 当成独立 runtime，而不是普通前端依赖
- 尽量放在 `asar` 外，方便启动、裁剪、替换和分析
- Electron 主进程只负责托管，不负责把 gateway 逻辑揉进自身
- 如果希望长期维护，最好进一步采用独立 Node runtime

一句话概括：

> 新的 Electron + OpenClaw 项目，最稳妥的思路不是“把 openclaw 打进 Electron”，而是“让 Electron 托管一个外置的 openclaw runtime”。

## 10. 关键证据路径

### 10.1 QClaw

- `qclaw-dmg-expanded/QClaw.app/Contents/Resources/openclaw/package.json`
- `qclaw-dmg-expanded/QClaw.app/Contents/Resources/openclaw/node_modules/openclaw`
- `qclaw-dmg-analysis/app-asar-extract/out/main/index.js`

### 10.2 AutoClaw

- `autoclaw-dmg-expanded/AutoClaw.app/Contents/Resources/gateway/openclaw/package.json`
- `autoclaw-dmg-expanded/AutoClaw.app/Contents/Resources/gateway/openclaw`
- `autoclaw-dmg-expanded/AutoClaw.app/Contents/Resources/node/node`
- `autoclaw-dmg-analysis/app-asar-extract/out/main/index.js`
