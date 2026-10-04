CREATE TABLE "demo_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"started_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"finished_at" bigint,
	"lease_until" bigint,
	"state_json" text NOT NULL,
	"requester" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" bigint NOT NULL,
	"count" bigint NOT NULL
);
