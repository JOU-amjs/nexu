CREATE TABLE "slack_user_claims" (
	"pk" serial PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text,
	"slack_user_id" text NOT NULL,
	"auth_user_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "slack_user_claims_id_unique" UNIQUE("id")
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_source" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_source_detail" text;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_user_claims_team_user_idx" ON "slack_user_claims" USING btree ("team_id","slack_user_id");--> statement-breakpoint
CREATE INDEX "slack_user_claims_auth_user_idx" ON "slack_user_claims" USING btree ("auth_user_id");--> statement-breakpoint
CREATE INDEX "artifacts_owner_user_id_idx" ON "artifacts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "sessions_owner_user_id_idx" ON "sessions" USING btree ("owner_user_id");