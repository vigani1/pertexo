-- Core checks active standing with the workspace fence before any enabling write.
-- Session revocation remains a separate security-integrity rule for every writer.
DROP TRIGGER connections_require_active_workspace ON app.connections;
DROP TRIGGER notification_destinations_require_active_workspace ON app.failure_notification_destinations;
DROP TRIGGER trigger_schedules_require_active_workspace ON app.trigger_schedules;
DROP TRIGGER webhook_endpoints_require_active_workspace ON app.webhook_trigger_endpoints;
DROP TRIGGER workflow_triggers_require_active_workspace ON app.workflow_triggers;
DROP FUNCTION app.require_active_workspace_integration();
