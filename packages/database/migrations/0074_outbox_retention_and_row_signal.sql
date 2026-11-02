CREATE INDEX "inbox_receipts_retention_idx" ON "app"."inbox_receipts" USING btree ("received_at","message_id");--> statement-breakpoint
CREATE INDEX "outbox_events_published_retention_idx" ON "app"."outbox_events" USING btree ("published_at","id") WHERE ((published_at IS NOT NULL) AND (failed_at IS NULL) AND (delivery_due_at IS NULL));--> statement-breakpoint
CREATE INDEX "outbox_events_failed_retention_idx" ON "app"."outbox_events" USING btree ("failed_at","id") WHERE ((failed_at IS NOT NULL) AND (delivery_due_at IS NULL));--> statement-breakpoint
CREATE FUNCTION app.signal_outbox_rows() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- A statement-level trigger fires for an insert of no rows too, and the worker's
  -- scans run those many times a second.
  IF EXISTS (SELECT 1 FROM new_rows) THEN
    PERFORM pg_notify('outbox_rows', '');
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER outbox_events_signal_rows AFTER INSERT ON app.outbox_events REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.signal_outbox_rows();
