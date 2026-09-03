-- retention_schedule_state is workspace-keyed maintenance state. Keep direct
-- access owner-only while bringing it under the same forced-RLS convention as
-- every other tenant-scoped table. Maintenance callers continue to execute the
-- SECURITY DEFINER scheduling function rather than receiving table grants.

ALTER TABLE app.retention_schedule_state OWNER TO {{owner_role}};
ALTER TABLE app.retention_schedule_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.retention_schedule_state FORCE ROW LEVEL SECURITY;

CREATE POLICY retention_schedule_state_owner_all
  ON app.retention_schedule_state
  FOR ALL
  TO {{owner_role}}
  USING (true)
  WITH CHECK (true);

ALTER FUNCTION app.provision_retention_schedule_state()
  OWNER TO {{owner_role}};
ALTER FUNCTION app.schedule_workflow_run_input_retention(integer)
  OWNER TO {{owner_role}};
