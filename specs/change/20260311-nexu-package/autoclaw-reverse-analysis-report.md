# AutoClaw 逆向分析报告

日期：2026-03-12

## 1. 执行摘要

- `AutoClaw` 是一个基于 Electron 打包的桌面应用，包标识为 `com.zhipuai.autoclaw`。
- 它的核心运行时明确打包了官方 `openclaw/openclaw` 项目的 `openclaw`，内置版本为 `2026.2.19-2`。
- 从安装包证据看，`AutoClaw` 与 `QClaw` 一样，都是“官方 OpenClaw + 桌面宿主 + 运行时裁剪”的发行模型，而不是另起炉灶的独立 runtime。
- 但 `AutoClaw` 与 `QClaw` 的实现机制并不完全相同：
  - `QClaw` 更像是“官方 npm 包 + 依赖树删减 + 包外集成层”；
  - `AutoClaw` 则是“官方 npm 包 + 更激进的依赖裁剪/stub 替换 + 少量包内 patch + 包外集成层”。
- 以 `openclaw` 依赖树体积为标准，`AutoClaw` 的裁剪力度比 `QClaw` 更大：
  - `QClaw` 约裁掉 `58.4%`
  - `AutoClaw` 约裁掉 `70.9%`
- `AutoClaw` 安装包却明显更大，主要不是因为 `openclaw` 更胖，而是因为外围资源显著更多，尤其是：
  - 巨大的 `app.asar`
  - 独立的 `Resources/skills`
  - 浏览器扩展资源 `Resources/chrome-ext`
  - 较大的独立 Node 运行时目录 `Resources/node`

## 2. 分析范围与方法

本次分析对象：

- DMG 安装包：`autoclaw-0.2.14.dmg`
- 挂载 DMG 后的应用内容：`/Volumes/AutoClaw 0.2.14-arm64/AutoClaw.app`
- 为对照创建的干净 npm 安装目录：`autoclaw-dmg-analysis/npm-openclaw-2026.2.19-2`
- 参考对比报告：`qclaw-dmg-analysis/qclaw-reverse-analysis-report.md`

使用的方法：

- 挂载 DMG 并检查目录结构
- 读取 `Info.plist` 与内置 `openclaw/package.json`
- 对比目录体积
- 对内置 `openclaw@2026.2.19-2` 与干净 npm 安装的同版本进行文件级 hash 对比
- 对内置依赖树与干净 npm 依赖树做顶层包差异和体积差异分析

说明：

- 与 `QClaw` 完全相同的通用 Electron 特征不再展开赘述，只保留关键结论和与 `QClaw` 的差异点。

## 3. 整体架构

### 3.1 高层结构

`AutoClaw` 可粗分为四层：

1. Electron 桌面宿主层
2. 内置 `openclaw` 网关运行时层
3. AutoClaw 自有技能与浏览器扩展层
4. AutoClaw 自身的前端 / 主进程逻辑层

### 3.2 Electron 宿主层

证据：

- `AutoClaw.app/Contents/Info.plist`
- `AutoClaw.app/Contents/Resources/app.asar`

观察结果：

- `CFBundleIdentifier`：`com.zhipuai.autoclaw`
- `CFBundleShortVersionString`：`0.2.14`
- `Info.plist` 中存在 `ElectronAsarIntegrity`

这说明它同样是标准 Electron 打包应用。

### 3.3 OpenClaw 运行时层

证据：

- `AutoClaw.app/Contents/Resources/gateway/openclaw/package.json`
- `AutoClaw.app/Contents/Resources/gateway/openclaw/openclaw.mjs`

观察结果：

- `openclaw` 运行时被放在 `Resources/gateway/openclaw` 下，而不是像 `QClaw` 那样放在 `Resources/openclaw/node_modules/openclaw`
- 它仍然保留了 `dist/`、`docs/`、`extensions/`、`skills/` 等标准 npm 包结构
- 包中仍存在官方 `openclaw` 的 CLI 入口与构建产物

### 3.4 AutoClaw 的外围资源层

证据：

- `AutoClaw.app/Contents/Resources/skills`
- `AutoClaw.app/Contents/Resources/chrome-ext`
- `AutoClaw.app/Contents/Resources/node`
- `AutoClaw.app/Contents/Resources/app.asar`

观察结果：

