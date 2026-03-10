CREATE TABLE "session_participants" (
	"pk" serial PRIMARY KEY NOT NULL,
	"session_key" text NOT NULL,
	"nexu_user_id" text NOT NULL,
	"im_user_id" text NOT NULL,
	"first_seen_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sp_session_user_idx" ON "session_participants" USING btree ("session_key","nexu_user_id");--> statement-breakpoint
CREATE INDEX "sp_nexu_user_idx" ON "session_participants" USING btree ("nexu_user_id");