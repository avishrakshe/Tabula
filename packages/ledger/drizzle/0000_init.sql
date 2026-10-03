CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`department` text NOT NULL,
	`api_key_hash` text NOT NULL,
	`payer_pubkey` text NOT NULL,
	`allowance_pubkey` text,
	`allowance_amount` integer,
	`daily_budget` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`merkle_root` text NOT NULL,
	`voucher_count` integer NOT NULL,
	`first_voucher_id` integer NOT NULL,
	`last_voucher_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`tx_signature` text,
	`created_at` integer NOT NULL,
	`anchored_at` integer
);
--> statement-breakpoint
CREATE TABLE `challenge_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` text NOT NULL,
	`vendor_id` text,
	`endpoint` text NOT NULL,
	`payee_expected` text,
	`payee_offered` text,
	`mint_expected` text,
	`mint_offered` text,
	`program_id` text,
	`price_offered` integer,
	`simulation_ok` integer,
	`verdict` text NOT NULL,
	`reason` text NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_pda` text,
	`agent_id` text NOT NULL,
	`vendor_id` text NOT NULL,
	`task_id` text,
	`payer_pubkey` text NOT NULL,
	`authorized_signer` text NOT NULL,
	`deposit` integer NOT NULL,
	`signed_cumulative` integer DEFAULT 0 NOT NULL,
	`settled_amount` integer,
	`refunded_amount` integer,
	`status` text DEFAULT 'opening' NOT NULL,
	`close_reason` text,
	`open_tx` text,
	`close_tx` text,
	`refund_tx` text,
	`grace_period` integer,
	`opened_at` integer NOT NULL,
	`last_voucher_at` integer,
	`closed_at` integer
);
--> statement-breakpoint
CREATE INDEX `channels_agent_idx` ON `channels` (`agent_id`);--> statement-breakpoint
CREATE INDEX `channels_status_idx` ON `channels` (`status`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`type` text NOT NULL,
	`agent_id` text,
	`channel_id` text,
	`message` text NOT NULL,
	`data_json` text DEFAULT '{}' NOT NULL,
	`tx_signature` text
);
--> statement-breakpoint
CREATE INDEX `events_ts_idx` ON `events` (`ts`);--> statement-breakpoint
CREATE TABLE `policies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text,
	`rules_json` text NOT NULL,
	`version` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `policies_scope_idx` ON `policies` (`scope`,`scope_id`,`active`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`label` text NOT NULL,
	`customer_tag` text,
	`task_type` text NOT NULL,
	`budget` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE TABLE `vendors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`endpoint` text NOT NULL,
	`payee_pubkey` text NOT NULL,
	`mint` text NOT NULL,
	`program_id` text NOT NULL,
	`unit_name` text NOT NULL,
	`unit_price` integer NOT NULL,
	`max_unit_price` integer NOT NULL,
	`task_type` text NOT NULL,
	`allowlisted` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vouchers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`idempotency_key` text NOT NULL,
	`channel_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`task_id` text NOT NULL,
	`vendor_id` text NOT NULL,
	`cumulative_amount` integer NOT NULL,
	`delta` integer NOT NULL,
	`unit_count` integer NOT NULL,
	`unit_price` integer NOT NULL,
	`verdict` text NOT NULL,
	`rule_triggered` text,
	`reason` text,
	`signature` text,
	`response_status` text,
	`latency_ms` integer,
	`ts` integer NOT NULL,
	`batch_id` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vouchers_idem_idx` ON `vouchers` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `vouchers_agent_ts_idx` ON `vouchers` (`agent_id`,`ts`);--> statement-breakpoint
CREATE INDEX `vouchers_channel_idx` ON `vouchers` (`channel_id`);--> statement-breakpoint
CREATE INDEX `vouchers_batch_idx` ON `vouchers` (`batch_id`);