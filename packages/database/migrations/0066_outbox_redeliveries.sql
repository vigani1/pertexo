-- Every job kind stays due until confirmed, and stalled work publishes the same
-- row again. BullMQ ignores an add under a retained job ID, so each redelivery
-- needs one of its own.
ALTER TABLE "app"."outbox_events" ADD COLUMN "redeliveries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."outbox_events" ADD CONSTRAINT "outbox_events_redeliveries_nonnegative" CHECK ((redeliveries >= 0));--> statement-breakpoint
GRANT UPDATE(redeliveries) ON TABLE app.outbox_events TO {{maintenance_role}};
