-- Recovery decisions belong to core. This primitive only claims due queue rows;
-- the caller keeps their locks until scoped intent, audit and outbox writes commit.
DROP FUNCTION app.recover_due_run_failure_notifications(integer,integer);
--> statement-breakpoint
CREATE FUNCTION app.claim_due_run_failure_notification_recoveries(p_limit integer)
RETURNS TABLE(id uuid,workspace_id uuid,status varchar,delivery_attempts integer,side_effect_class varchar,possibly_dispatched boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','app'
SET row_security TO 'on'
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid failure notification claim bound' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
    SELECT intent.id,intent.workspace_id,intent.status,intent.delivery_attempts,intent.side_effect_class,intent.possibly_dispatched
      FROM app.run_failure_notification_intents intent
      WHERE intent.status IN ('claimed','dispatching') AND intent.recovery_at<=clock_timestamp()
      ORDER BY intent.recovery_at,intent.id LIMIT p_limit FOR UPDATE OF intent SKIP LOCKED;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claim_due_run_failure_notification_recoveries(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.claim_due_run_failure_notification_recoveries(integer) TO {{app_role}};
