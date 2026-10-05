-- Row level security on every ledger table, with no policies: Supabase's public API roles (anon,
-- authenticated) can neither read nor write any of them. The gateway connects as the tables' owner,
-- which RLS does not apply to. A table added later needs the same line.
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "vendors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "vouchers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "challenge_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "vendor_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "demo_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rate_limits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "settings" ENABLE ROW LEVEL SECURITY;
