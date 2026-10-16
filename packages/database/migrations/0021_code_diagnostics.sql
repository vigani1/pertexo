ALTER TABLE "app"."node_attempts" ADD COLUMN "code_diagnostics" jsonb;--> statement-breakpoint
ALTER TABLE "app"."preview_attempts" ADD COLUMN "code_diagnostics" jsonb;--> statement-breakpoint
ALTER TABLE "app"."node_attempts" ADD CONSTRAINT "node_attempts_code_diagnostics_bound" CHECK ("app"."node_attempts"."code_diagnostics" IS NULL OR (jsonb_typeof("app"."node_attempts"."code_diagnostics")='object' AND octet_length("app"."node_attempts"."code_diagnostics"::text)<=1048576));--> statement-breakpoint
ALTER TABLE "app"."preview_attempts" ADD CONSTRAINT "preview_attempts_code_diagnostics_bound" CHECK ("app"."preview_attempts"."code_diagnostics" IS NULL OR (jsonb_typeof("app"."preview_attempts"."code_diagnostics")='object' AND octet_length("app"."preview_attempts"."code_diagnostics"::text)<=1048576));--> statement-breakpoint
GRANT UPDATE(code_diagnostics) ON app.node_attempts TO {{app_role}};
GRANT UPDATE(code_diagnostics) ON app.preview_attempts TO {{app_role}};
