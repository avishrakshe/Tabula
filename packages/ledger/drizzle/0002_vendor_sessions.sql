CREATE TABLE "vendor_sessions" (
	"vendor_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"state_json" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "vendor_sessions_vendor_id_channel_id_pk" PRIMARY KEY("vendor_id","channel_id")
);
