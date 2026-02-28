import { z } from "zod";

export const channelTypeSchema = z.enum(["slack", "discord", "whatsapp"]);

export const channelStatusSchema = z.enum([
  "pending",
  "connected",
  "disconnected",
  "error",
]);

export const connectSlackSchema = z.object({
  botToken: z.string().min(1),
  signingSecret: z.string().min(1),
  teamId: z.string().min(1),
  teamName: z.string().optional(),
});

export const connectDiscordSchema = z.object({
  botToken: z.string().min(1),
  appId: z.string().min(1),
  guildId: z.string().optional(),
  guildName: z.string().optional(),
});

export const connectWhatsAppSchema = z
  .object({
    phoneNumberId: z.string().min(1).optional(),
    phoneNumber: z.string().min(1).optional(),
    displayPhoneNumber: z.string().optional(),
  })
  .refine(
    (input) =>
      typeof input.phoneNumberId === "string" ||
      typeof input.phoneNumber === "string",
    {
      message: "Either phoneNumberId or phoneNumber is required",
      path: ["phoneNumber"],
    },
  );

export const claimWhatsAppLinkSchema = z.object({
  token: z.string().min(1),
});

export const whatsappLinkStatusResponseSchema = z.object({
  linked: z.boolean(),
  waId: z.string().nullable(),
  officialPhoneNumber: z.string().nullable(),
  officialWaLink: z.string().nullable(),
  hasBotConfigured: z.boolean(),
});

export const channelResponseSchema = z.object({
  id: z.string(),
  botId: z.string(),
  channelType: channelTypeSchema,
  accountId: z.string(),
  status: channelStatusSchema,
  teamName: z.string().nullable(),
  appId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const channelListResponseSchema = z.object({
  channels: z.array(channelResponseSchema),
});

export const slackOAuthUrlResponseSchema = z.object({
  url: z.string(),
});

export type ChannelType = z.infer<typeof channelTypeSchema>;
export type ChannelStatus = z.infer<typeof channelStatusSchema>;
export type ConnectSlackInput = z.infer<typeof connectSlackSchema>;
export type ConnectDiscordInput = z.infer<typeof connectDiscordSchema>;
export type ConnectWhatsAppInput = z.infer<typeof connectWhatsAppSchema>;
export type ClaimWhatsAppLinkInput = z.infer<typeof claimWhatsAppLinkSchema>;
export type ChannelResponse = z.infer<typeof channelResponseSchema>;
export type SlackOAuthUrlResponse = z.infer<typeof slackOAuthUrlResponseSchema>;
export type WhatsAppLinkStatusResponse = z.infer<
  typeof whatsappLinkStatusResponseSchema
>;
