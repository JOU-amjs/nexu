import { createId } from "@paralleldrive/cuid2";
import { and, eq, or } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { botChannels, bots } from "../db/schema/index.js";

type DbLike = Pick<Database, "select" | "insert" | "update">;

export function getOfficialWhatsAppAccountId(): string {
  return process.env.WHATSAPP_OFFICIAL_ACCOUNT_ID ?? "whatsapp-official";
}

export function getOfficialWhatsAppPhoneNumberId(): string | null {
  return process.env.WHATSAPP_PHONE_NUMBER_ID ?? null;
}

export function getOfficialWhatsAppPhoneNumber(): string | null {
  return process.env.WHATSAPP_OFFICIAL_PHONE_NUMBER ?? null;
}

export function getOfficialWhatsAppWaLink(): string | null {
  const officialPhoneNumber = getOfficialWhatsAppPhoneNumber();
  if (!officialPhoneNumber) {
    return null;
  }

  const normalizedPhone = officialPhoneNumber.replace(/\D/g, "");
  if (!normalizedPhone) {
    return null;
  }

  return `https://wa.me/${normalizedPhone}`;
}

export async function findUserPrimaryBot(
  db: DbLike,
  userId: string,
): Promise<typeof bots.$inferSelect | null> {
  const [activeBot] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.userId, userId), eq(bots.status, "active")));

  if (activeBot) {
    return activeBot;
  }

  const [pausedBot] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.userId, userId), eq(bots.status, "paused")));

  return pausedBot ?? null;
}

export async function ensureWhatsAppChannelForBot(
  db: DbLike,
  botId: string,
  waId: string,
): Promise<void> {
  const accountId = getOfficialWhatsAppAccountId();
  const now = new Date().toISOString();

  const [existing] = await db
    .select()
    .from(botChannels)
    .where(
      and(
        eq(botChannels.botId, botId),
        eq(botChannels.channelType, "whatsapp"),
        eq(botChannels.accountId, accountId),
      ),
    );

  if (existing) {
    const nextConfig = (() => {
      if (!existing.channelConfig) {
        return JSON.stringify({
          waId,
          phoneNumberId: getOfficialWhatsAppPhoneNumberId(),
        });
      }

      try {
        const current = JSON.parse(existing.channelConfig) as Record<
          string,
          unknown
        >;
        return JSON.stringify({
          ...current,
          waId,
          phoneNumberId:
            typeof current.phoneNumberId === "string"
              ? current.phoneNumberId
              : getOfficialWhatsAppPhoneNumberId(),
        });
      } catch {
        return JSON.stringify({
          waId,
          phoneNumberId: getOfficialWhatsAppPhoneNumberId(),
        });
      }
    })();

    await db
      .update(botChannels)
      .set({
        status: "connected",
        channelConfig: nextConfig,
        updatedAt: now,
      })
      .where(eq(botChannels.id, existing.id));
    return;
  }

  await db.insert(botChannels).values({
    id: createId(),
    botId,
    channelType: "whatsapp",
    accountId,
    status: "connected",
    channelConfig: JSON.stringify({
      waId,
      phoneNumberId: getOfficialWhatsAppPhoneNumberId(),
    }),
    createdAt: now,
    updatedAt: now,
  });
}

export async function hasConfiguredBot(
  db: DbLike,
  userId: string,
): Promise<boolean> {
  const [bot] = await db
    .select({ id: bots.id })
    .from(bots)
    .where(
      and(
        eq(bots.userId, userId),
        or(eq(bots.status, "active"), eq(bots.status, "paused")),
      ),
    );

  return Boolean(bot);
}
