-- The cap on open approvals and requests was the queued-run limit by accident: changing
-- how many runs may queue also changed how many tasks may stay open.
ALTER TABLE "app"."instance_capacity" ADD COLUMN "pending_task_limit" integer DEFAULT 10000 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."instance_capacity" ADD CONSTRAINT "instance_capacity_pending_task_limit_valid" CHECK (pending_task_limit BETWEEN 1 AND 1000000);
