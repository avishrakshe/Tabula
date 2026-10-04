CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"department" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"payer_pubkey" text NOT NULL,
	"voucher_pubkey" text NOT NULL,
	"allowance_pubkey" text,
	"allowance_amount" bigint,
	"daily_budget" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"merkle_root" text NOT NULL,
	"voucher_count" bigint NOT NULL,
	"first_voucher_id" bigint NOT NULL,
	"last_voucher_id" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tx_signature" text,
	"created_at" bigint NOT NULL,
	"anchored_at" bigint
);
--> statement-breakpoint
CREATE TABLE "challenge_checks" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"vendor_id" text,
	"endpoint" text NOT NULL,
	"payee_expected" text,
	"payee_offered" text,
	"mint_expected" text,
	"mint_offered" text,
	"program_id" text,
	"price_offered" bigint,
	"simulation_ok" boolean,
	"verdict" text NOT NULL,
	"reason" text NOT NULL,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_pda" text,
	"agent_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"task_id" text,
	"endpoint" text NOT NULL,
	"price_per_call" bigint NOT NULL,
	"payer_pubkey" text NOT NULL,
	"authorized_signer" text NOT NULL,
	"deposit" bigint NOT NULL,
	"signed_cumulative" bigint DEFAULT 0 NOT NULL,
	"settled_amount" bigint,
	"refunded_amount" bigint,
	"status" text DEFAULT 'opening' NOT NULL,
	"close_reason" text,
	"open_tx" text,
	"close_tx" text,
	"refund_tx" text,
	"grace_period" bigint,
	"opened_at" bigint NOT NULL,
	"last_voucher_at" bigint,
	"closed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" bigint NOT NULL,
	"type" text NOT NULL,
	"agent_id" text,
	"channel_id" text,
	"message" text NOT NULL,
	"data_json" text DEFAULT '{}' NOT NULL,
	"tx_signature" text
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text,
	"rules_json" text NOT NULL,
	"version" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"label" text NOT NULL,
	"customer_tag" text,
	"task_type" text NOT NULL,
	"budget" bigint,
	"status" text DEFAULT 'running' NOT NULL,
	"created_at" bigint NOT NULL,
	"completed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"endpoint" text NOT NULL,
	"payee_pubkey" text NOT NULL,
	"mint" text NOT NULL,
	"program_id" text NOT NULL,
	"unit_name" text NOT NULL,
	"unit_price" bigint NOT NULL,
	"max_unit_price" bigint NOT NULL,
	"task_type" text NOT NULL,
	"allowlisted" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" serial PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_id" text,
	"channel_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"task_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"cumulative_amount" bigint NOT NULL,
	"delta" bigint NOT NULL,
	"unit_count" bigint NOT NULL,
	"unit_price" bigint NOT NULL,
	"verdict" text NOT NULL,
	"rule_triggered" text,
	"reason" text,
	"signature" text,
	"response_status" text,
	"latency_ms" bigint,
	"ts" bigint NOT NULL,
	"batch_id" bigint
);
--> statement-breakpoint
CREATE INDEX "channels_agent_idx" ON "channels" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "channels_status_idx" ON "channels" USING btree ("status");--> statement-breakpoint
CREATE INDEX "events_ts_idx" ON "events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "policies_scope_idx" ON "policies" USING btree ("scope","scope_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "vouchers_idem_idx" ON "vouchers" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "vouchers_request_idx" ON "vouchers" USING btree ("channel_id","request_id");--> statement-breakpoint
CREATE INDEX "vouchers_agent_ts_idx" ON "vouchers" USING btree ("agent_id","ts");--> statement-breakpoint
CREATE INDEX "vouchers_channel_idx" ON "vouchers" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "vouchers_batch_idx" ON "vouchers" USING btree ("batch_id");