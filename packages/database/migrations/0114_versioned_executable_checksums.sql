ALTER TABLE "app"."workflow_promotion_origins" DROP CONSTRAINT "promotion_origin_digests_valid";--> statement-breakpoint
ALTER TABLE "app"."workflow_version_promotions" DROP CONSTRAINT "version_promotion_checksum_valid";--> statement-breakpoint
ALTER TABLE "app"."workflow_versions" DROP CONSTRAINT "workflow_versions_checksum_format";--> statement-breakpoint
ALTER TABLE "app"."workflow_test_snapshots" DROP CONSTRAINT "workflow_test_snapshots_checksum_valid";--> statement-breakpoint
ALTER TABLE "app"."workflow_input_cases" ALTER COLUMN "version_checksum" SET DATA TYPE varchar(77);--> statement-breakpoint
ALTER TABLE "app"."workflow_versions" ALTER COLUMN "checksum" SET DATA TYPE varchar(77);--> statement-breakpoint
ALTER TABLE "app"."workflow_calls" ALTER COLUMN "target_checksum" SET DATA TYPE varchar(77);--> statement-breakpoint
ALTER TABLE "app"."workflow_test_snapshots" ALTER COLUMN "checksum" SET DATA TYPE varchar(77);--> statement-breakpoint
ALTER TABLE "app"."workflow_promotion_origins" ADD CONSTRAINT "promotion_origin_digests_valid" CHECK (source_checksum ~ '^wf:sha256:(v2:)?[a-f0-9]{64}$' and graph_digest ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "app"."workflow_version_promotions" ADD CONSTRAINT "version_promotion_checksum_valid" CHECK (source_checksum ~ '^wf:sha256:(v2:)?[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "app"."workflow_versions" ADD CONSTRAINT "workflow_versions_checksum_format" CHECK (((checksum)::text ~ '^wf:sha256:(v2:)?[0-9a-f]{64}$'::text));--> statement-breakpoint
ALTER TABLE "app"."workflow_test_snapshots" ADD CONSTRAINT "workflow_test_snapshots_checksum_valid" CHECK (checksum ~ '^wf:sha256:(v2:)?[0-9a-f]{64}$');