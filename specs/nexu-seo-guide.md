# nexu SEO 指南

## 一、TDK（Title / Description / Keywords）

### 中文版（面向国内搜索引擎）


| 类型              | 内容                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| **Title**       | Nexu — 飞书龙虾开源客户端                                                                                     |
| **Description** | Nexu 是最好用的飞书 OpenClaw 开源客户端。模型自由选，数据 100% 本地存储，完全免费 BYOK。下载、双击、1 分钟安装，直接在飞书里使用 AI Agent。MIT 开源，社区共建。 |
| **Keywords**    | 飞书龙虾, 飞书 OpenClaw, 开源 AI Agent, 飞书 AI 客户端, 本地数据 AI, BYOK AI 工具, OpenClaw 桌面端, 免费 AI Agent            |


### 英文版（面向全球 / Google）


| 类型              | 内容                                                                                                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**       | Nexu — The Open-Source OpenClaw Client for Lark                                                                                                                                                                                  |
| **Description** | Nexu is the open-source OpenClaw client built for Lark. Choose any model, keep 100% of your data local, and pay nothing. Download, double-click, and your first AI agent is ready in one minute. MIT-licensed, community-driven. |
| **Keywords**    | Lark OpenClaw, open source AI agent, OpenClaw desktop client, BYOK AI tool, local data AI, Lark AI bot, free AI agent, AI workflow automation                                                                                    |


## 二、HTML Meta 标签示例

```html
<!-- 中文 / 国内 -->
<title>Nexu — 最好用的飞书龙虾开源客户端</title>
<meta name="description" content="Nexu 是最好用的飞书 OpenClaw 开源客户端。模型自由选，数据 100% 本地存储，完全免费 BYOK。下载、双击、1 分钟安装，直接在飞书里使用 AI Agent。MIT 开源，社区共建。" />
<meta name="keywords" content="飞书龙虾, 飞书 OpenClaw, 开源 AI Agent, 飞书 AI 客户端, 本地数据 AI, BYOK AI 工具, OpenClaw 桌面端, 免费 AI Agent" />

<!-- 英文 / 全球 / Open Graph -->
<meta property="og:title" content="Nexu — The Open-Source OpenClaw Client for Lark" />
<meta property="og:description" content="Nexu is the open-source OpenClaw client built for Lark. Choose any model, keep 100% of your data local, and pay nothing. Download, double-click, and your first AI agent is ready in one minute." />
<meta property="og:type" content="website" />
<meta property="og:url" content="https://nexu.io" />
<meta property="og:image" content="https://nexu.io/og-image.png" />
<meta property="og:locale" content="en_US" />
<meta property="og:locale:alternate" content="zh_CN" />

<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="Nexu — The Open-Source OpenClaw Client for Lark" />
<meta name="twitter:description" content="Nexu is the open-source OpenClaw client built for Lark. Choose any model, keep 100% of your data local, and pay nothing. Your first AI agent is ready in one minute." />
<meta name="twitter:image" content="https://nexu.io/og-image.png" />
```

## 三、规范与建议

### Title

- 控制在 **60 字符以内**（中文约 30 字），超出易被截断
- 主关键词靠前：Nexu、飞书龙虾 / OpenClaw、开源 / Lark
- 品牌名 + 定位 + 差异化，避免纯产品名

### Description

- 控制在 **150–160 字符**（中文约 75–80 字）
- 一句话说清：是什么、给谁用、核心卖点（模型自由、数据本地、免费）
- 自然包含 2–3 个目标关键词

### Keywords

- 数量建议 **5–8 个**，过长易被稀释
- 覆盖：产品形态（飞书龙虾/OpenClaw客户端）、核心卖点（开源/本地数据/BYOK/免费）、使用场景
- 可与官网文案、博客、落地页保持一致

## 四、结构化数据（Schema.org）

可选，用于富摘要展示：

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Nexu",
  "applicationCategory": "BusinessApplication",
  "operatingSystem": "macOS",
  "description": "The open-source OpenClaw client for Lark. Choose any model, keep 100% of your data local, and pay nothing. MIT-licensed, community-driven.",
  "offers": {
    "@type": "Offer",
    "price": "0",
    "priceCurrency": "USD"
  },
  "url": "https://nexu.io"
}
```

## 五、页面级 SEO 建议


| 页面      | Title 建议                                        |
| ------- | ----------------------------------------------- |
| 首页（中文）  | Nexu — 最好用的飞书龙虾开源客户端                            |
| 首页（英文）  | Nexu — The Open-Source OpenClaw Client for Lark |
| 下载页     | 下载 Nexu — Mac 客户端 | 开源免费 BYOK                   |
| 文档首页    | Nexu 文档 — 快速开始 | docs.nexu.io                   |
| 关于 / 博客 | Nexu 博客 — 开源、数据主权与 AI Agent                     |


## 六、多语言 / 区域说明

- **中文站点**（home.html）：用于百度、搜狗、微信搜一搜等，主打「飞书龙虾」「开源」「数据本地」关键词
- **英文站点**（home-en.html）：用于 Google、Bing，以及 Twitter / LinkedIn 等分享，主打「Lark OpenClaw」「open-source」「local data」
- 已实现中英双语页面，建议添加 `hreflang` 标注：

```html
<link rel="alternate" hreflang="zh" href="https://nexu.io/home.html" />
<link rel="alternate" hreflang="en" href="https://nexu.io/home-en.html" />
```

