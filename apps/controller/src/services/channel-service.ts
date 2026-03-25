import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  BotQuotaResponse,
  ChannelResponse,
  ConnectDiscordInput,
  ConnectFeishuInput,
  ConnectSlackInput,
  ConnectTelegramInput,
} from "@nexu/shared";
import type { ControllerEnv } from "../app/env.js";
import { logger } from "../lib/logger.js";
import type { NexuConfigStore } from "../store/nexu-config-store.js";
import type { OpenClawGatewayService } from "./openclaw-gateway-service.js";
import type { OpenClawSyncService } from "./openclaw-sync-service.js";

function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

const DEFAULT_WHATSAPP_ACCOUNT_ID = "default";
const DEFAULT_WECHAT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_WECHAT_BOT_TYPE = "3";
const WECHAT_LOGIN_TTL_MS = 5 * 60_000;
const WECHAT_QR_POLL_TIMEOUT_MS = 35_000;

type ActiveWechatLogin = {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
};

type TelegramGetMeResponse = {
  ok: boolean;
  description?: string;
  result?: {
    id?: number;
    username?: string;
    first_name?: string;
  };
};

type WhatsappLoginModule = {
  startWebLoginWithQr: (opts?: {
    verbose?: boolean;
    timeoutMs?: number;
    force?: boolean;
    accountId?: string;
  }) => Promise<{ qrDataUrl?: string; message: string }>;
  waitForWebLogin: (opts?: {
    timeoutMs?: number;
    accountId?: string;
  }) => Promise<{ connected: boolean; message: string }>;
};

type WechatQrCodeResponse = {
  qrcode: string;
  qrcode_img_content: string;
};

type WechatQrStatusResponse = {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
};

type WechatStoredAccount = {
  token?: string;
  savedAt?: string;
  baseUrl?: string;
  userId?: string;
};

const activeWechatLogins = new Map<string, ActiveWechatLogin>();

function isFsPath(value: string): boolean {
  return value.includes(path.sep) || value.startsWith(".");
}

function resolveWorkspaceRoot(env: ControllerEnv): string | null {
  const workspaceFromTemplates = path.resolve(
    env.runtimePluginTemplatesDir,
    "../..",
  );
  return existsSync(path.join(workspaceFromTemplates, "pnpm-workspace.yaml"))
    ? workspaceFromTemplates
    : null;
}

function normalizeAccountId(accountId: string): string {
  return accountId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function resolveWeChatPluginStateDir(env: ControllerEnv): string {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    env.openclawStateDir ||
    path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "openclaw-weixin");
}

function resolveWeChatAccountsDir(env: ControllerEnv): string {
  return path.join(resolveWeChatPluginStateDir(env), "accounts");
}

function resolveWeChatAccountIndexPath(env: ControllerEnv): string {
  return path.join(resolveWeChatPluginStateDir(env), "accounts.json");
}

