CREATE TABLE IF NOT EXISTS "workspace_memberships" (
  "pk" serial PRIMARY KEY,
  "id" text NOT NULL UNIQUE,
  "workspace_key" text NOT NULL,
  "user_id" text NOT NULL,
  "bot_id" text NOT NULL,
  "im_user_id" text,
  "role" text DEFAULT 'member',
  "created_at" text NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "wm_workspace_user_idx" ON "workspace_memberships" ("workspace_key", "user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wm_workspace_im_user_idx" ON "workspace_memberships" ("workspace_key", "im_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wm_user_idx" ON "workspace_memberships" ("user_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "claim_tokens" (
  "pk" serial PRIMARY KEY,
  "id" text NOT NULL UNIQUE,
  "token" text NOT NULL UNIQUE,
  "workspace_key" text NOT NULL,
  "im_user_id" text NOT NULL,
  "bot_id" text NOT NULL,
  "expires_at" text NOT NULL,
  "used_at" text,
  "used_by_user_id" text,
  "created_at" text NOT NULL
);--> statement-breakpoint

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "nexu_user_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_nexu_user_id_idx" ON "sessions" ("nexu_user_id");
