-- Run-input case commands check authority, limits and revisions once, in
-- TypeScript (src/authoring/workflow-input-cases.ts), with command keys in
-- idempotency_records. The write trigger that re-checked all of it and the
-- rollout switch go; column grants keep a case's workflow and version fixed.

DROP TRIGGER workflow_input_cases_write_guard ON app.workflow_input_cases;
DROP TRIGGER workflow_input_case_payloads_write_guard ON app.workflow_input_case_payloads;
DROP TRIGGER workflow_input_case_receipts_write_guard ON app.workflow_input_case_receipts;
DROP FUNCTION app.guard_workflow_input_case_write();
DROP FUNCTION app.assert_workflow_input_cases_enabled();
DROP TABLE app.workflow_input_case_receipts;
DROP TABLE app.workflow_input_case_rollout;

REVOKE UPDATE ON app.workflow_input_cases FROM {{app_role}};
GRANT UPDATE (name, revision, updated_at, deleted_at)
  ON app.workflow_input_cases TO {{app_role}};
