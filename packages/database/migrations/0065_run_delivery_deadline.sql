-- Every active run has a next step with a time on it. A published run job gets
-- the time by which its consumer must have confirmed it.
ALTER TABLE "app"."outbox_events" ADD COLUMN "delivery_due_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "outbox_events_delivery_due_idx" ON "app"."outbox_events" USING btree ("delivery_due_at","id") WHERE (delivery_due_at IS NOT NULL);--> statement-breakpoint
GRANT UPDATE(delivery_due_at) ON TABLE app.outbox_events TO {{maintenance_role}};
