ALTER TABLE "app"."workflow_test_suites" ADD COLUMN "evaluation_table_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."workflow_test_suites" ADD COLUMN "evaluation_version_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."workflow_test_suites" ADD CONSTRAINT "workflow_test_suites_evaluation_version_source" CHECK (evaluation_version_id is null or evaluation_table_id is not null);