function writeWeChatAccount(
  env: ControllerEnv,
  accountId: string,
  data: WechatStoredAccount,
): void {
  const dir = resolveWeChatAccountsDir(env);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${accountId}.json`);
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

function registerWeChatAccount(env: ControllerEnv, accountId: string): void {
  const stateDir = resolveWeChatPluginStateDir(env);
  mkdirSync(stateDir, { recursive: true });
  const indexPath = resolveWeChatAccountIndexPath(env);
  const existing = existsSync(indexPath)
    ? (() => {
        try {
          const parsed = JSON.parse(
            readFileSync(indexPath, "utf-8"),
          ) as unknown;
          return Array.isArray(parsed)
            ? parsed.filter(
                (value): value is string => typeof value === "string",
              )
            : [];
        } catch {
          return [];
        }
      })()
    : [];

  if (existing.includes(accountId)) {
    return;
  }

  writeFileSync(
    indexPath,
    JSON.stringify([...existing, accountId], null, 2),
    "utf-8",
  );
}

function purgeExpiredWechatLogins(): void {
  const now = Date.now();
  for (const [sessionKey, login] of activeWechatLogins) {
    if (now - login.startedAt >= WECHAT_LOGIN_TTL_MS) {
      activeWechatLogins.delete(sessionKey);
    }
  }
}

async function fetchWechatQrCode(
  apiBaseUrl: string,
  botType: string,
): Promise<WechatQrCodeResponse> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    base,
  );
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(
      `Failed to fetch QR code: ${response.status} ${response.statusText}`,
    );
  }
  return (await response.json()) as WechatQrCodeResponse;
}

async function pollWechatQrStatus(
  apiBaseUrl: string,
  qrcode: string,
): Promise<WechatQrStatusResponse> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    base,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WECHAT_QR_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(
        `Failed to poll QR status: ${response.status} ${response.statusText}`,
      );
    }
    return JSON.parse(rawText) as WechatQrStatusResponse;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { status: "wait" };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function resolveOpenClawPackageDir(env: ControllerEnv): string {
  const candidates = new Set<string>();

  if (env.openclawBuiltinExtensionsDir) {
    candidates.add(path.resolve(env.openclawBuiltinExtensionsDir, ".."));
  }

  if (isFsPath(env.openclawBin)) {
    const binDir = path.dirname(path.resolve(env.openclawBin));
    candidates.add(path.resolve(binDir, "..", "node_modules", "openclaw"));
    candidates.add(
      path.resolve(binDir, "..", "..", "node_modules", "openclaw"),
    );
    candidates.add(
      path.resolve(binDir, "openclaw-runtime", "node_modules", "openclaw"),
    );
  }

  const workspaceRoot = resolveWorkspaceRoot(env);
  if (workspaceRoot) {
    candidates.add(
      path.resolve(
        workspaceRoot,
        ".tmp",
        "sidecars",
        "openclaw",
        "node_modules",
        "openclaw",
      ),
    );
    candidates.add(
      path.resolve(
        workspaceRoot,
        "openclaw-runtime",
        "node_modules",
        "openclaw",
      ),
    );
  }

  candidates.add(
    path.resolve(process.cwd(), "openclaw-runtime", "node_modules", "openclaw"),
  );

  const candidateList = [...candidates];

  logger.info(
    {
      openclawBin: env.openclawBin,
      openclawBuiltinExtensionsDir: env.openclawBuiltinExtensionsDir,
      cwd: process.cwd(),
      candidates: candidateList,
    },
    "whatsapp_resolve_openclaw_package_dir",
  );

  try {
    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve("openclaw/package.json");
    candidates.add(path.dirname(packageJsonPath));
  } catch {
    // Ignore and keep trying filesystem-based candidates.
  }

  const matched = [...candidates].find((candidate) =>
    existsSync(path.join(candidate, "package.json")),
  );
  logger.info(
    {
      matched: matched ?? null,
    },
    "whatsapp_resolve_openclaw_package_dir_result",
  );
  if (!matched) {
    throw new Error("OpenClaw package root not found for WhatsApp login");
  }
  return matched;
}

async function loadWhatsappLoginModule(
  env: ControllerEnv,
): Promise<WhatsappLoginModule> {
  const pluginSdkDir = path.join(
    resolveOpenClawPackageDir(env),
    "dist",
    "plugin-sdk",
  );
  const entries = await readdir(pluginSdkDir);
  const loginChunk = entries
    .filter(
      (entry) =>
        entry.startsWith("login-qr-") && entry.toLowerCase().endsWith(".js"),
    )
    .sort()[0];

  if (!loginChunk) {
    throw new Error("OpenClaw WhatsApp login module not found");
  }

  const modulePath = path.join(pluginSdkDir, loginChunk);
  const loaded = (await import(pathToFileURL(modulePath).href)) as unknown;
  if (
    typeof loaded !== "object" ||
    loaded === null ||
    !("startWebLoginWithQr" in loaded) ||
    !("waitForWebLogin" in loaded)
  ) {
    throw new Error("OpenClaw WhatsApp login module is invalid");
  }
  return loaded as WhatsappLoginModule;
}

export class ChannelService {
  constructor(
    private readonly env: ControllerEnv,
    private readonly configStore: NexuConfigStore,
    private readonly syncService: OpenClawSyncService,
    private readonly gatewayService: OpenClawGatewayService,
  ) {}

  async listChannels() {
    return this.configStore.listChannels();
  }

  async getChannel(channelId: string): Promise<ChannelResponse | null> {
    return this.configStore.getChannel(channelId);
  }

  async getBotQuota(): Promise<BotQuotaResponse> {
    return {
      available: true,
      resetsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  async connectSlack(input: ConnectSlackInput) {
    const authResp = await fetch("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${input.botToken}` },
      signal: timeoutSignal(5000),
    });
    const authData = (await authResp.json()) as {
      ok: boolean;
      team_id?: string;
      team?: string;
      bot_id?: string;
      user_id?: string;
      error?: string;
    };
    if (!authData.ok || !authData.team_id) {
      throw new Error(
        `Invalid Slack bot token: ${authData.error ?? "auth.test failed"}`,
      );
    }

    let appId = input.appId;
    if (!appId && authData.bot_id) {
      const botInfoResp = await fetch(
        `https://slack.com/api/bots.info?bot=${authData.bot_id}`,
        {
          headers: { Authorization: `Bearer ${input.botToken}` },
          signal: timeoutSignal(5000),
        },
      );
      const botInfo = (await botInfoResp.json()) as {
        ok: boolean;
        bot?: { app_id?: string };
      };
      appId = botInfo.bot?.app_id;
    }

    if (!appId) {
      throw new Error("Could not resolve Slack app id from bot token");
    }

    const channel = await this.configStore.connectSlack({
      ...input,
      teamId: input.teamId ?? authData.team_id,
      teamName: input.teamName ?? authData.team,
      appId,
      botUserId: authData.user_id ?? null,
    });
    await this.syncService.writePlatformTemplatesForBot(channel.botId);
    await this.syncService.syncAll();
    return channel;
  }

  async connectDiscord(input: ConnectDiscordInput) {
    const userResp = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${input.botToken}` },
      signal: timeoutSignal(5000),
    });
    if (!userResp.ok) {
      throw new Error(
        userResp.status === 401
          ? "Invalid Discord bot token"
          : `Discord API error (${userResp.status})`,
      );
    }

    const userData = (await userResp.json()) as { id?: string };

    const appResp = await fetch(
      "https://discord.com/api/v10/applications/@me",
      {
        headers: { Authorization: `Bot ${input.botToken}` },
        signal: timeoutSignal(5000),
      },
    );
    if (appResp.ok) {
      const appData = (await appResp.json()) as { id: string };
      if (appData.id !== input.appId) {
        throw new Error(
          `Application ID mismatch: token belongs to ${appData.id}, but ${input.appId} was provided`,
        );
      }
    }

    const channel = await this.configStore.connectDiscord({
      ...input,
      botUserId: userData.id ?? null,
    });
    await this.syncService.writePlatformTemplatesForBot(channel.botId);
    await this.syncService.syncAll();
    return channel;
  }

  async connectWechat(accountId: string) {
    const channel = await this.configStore.connectWechat({ accountId });
    await this.syncService.writePlatformTemplatesForBot(channel.botId);
    await this.syncService.syncAll();
    return channel;
  }

  async wechatQrStart() {
    const sessionKey = randomUUID();
    purgeExpiredWechatLogins();

    const qrResponse = await fetchWechatQrCode(
      DEFAULT_WECHAT_BASE_URL,
      DEFAULT_WECHAT_BOT_TYPE,
    );

    activeWechatLogins.set(sessionKey, {
      sessionKey,
      qrcode: qrResponse.qrcode,
      qrcodeUrl: qrResponse.qrcode_img_content,
      startedAt: Date.now(),
    });

    return {
      qrDataUrl: qrResponse.qrcode_img_content,
      message: "使用微信扫描以下二维码，以完成连接。",
      sessionKey,
    };
  }

  async wechatQrWait(sessionKey: string) {
    const activeLogin = activeWechatLogins.get(sessionKey);
    if (!activeLogin) {
      return {
        connected: false,
        message: "当前没有进行中的登录，请先发起登录。",
      };
    }

    if (Date.now() - activeLogin.startedAt >= WECHAT_LOGIN_TTL_MS) {
      activeWechatLogins.delete(sessionKey);
      return {
        connected: false,
        message: "二维码已过期，请重新生成。",
      };
    }

    const deadline = Date.now() + 500_000;
    while (Date.now() < deadline) {
      const status = await pollWechatQrStatus(
        DEFAULT_WECHAT_BASE_URL,
        activeLogin.qrcode,
      );

      if (status.status === "wait" || status.status === "scaned") {
        continue;
      }

      if (status.status === "expired") {
        activeWechatLogins.delete(sessionKey);
        return {
          connected: false,
          message: "二维码已过期，请重新生成。",
        };
      }

      if (
        status.status === "confirmed" &&
        status.bot_token &&
        status.ilink_bot_id
      ) {
        const normalizedAccountId = normalizeAccountId(status.ilink_bot_id);
        writeWeChatAccount(this.env, normalizedAccountId, {
          token: status.bot_token,
          savedAt: new Date().toISOString(),
          baseUrl: status.baseurl || DEFAULT_WECHAT_BASE_URL,
          userId: status.ilink_user_id,
        });
        registerWeChatAccount(this.env, normalizedAccountId);
        activeWechatLogins.delete(sessionKey);
        return {
          connected: true,
          message: "微信连接成功。",
          accountId: normalizedAccountId,
        };
      }
    }

    activeWechatLogins.delete(sessionKey);
    return {
      connected: false,
      message: "等待扫码超时，请重新生成二维码。",
    };
  }

  async connectTelegram(input: ConnectTelegramInput) {
    const response = await fetch(
      `https://api.telegram.org/bot${encodeURIComponent(input.botToken)}/getMe`,
      {
        signal: timeoutSignal(5000),
      },
    );
    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? "Invalid Telegram bot token"
          : `Telegram API error (${response.status})`,
      );
    }

    const payload = (await response.json()) as TelegramGetMeResponse;
    if (!payload.ok || !payload.result?.id) {
      throw new Error(payload.description ?? "Invalid Telegram bot token");
    }

    const channel = await this.configStore.connectTelegram({
      botToken: input.botToken,
      telegramBotId: String(payload.result.id),
      botUsername: payload.result.username ?? null,
      displayName:
        payload.result.username?.trim() ||
        payload.result.first_name?.trim() ||
        null,
    });
    await this.syncService.writePlatformTemplatesForBot(channel.botId);
    await this.syncService.syncAll();
    return channel;
  }

  async whatsappQrStart() {
    const login = await loadWhatsappLoginModule(this.env);
    const result = await login.startWebLoginWithQr({
      accountId: DEFAULT_WHATSAPP_ACCOUNT_ID,
      force: true,
      timeoutMs: 30_000,
    });
    const alreadyLinked =
      !result.qrDataUrl &&
      result.message.toLowerCase().includes("already linked");
    return {
      ...result,
      accountId: DEFAULT_WHATSAPP_ACCOUNT_ID,
      alreadyLinked,
    };
  }

  async whatsappQrWait(accountId: string) {
    const login = await loadWhatsappLoginModule(this.env);
    const result = await login.waitForWebLogin({
      accountId,
      timeoutMs: 500_000,
    });
    return {
      ...result,
      accountId,
    };
  }

  async connectWhatsapp(accountId: string) {
    const channel = await this.configStore.connectWhatsapp({ accountId });
    await this.syncService.writePlatformTemplatesForBot(channel.botId);
    await this.syncService.syncAll();
    return channel;
  }

  async connectFeishu(input: ConnectFeishuInput) {
    const response = await fetch(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: input.appId,
          app_secret: input.appSecret,
        }),
        signal: timeoutSignal(5000),
      },
    );
    const payload = (await response.json()) as { code?: number; msg?: string };
    if (!response.ok || payload.code !== 0) {
      throw new Error(
        `Invalid Feishu credentials: ${payload.msg ?? `HTTP ${response.status}`}`,
      );
    }

    const channel = await this.configStore.connectFeishu(input);
    await this.syncService.writePlatformTemplatesForBot(channel.botId);
    await this.syncService.syncAll();
    return channel;
  }

  async disconnectChannel(channelId: string) {
    const channel = await this.configStore.getChannel(channelId);
    if (channel?.channelType === "whatsapp") {
      try {
        await this.gatewayService.logoutChannelAccount(
          channel.channelType,
          channel.accountId,
        );
      } catch (error) {
        logger.warn(
          {
            channelId,
            accountId: channel.accountId,
            error: error instanceof Error ? error.message : String(error),
          },
          "whatsapp_logout_before_disconnect_failed",
        );
      }
    }
    const removed = await this.configStore.disconnectChannel(channelId);
    if (removed) {
      await this.syncService.syncAll();
    }
    return removed;
  }
}