- `AutoClaw` 在 `openclaw` 之外，还携带了一整套独立 skills 目录
- 还额外打包了浏览器扩展 CRX 文件
- 存在较大的独立 Node 运行时目录
- 主应用逻辑本身也明显比 `QClaw` 更大

这些外围资源，是它整体包体显著大于 `QClaw` 的主要原因。

## 4. OpenClaw 来源与版本

### 4.1 打包的是哪个项目？

`AutoClaw` 内置的包明确是官方 OpenClaw npm 包。

证据来自 `AutoClaw.app/Contents/Resources/gateway/openclaw/package.json`：

- `name`：`openclaw`
- `version`：`2026.2.19-2`
- `repository.url`：`git+https://github.com/openclaw/openclaw.git`

### 4.2 是否打包了 `zeroclaw`？

没有发现 `zeroclaw` 证据。

### 4.3 内置 OpenClaw 版本

- `AutoClaw` 内置的是 `openclaw@2026.2.19-2`

## 5. 体积清单

以下体积均为本次分析环境中的实测值。

### 5.1 AutoClaw DMG 与安装后应用体积

| 对象 | 大小 KB | 约 MiB |
|---|---:|---:|
| `autoclaw-0.2.14.dmg` | 344,116 KB | 336.1 MiB |
| `AutoClaw.app` | 921,188 KB | 899.6 MiB |
| `Resources/app.asar` | 144,420 KB | 141.0 MiB |
| `Resources/app.asar.unpacked` | 11,824 KB | 11.5 MiB |
| `Resources/gateway` | 261,348 KB | 255.2 MiB |
| `Resources/skills` | 103,072 KB | 100.7 MiB |
| `Resources/node` | 106,256 KB | 103.8 MiB |
| `Resources/chrome-ext` | 48,200 KB | 47.1 MiB |

### 5.2 `Resources/skills` 的主要大项

| 对象 | 大小 KB | 约 MiB |
|---|---:|---:|
| `autoglm-browser-agent` | 62,875 KB | 61.4 MiB |
| `feishu-doc-1.2.7` | 35,542 KB | 34.7 MiB |
| 其余 skills 合计 | 4,655 KB | 4.5 MiB |

说明：

- `Resources/skills` 本身就占了约 `100.7 MiB`
- 其中两个技能几乎解释了全部体积

### 5.3 `Resources/gateway/openclaw` 体积拆分

| 对象 | 大小 KB | 约 MiB |
|---|---:|---:|
| `gateway/openclaw` 总计 | 261,348 KB | 255.2 MiB |
| `gateway/openclaw/node_modules` | 181,360 KB | 177.1 MiB |
| `gateway/openclaw/dist` | 31,236 KB | 30.5 MiB |
| `gateway/openclaw/extensions` | 48,256 KB | 47.1 MiB |
| `gateway/openclaw` 非根 `node_modules` 内容 | 79,988 KB | 78.1 MiB |

### 5.4 `gateway/openclaw/extensions` 的主要大项

| 对象 | 大小 KB | 约 MiB |
|---|---:|---:|
| `extensions/feishu` | 40,539 KB | 39.6 MiB |

### 5.5 干净 npm 安装：`openclaw@2026.2.19-2`

目录：`autoclaw-dmg-analysis/npm-openclaw-2026.2.19-2`

| 对象 | 大小 KB | 约 MiB |
|---|---:|---:|
| `node_modules` 总计 | 622,268 KB | 607.7 MiB |
| `node_modules/openclaw` | 91,076 KB | 88.9 MiB |
| `node_modules/openclaw/dist` | 39,096 KB | 38.2 MiB |
| `node_modules/openclaw/extensions` | 31,548 KB | 30.8 MiB |

## 6. 与 QClaw 的体积对比

### 6.1 总体体积对比

| 指标 | QClaw | AutoClaw | 差值 |
|---|---:|---:|---:|
| DMG | 158.4 MiB | 336.1 MiB | +177.7 MiB |
| 安装后 App | 491.7 MiB | 899.6 MiB | +407.9 MiB |

### 6.2 `openclaw` 运行时体积对比

| 指标 | QClaw | AutoClaw | 差值 |
|---|---:|---:|---:|
| 内置 `openclaw` 运行时目录 | 264.4 MiB | 255.2 MiB | -9.2 MiB |
| 内置 `openclaw/node_modules` | 254.5 MiB | 177.1 MiB | -77.4 MiB |

结论：

