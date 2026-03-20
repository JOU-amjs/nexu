import { useEffect, useMemo, useState } from "react";

type SkillTranslation = {
  name: string;
  description: string;
};

type SkillTranslationsMap = Record<string, SkillTranslation>;

let zhTranslationsCache: SkillTranslationsMap | null = null;
let zhTranslationsPromise: Promise<SkillTranslationsMap> | null = null;

async function loadZhTranslations(): Promise<SkillTranslationsMap> {
  if (zhTranslationsCache) {
    return zhTranslationsCache;
  }

  if (!zhTranslationsPromise) {
    zhTranslationsPromise = fetch("/skill-translations-zh.json")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `Failed to load skill translations: ${response.status}`,
          );
        }

        return (await response.json()) as SkillTranslationsMap;
      })
      .then((translations) => {
        zhTranslationsCache = translations;
        return translations;
      })
      .finally(() => {
        zhTranslationsPromise = null;
      });
  }

  return zhTranslationsPromise;
}

const tagTranslationsZh: Record<string, string> = {
  latest: "最新",
  automation: "自动化",
  ai: "AI",
  finance: "金融",
  security: "安全",
  api: "API",
  crypto: "加密货币",
  mcp: "MCP",
  openclaw: "OpenClaw",
  memory: "记忆",
  productivity: "效率",
  agents: "智能体",
  audit: "审计",
  compliance: "合规",
  agent: "智能体",
  business: "商业",
  defi: "DeFi",
  base: "基础",
  blockchain: "区块链",
  chinese: "中文",
  marketing: "营销",
  "ai-agents": "AI 智能体",
  content: "内容",
  research: "研究",
  monitoring: "监控",
  search: "搜索",
  safety: "安全",
  cli: "命令行",
  devops: "运维",
  documentation: "文档",
  email: "邮件",
  operations: "运营",
  trading: "交易",
  analysis: "分析",
  "social-media": "社交媒体",
  "ai-agent": "AI 智能体",
  browser: "浏览器",
  identity: "身份",
  "multi-agent": "多智能体",
  governance: "治理",
  context: "上下文",
  solana: "Solana",
  health: "健康",
  hr: "人力资源",
  social: "社交",
  github: "GitHub",
  sales: "销售",
  analytics: "数据分析",
  bitcoin: "比特币",
  workflow: "工作流",
  tools: "工具",
  code: "代码",
  data: "数据",
  database: "数据库",
  design: "设计",
  development: "开发",
  education: "教育",
  entertainment: "娱乐",
  file: "文件",
  gaming: "游戏",
  image: "图片",
  language: "语言",
  legal: "法律",
  math: "数学",
  media: "媒体",
  music: "音乐",
  network: "网络",
  news: "新闻",
  payment: "支付",
  project: "项目",
  science: "科学",
  server: "服务器",
  storage: "存储",
  testing: "测试",
  text: "文本",
  translation: "翻译",
  utility: "工具",
  video: "视频",
  weather: "天气",
  web: "网页",
  writing: "写作",
  calendar: "日历",
  chat: "聊天",
  cloud: "云",
  communication: "通讯",
  "customer-support": "客服",
  ecommerce: "电商",
  kubernetes: "Kubernetes",
  docker: "Docker",
  slack: "Slack",
  discord: "Discord",
  telegram: "Telegram",
  twitter: "Twitter",
  notion: "Notion",
  "real-estate": "房地产",
  travel: "旅行",
  food: "美食",
  fitness: "健身",
  crypto_trading: "加密货币交易",
  ethereum: "以太坊",
  nft: "NFT",
  web3: "Web3",
  dao: "DAO",
  llm: "大模型",
  rag: "RAG",
  embedding: "向量嵌入",
  prompt: "提示词",
  "machine-learning": "机器学习",
};

function getLocalizedName(
  translations: SkillTranslationsMap | null,
  slug: string,
  originalName: string,
  locale: string,
): string {
  if (locale !== "zh") return originalName;
  return translations?.[slug]?.name ?? originalName;
}

function getLocalizedDescription(
  translations: SkillTranslationsMap | null,
  slug: string,
  originalDescription: string,
  locale: string,
): string {
  if (locale !== "zh") return originalDescription;
  return translations?.[slug]?.description ?? originalDescription;
}

export function useSkillTranslations(locale: string) {
  const [translations, setTranslations] = useState<SkillTranslationsMap | null>(
    () => (locale === "zh" ? zhTranslationsCache : null),
  );

  useEffect(() => {
    if (locale !== "zh") {
      return;
    }

    if (zhTranslationsCache) {
      setTranslations(zhTranslationsCache);
      return;
    }

    let cancelled = false;
    loadZhTranslations()
      .then((loadedTranslations) => {
        if (!cancelled) {
          setTranslations(loadedTranslations);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTranslations(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [locale]);

  return useMemo(
    () => ({
      getSkillName(slug: string, originalName: string): string {
        return getLocalizedName(translations, slug, originalName, locale);
      },
      getSkillDescription(slug: string, originalDescription: string): string {
        return getLocalizedDescription(
          translations,
          slug,
          originalDescription,
          locale,
        );
      },
      getSkillSearchText(
        slug: string,
        originalName: string,
        originalDescription: string,
      ): string {
        const localizedName = getLocalizedName(
          translations,
          slug,
          originalName,
          locale,
        );
        const localizedDescription = getLocalizedDescription(
          translations,
          slug,
          originalDescription,
          locale,
        );

        return composeSkillSearchText(
          slug,
          originalName,
          originalDescription,
          localizedName,
          localizedDescription,
        );
      },
    }),
    [locale, translations],
  );
}

export function composeSkillSearchText(
  slug: string,
  originalName: string,
  originalDescription: string,
  localizedName: string,
  localizedDescription: string,
): string {
  return [
    slug,
    originalName,
    originalDescription,
    localizedName,
    localizedDescription,
  ]
    .join("\n")
    .toLowerCase();
}

export function getTagLabel(tag: string, locale: string): string {
  if (locale !== "zh") return tag;
  return tagTranslationsZh[tag] ?? tag;
}
