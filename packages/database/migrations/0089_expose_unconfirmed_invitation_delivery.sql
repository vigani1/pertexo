ALTER TABLE "app"."workspace_invitations" DROP CONSTRAINT "workspace_invitations_delivery_status_valid";--> statement-breakpoint
ALTER TABLE "app"."workspace_invitations" ADD CONSTRAINT "workspace_invitations_delivery_status_valid" CHECK (((delivery_status)::text = ANY (ARRAY[('queued'::character varying)::text, ('submitted'::character varying)::text, ('failed'::character varying)::text, ('canceled'::character varying)::text, ('unknown'::character varying)::text])));--> statement-breakpoint
-- The migration owner reads only acknowledged invitation events for this repair.
-- FORCE RLS is restored in this transaction; application policies stay in force.
ALTER TABLE app.outbox_events NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app.inbox_receipts NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
WITH unconfirmed AS MATERIALIZED (
  SELECT a.workspace_id,a.id,a.invitation_id
    FROM app.workspace_invitation_delivery_attempts a
    JOIN app.workspace_invitations i
      ON i.workspace_id=a.workspace_id AND i.id=a.invitation_id
   WHERE a.status='unknown' AND i.status='pending' AND i.delivery_status='queued'
     AND a.invitation_revision=i.revision
     AND EXISTS (
       SELECT 1 FROM app.outbox_events e
       JOIN app.inbox_receipts r ON r.workspace_id=e.workspace_id AND r.message_id=e.id
         AND r.consumer_name='workspace-invitation' AND r.completed_at IS NOT NULL
         AND r.payload_checksum=e.payload_checksum
       WHERE e.workspace_id=a.workspace_id AND e.aggregate_id=a.invitation_id
         AND e.job_name='deliver-workspace-invitation'
         AND e.payload->>'deliveryAttemptId'=a.id::text
     )
), scrubbed AS (
  UPDATE app.workspace_invitation_delivery_attempts a
     SET token_ciphertext=NULL,token_nonce=NULL,token_tag=NULL,token_key_version=NULL,
         failure_code='delivery.outcome_unknown',updated_at=clock_timestamp()
    FROM unconfirmed u WHERE a.workspace_id=u.workspace_id AND a.id=u.id
  RETURNING a.workspace_id,a.invitation_id
)
UPDATE app.workspace_invitations i
   SET delivery_status='unknown',updated_at=clock_timestamp()
  FROM scrubbed a WHERE i.workspace_id=a.workspace_id AND i.id=a.invitation_id;--> statement-breakpoint
ALTER TABLE app.inbox_receipts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app.outbox_events FORCE ROW LEVEL SECURITY;
