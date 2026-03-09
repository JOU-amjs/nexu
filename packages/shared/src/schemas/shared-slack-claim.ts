import { z } from "zod";

export const sharedSlackClaimSchema = z.object({
  teamId: z.string().min(1),
  teamName: z.string().optional(),
  slackUserId: z.string().min(1),
});

export type SharedSlackClaimRequest = z.infer<typeof sharedSlackClaimSchema>;

export const sharedSlackClaimResponseSchema = z.object({
  ok: z.boolean(),
  orgAuthorized: z.boolean(),
});

export type SharedSlackClaimResponse = z.infer<
  typeof sharedSlackClaimResponseSchema
>;