- `AutoClaw` 的整体应用更大，但其内置 `openclaw` 运行时其实略小于 `QClaw`
- 因此，`AutoClaw` 变大的主要原因不在 `openclaw`，而在包外资源

### 6.3 非 `openclaw` 资源的差异来源

`AutoClaw` 相比 `QClaw` 的额外大项主要包括：

- 更大的 `app.asar`：约 `141.0 MiB` vs `7.9 MiB`
- 独立的 `Resources/skills`：约 `100.7 MiB`
- 独立的 `Resources/node`：约 `103.8 MiB`
- 浏览器扩展资源 `Resources/chrome-ext`：约 `47.1 MiB`

其中仅 `app.asar` 一项，就足以解释 `AutoClaw` 相比 `QClaw` 的大部分增量。

## 7. 裁剪力度：AutoClaw vs QClaw

### 7.1 以 `openclaw` 依赖树为标准的裁剪比例

| 指标 | QClaw | AutoClaw |
|---|---:|---:|
| 干净 npm `node_modules` | 626.7 MiB | 607.7 MiB |
| 内置运行时 `node_modules` | 254.5 MiB | 177.1 MiB |
| 裁掉体积 | 372.2 MiB | 430.6 MiB |
| 保留比例 | 41.6% | 29.1% |
| 裁剪比例 | 58.4% | 70.9% |

结论：

- 如果只看 `openclaw` 依赖树，`AutoClaw` 的裁剪明显比 `QClaw` 更激进

### 7.2 对 `openclaw` 包本体的裁剪

| 指标 | 干净 npm | AutoClaw 内置 |
|---|---:|---:|
| `openclaw` 包本体（不含根 `node_modules`） | 88.9 MiB | 78.1 MiB |

这说明 `AutoClaw` 不仅裁剪依赖树，也裁剪了包本体中的文件内容。

## 8. 同版本对比：本地 npm `2026.2.19-2` vs AutoClaw 内置 `2026.2.19-2`

### 8.1 顶层依赖树差异

对 `node_modules` 顶层包名集合的比较结果：

- 干净 npm 顶层包数：`577`
- AutoClaw 内置顶层包数：`573`
- 仅本地存在：`7`
- 仅 AutoClaw 存在：`3`

#### 仅本地存在的代表项

- `openclaw`
- `@img/colour`
- `@img/sharp-libvips-darwin-arm64`
- `fast-xml-builder`
- `json-with-bigint`
- `path-expression-matcher`

#### 仅 AutoClaw 存在的代表项

- `@aws-sdk/client-sso`
- `gtoken`
- `picocolors`

说明：

- AutoClaw 的差异仍以删减为主
- 但相比 `QClaw`，它也多带入了少量额外包

### 8.2 大型依赖的处理方式

和 `QClaw` 直接移除大型可选依赖不同，`AutoClaw` 对部分大型依赖采用了“stub 占位”方式。

典型例子：

- `gateway/openclaw/node_modules/koffi`
- `gateway/openclaw/node_modules/pdfjs-dist`
- `gateway/openclaw/node_modules/node-llama-cpp`

这些目录只保留极小的 `index.js` 与 `package.json`，其内容明确声明自己是 stub，例如：

- `koffi/package.json`：`version: 0.0.0-stub`
- `koffi/index.js`：声明“real koffi not needed for headless gateway operation”
- `pdfjs-dist/index.js`：访问时抛出 “not available in this build”
- `node-llama-cpp/index.js`：访问时抛出 “not available in this build”

这意味着：

- `AutoClaw` 并非简单地删除这些依赖
- 它更像是用“可解析、但不可实际工作”的占位包来维持 import/require 解析和错误处理路径

### 8.3 大型共享包的体积缩减

以下是若干代表性包在干净 npm 与 AutoClaw 内置之间的体积差异：

| 包名 | 干净 npm | AutoClaw | 差值 |
|---|---:|---:|---:|
| `koffi` | 85.2 MiB | ~0 MiB（stub） | -85.2 MiB |
| `pdfjs-dist` | 38.7 MiB | ~0 MiB（stub） | -38.7 MiB |
| `node-llama-cpp` | 29.8 MiB | ~0 MiB（stub） | -29.8 MiB |
| `playwright-core` | 8.9 MiB | ~0 MiB | -8.9 MiB |
| `@google/genai` | 11.5 MiB | 4.2 MiB | -7.3 MiB |
| `@larksuiteoapi/node-sdk` | 24.3 MiB | 9.2 MiB | -15.1 MiB |

