ALTER TABLE "app"."preview_attempts" RENAME COLUMN "code_diagnostics" TO "diagnostics";--> statement-breakpoint
ALTER TABLE "app"."node_attempts" RENAME COLUMN "code_diagnostics" TO "diagnostics";
