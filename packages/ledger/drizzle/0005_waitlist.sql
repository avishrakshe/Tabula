CREATE TABLE "waitlist" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"company" text,
	"interest" text,
	"fleet" text,
	"requester" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_email_idx" ON "waitlist" USING btree ("email");--> statement-breakpoint
-- Like every ledger table (0004): RLS with no policies, so Supabase's public API roles can't read the emails.
ALTER TABLE "waitlist" ENABLE ROW LEVEL SECURITY;