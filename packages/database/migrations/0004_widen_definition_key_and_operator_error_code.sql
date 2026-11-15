-- Two columns widen to their owners' limits: a preview run's definition key to
-- the catalog's 256-character identity key, and an operator replay's safe error
-- code to the 128 characters every other safe error code has. Widening a
-- varchar changes only the catalog, so no row is rewritten.

ALTER TABLE "app"."preview_runs" ALTER COLUMN "definition_key" SET DATA TYPE varchar(256);--> statement-breakpoint
ALTER TABLE "app"."operator_run_replay_requests" ALTER COLUMN "safe_error_code" SET DATA TYPE varchar(128);