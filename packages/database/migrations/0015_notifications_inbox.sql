-- Failure notification locks run as statements in TypeScript, and the run
-- and intent pins are checked once, where they are made. Inbox reads only
-- move forward in TypeScript already, and expired inbox threads are a
-- retention rule. A counter repair function nothing calls goes too.

DROP FUNCTION app.lock_failure_notification_dispatch_destination(uuid, uuid, integer);
DROP FUNCTION app.lock_workflow_failure_notification_policy(uuid, uuid);
DROP TRIGGER run_failure_notification_intents_require_run_pin ON app.run_failure_notification_intents;
DROP FUNCTION app.require_new_failure_notification_intent_pin();
DROP TRIGGER workflow_runs_require_new_failure_notification_pin ON app.workflow_runs;
DROP FUNCTION app.validate_workflow_run_failure_notification_pin();
DROP TRIGGER workspace_inbox_reads_monotonic ON app.workspace_inbox_reads;
DROP FUNCTION app.preserve_workspace_inbox_read_revision();
DROP FUNCTION app.expire_workspace_inbox_threads(integer);
DROP FUNCTION app.reconcile_workspace_execution_admission(uuid);