可见最主要的体积节省，依旧来自大型依赖和大型依赖子树的裁剪。

## 9. `openclaw` 包内文件对比

对比目录：

- 本地：`autoclaw-dmg-analysis/npm-openclaw-2026.2.19-2/node_modules/openclaw`
- AutoClaw 内置：`AutoClaw.app/Contents/Resources/gateway/openclaw`

说明：

- 这里的 hash 对比排除了根 `node_modules`
- 因此它反映的是 `openclaw` 包本体文件，而不是外围依赖树

对比结果：

- 本地文件数：`3,618`
- AutoClaw 内置文件数：`950`
- 公共文件数：`949`
- 公共文件中 hash 不同的文件数：`13`
- 仅本地存在的文件数：`2,669`
- 仅 AutoClaw 存在的文件数：`1`

### 9.1 与 QClaw 的关键不同

`QClaw` 的强证据是：保留下来的公共文件 hash 全部一致，差异几乎全部来自“删减”。

`AutoClaw` 则不同：

- 它既做大量删减
- 也确实直接修改了少量 `openclaw` 包内文件

因此，`AutoClaw` 对 `openclaw` 的处理比 `QClaw` 更深入一层。

### 9.2 hash 存在差异的文件

13 个 hash 差异文件主要分三类。

#### A. 文档模板改写

- `docs/reference/templates/AGENTS.md`
- `docs/reference/templates/BOOTSTRAP.md`
- `docs/reference/templates/SOUL.md`
- `docs/reference/templates/TOOLS.md`

观察结果：

- 加入了针对 `autoglm-browser-agent` 的强制使用规则
- 明确要求所有浏览器任务通过 `mcporter` / `browser_subagent` 完成
- 这不是简单品牌替换，而是对 agent 行为约束模板的直接 patch

#### B. OpenClaw 构建产物改写

- `dist/pi-embedded-CHb5giY2.js`
- `dist/pi-embedded-Cn8f5u97.js`
- `dist/reply-B4B0jUCM.js`
- `dist/subagent-registry-DOZpiiys.js`
- `dist/plugin-sdk/reply-Bsg9j6AP.js`

观察结果：

- 这些差异与浏览器技能、回复链路和嵌入式运行逻辑相关
- 它们说明 AutoClaw 不只是删文件，也改了部分构建产物

#### C. Feishu 扩展改写

- `extensions/feishu/package.json`
- `extensions/feishu/src/bot.ts`
- `extensions/feishu/src/reply-dispatcher.ts`
- `extensions/feishu/src/streaming-card.ts`

观察结果：

- 这些改动主要与流式卡片、异常反馈、dispatch 生命周期有关
- 说明 `AutoClaw` 对 `feishu` 扩展做了定制修补

## 10. 可选依赖与降级路径

在 `AutoClaw` 内置的 `dist/*.js` 中，仍然保留了对这些可选依赖的引用：

- `node-llama-cpp`
- `pdfjs-dist`

例如：

- `dist/manager-CIjpkmRY.js` 中仍有 `import("node-llama-cpp")`
- `dist/reply-B4B0jUCM.js` 中仍有 `import("pdfjs-dist/legacy/build/pdf.mjs")`

解释：

- AutoClaw 似乎依然依赖 OpenClaw 原本的“可选依赖缺失 / 延迟失败”路径
- 但相比 `QClaw` 的“直接缺失”，它更进一步提供了 stub 包以确保解析阶段更平滑

## 11. 为什么 AutoClaw 比 QClaw 更大

这一点最容易误判。

### 11.1 不是因为 `openclaw` 更大

相反：

- `AutoClaw` 的 `gateway/openclaw` 总体积略小于 `QClaw` 的 `Resources/openclaw`
- `AutoClaw` 的 `gateway/openclaw/node_modules` 也明显小于 `QClaw`

### 11.2 真正的大头在外围资源

最主要的额外体积来自：

1. `Resources/app.asar`：约 `141.0 MiB`
2. `Resources/skills`：约 `100.7 MiB`
3. `Resources/node`：约 `103.8 MiB`
4. `Resources/chrome-ext`：约 `47.1 MiB`

其中：

- `Resources/skills/autoglm-browser-agent` 约 `61.4 MiB`
- `Resources/skills/feishu-doc-1.2.7` 约 `34.7 MiB`

这说明 `AutoClaw` 的体积策略和 `QClaw` 不同：

