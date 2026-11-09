-- Deployment provisions this superuser-only attribute before the owner migrates.
-- Refuse to remove maintenance policies unless their replacement is effective.
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = '{{maintenance_role}}'::regrole::text) THEN
    RAISE EXCEPTION 'Maintenance role requires BYPASSRLS before row-security migration';
  END IF;
END $$;
--> statement-breakpoint
-- Keep operation-specific and actor-discovery restrictions; only change the
-- workspace comparison and retire the owner/maintenance policy machinery.
DO $$
DECLARE p record; expression text; checked text;
BEGIN
  FOR p IN SELECT * FROM pg_policies WHERE schemaname='app' LOOP
    IF '{{app_role}}'::regrole::text = ANY(p.roles::text[]) THEN
      expression := replace(p.qual,
        '(workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text)',
        'workspace_id = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text)::uuid');
      checked := replace(p.with_check,
        '(workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text)',
        'workspace_id = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text)::uuid');
      expression := replace(expression,
        '(prior_workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text)',
        'prior_workspace_id = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text)::uuid');
      checked := replace(checked,
        '(prior_workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text)',
        'prior_workspace_id = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text)::uuid');
      EXECUTE format('ALTER POLICY %I ON app.%I TO {{app_role}}%s%s', p.policyname,p.tablename,
        CASE WHEN expression IS NULL THEN '' ELSE format(' USING (%s)',expression) END,
        CASE WHEN checked IS NULL THEN '' ELSE format(' WITH CHECK (%s)',checked) END);
    ELSIF '{{owner_role}}'::regrole::text = ANY(p.roles::text[])
       OR '{{maintenance_role}}'::regrole::text = ANY(p.roles::text[]) THEN
      EXECUTE format('DROP POLICY %I ON app.%I',p.policyname,p.tablename);
    END IF;
  END LOOP;
  FOR p IN SELECT relname FROM pg_class WHERE relnamespace='app'::regnamespace AND relforcerowsecurity LOOP
    EXECUTE format('ALTER TABLE app.%I NO FORCE ROW LEVEL SECURITY',p.relname);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER FUNCTION app.claim_due_node_run_wakeups(integer) SECURITY INVOKER;
REVOKE EXECUTE ON FUNCTION app.claim_due_node_run_wakeups(integer) FROM {{app_role}};
GRANT EXECUTE ON FUNCTION app.claim_due_node_run_wakeups(integer) TO {{maintenance_role}};
ALTER FUNCTION app.claim_due_workflow_run_deadlines(integer) SECURITY INVOKER;
REVOKE EXECUTE ON FUNCTION app.claim_due_workflow_run_deadlines(integer) FROM {{app_role}};
GRANT EXECUTE ON FUNCTION app.claim_due_workflow_run_deadlines(integer) TO {{maintenance_role}};
ALTER FUNCTION app.claim_due_trigger_schedules(character varying,integer,integer) SECURITY INVOKER;
REVOKE EXECUTE ON FUNCTION app.claim_due_trigger_schedules(character varying,integer,integer) FROM {{app_role}};
GRANT EXECUTE ON FUNCTION app.claim_due_trigger_schedules(character varying,integer,integer) TO {{maintenance_role}};
ALTER FUNCTION app.discover_due_coordinated_events(integer) SECURITY INVOKER;
REVOKE EXECUTE ON FUNCTION app.discover_due_coordinated_events(integer) FROM {{app_role}};
GRANT EXECUTE ON FUNCTION app.discover_due_coordinated_events(integer) TO {{maintenance_role}};
ALTER FUNCTION app.claim_workspace_inbox_events(integer) SECURITY INVOKER;
REVOKE EXECUTE ON FUNCTION app.claim_workspace_inbox_events(integer) FROM {{app_role}};
GRANT EXECUTE ON FUNCTION app.claim_workspace_inbox_events(integer) TO {{maintenance_role}};
ALTER FUNCTION app.claim_due_run_failure_notification_recoveries(integer) SECURITY INVOKER;
REVOKE EXECUTE ON FUNCTION app.claim_due_run_failure_notification_recoveries(integer) FROM {{app_role}};
GRANT EXECUTE ON FUNCTION app.claim_due_run_failure_notification_recoveries(integer) TO {{maintenance_role}};

-- Claims retain their existing transactions and locks under the maintenance login.
GRANT UPDATE ON app.node_runs, app.trigger_schedules,
  app.run_failure_notification_intents TO {{maintenance_role}};
GRANT UPDATE(deadline_wakeup_at) ON app.workflow_runs TO {{maintenance_role}};
GRANT INSERT, UPDATE ON app.workspace_inbox_threads TO {{maintenance_role}};
GRANT INSERT ON app.run_failure_notification_audit_facts TO {{maintenance_role}};
GRANT USAGE ON SEQUENCE app.workspace_inbox_revision_seq TO {{maintenance_role}};
GRANT UPDATE ON app.workspace_inbox_events TO {{maintenance_role}};
ALTER FUNCTION app.release_trigger_schedule_claim(uuid,uuid) SECURITY INVOKER;
REVOKE EXECUTE ON FUNCTION app.release_trigger_schedule_claim(uuid,uuid) FROM {{app_role}};
GRANT EXECUTE ON FUNCTION app.release_trigger_schedule_claim(uuid,uuid) TO {{maintenance_role}};
ALTER FUNCTION app.store_trigger_schedule_retirement(uuid,uuid,text,text,timestamptz) SECURITY INVOKER;
REVOKE EXECUTE ON FUNCTION app.store_trigger_schedule_retirement(uuid,uuid,text,text,timestamptz) FROM {{app_role}};
GRANT EXECUTE ON FUNCTION app.store_trigger_schedule_retirement(uuid,uuid,text,text,timestamptz) TO {{maintenance_role}};
GRANT UPDATE ON app.workflow_triggers TO {{maintenance_role}};

-- The recipient policy delegates its workspace comparison to this predicate.
CREATE OR REPLACE FUNCTION app.workspace_inbox_recipient_eligible(p_workspace_id uuid,p_user_id uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path TO pg_catalog,app AS $$
 SELECT p_workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid AND p_user_id::text=NULLIF(current_setting('app.actor_id',true),'') AND EXISTS(
 SELECT 1 FROM app.workspace_memberships m JOIN app.workspaces w ON w.id=m.workspace_id JOIN app.users u ON u.id=m.user_id WHERE m.workspace_id=p_workspace_id AND m.user_id=p_user_id AND m.status='active' AND w.status IN ('active','suspended') AND u.status='active');
$$;