- `QClaw` 更像“轻壳 + 内置 runtime”
- `AutoClaw` 更像“较重宿主 + 较多外置技能 + 浏览器自动化资产 + 内置 runtime”

## 12. AutoClaw 与 QClaw 的机制异同

### 12.1 相同点

- 都以内置官方 `openclaw` 作为底座
- 都对运行时依赖树做了 pruning
- 都把品牌化逻辑、配置和产品能力叠加在 `openclaw` 之外
- 都没有证据表明以 `zeroclaw` 作为核心运行时

### 12.2 不同点

#### A. `openclaw` 放置位置不同

- `QClaw`：`Resources/openclaw/node_modules/openclaw`
- `AutoClaw`：`Resources/gateway/openclaw`

#### B. 裁剪手法不同

- `QClaw` 更像“删减型”
- `AutoClaw` 更像“删减 + stub 替换型”

#### C. 对 `openclaw` 包内文件的修改程度不同

- `QClaw` 现有证据支持“公共文件不改，只取子集”
- `AutoClaw` 现有证据支持“多数文件删减，但少量文件直接 patch”

#### D. 外围产品能力布局不同

- `QClaw` 的定制更集中在桌面宿主、配置、wrapper 与状态管理
- `AutoClaw` 则明显在外部资源层投入更多：
  - 独立技能仓
  - 浏览器自动化技能
  - 浏览器扩展 CRX
  - 更重的主应用逻辑与 Node 运行时

## 13. 最终判断

仅依据安装包证据，最合理的技术判断是：

- `AutoClaw` 与 `QClaw` 一样，都是以官方 `openclaw` npm 包为底座的定制桌面发行版。
- `AutoClaw` 同样存在明显的运行时依赖裁剪，而且裁剪力度比 `QClaw` 更大。
- 但 `AutoClaw` 不止做 pruning，还对少量 `openclaw` 包内文件和 `feishu` 扩展做了直接 patch，并对若干大型依赖采用了 stub 占位策略。
- 因此，`AutoClaw` 相比 `QClaw`，对 `openclaw` 的集成方式更“深入”，但整体仍然不像是长期维护的大规模源码 fork。
- 更准确的描述是：
  - 以官方 `openclaw@2026.2.19-2` 为底座
  - 对依赖树和包内容做更激进的 pruning
  - 对少量功能点做定制 patch
  - 在包外叠加较重的技能、浏览器自动化和宿主层资源

## 14. 关键证据路径

- `autoclaw-0.2.14.dmg`
- `AutoClaw.app/Contents/Info.plist`
- `AutoClaw.app/Contents/Resources/app.asar`
- `AutoClaw.app/Contents/Resources/gateway/openclaw/package.json`
- `AutoClaw.app/Contents/Resources/gateway/openclaw/openclaw.mjs`
- `AutoClaw.app/Contents/Resources/gateway/openclaw/node_modules/koffi/index.js`
- `AutoClaw.app/Contents/Resources/gateway/openclaw/node_modules/pdfjs-dist/index.js`
- `AutoClaw.app/Contents/Resources/gateway/openclaw/node_modules/node-llama-cpp/index.js`
- `AutoClaw.app/Contents/Resources/gateway/openclaw/docs/reference/templates/AGENTS.md`
- `AutoClaw.app/Contents/Resources/gateway/openclaw/docs/reference/templates/BOOTSTRAP.md`
- `AutoClaw.app/Contents/Resources/gateway/openclaw/docs/reference/templates/SOUL.md`
- `AutoClaw.app/Contents/Resources/gateway/openclaw/docs/reference/templates/TOOLS.md`
- `AutoClaw.app/Contents/Resources/gateway/openclaw/extensions/feishu/src/bot.ts`
- `AutoClaw.app/Contents/Resources/gateway/openclaw/extensions/feishu/src/reply-dispatcher.ts`
- `AutoClaw.app/Contents/Resources/gateway/openclaw/extensions/feishu/src/streaming-card.ts`
- `AutoClaw.app/Contents/Resources/skills/autoglm-browser-agent/SKILL.md`
- `AutoClaw.app/Contents/Resources/chrome-ext/autoclaw-chrome-0.0.6.crx`
- `autoclaw-dmg-analysis/npm-openclaw-2026.2.19-2/node_modules/openclaw/package.json`
- `qclaw-dmg-analysis/qclaw-reverse-analysis-report.md`
