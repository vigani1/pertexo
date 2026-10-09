-- The connection checks a run makes (the dispatch fence, the dispatch
-- binding, the credential-access audit, health observations and their
-- application, and the notification connection lock) run as statements in
-- TypeScript in the caller's transaction. The health "protocol" trigger only
-- checked a marker every writer set, and purge already removes a deleted
-- observation's outbox event, so both triggers go.

DROP FUNCTION app.apply_connection_health_observation(uuid, uuid, text, uuid, text);
DROP FUNCTION app.audit_connection_secret_access(uuid, uuid, uuid, text, text, text, text);
DROP FUNCTION app.bind_node_attempt_connection_dispatch(uuid, uuid, text, bigint, uuid, uuid);
DROP FUNCTION app.connection_dispatch_fence_current(uuid, uuid, text, text, uuid);
DROP FUNCTION app.lock_notification_connection(uuid, uuid);
DROP FUNCTION app.record_node_attempt_connection_health(uuid, uuid, text, bigint, text, text, text, uuid, uuid);
DROP TRIGGER connections_health_protocol ON app.connections;
DROP FUNCTION app.enforce_connection_health_protocol();
DROP TRIGGER connection_health_observations_command_cleanup ON app.connection_health_observations;
DROP FUNCTION app.cleanup_connection_health_command();

GRANT INSERT ON app.node_attempt_connection_dispatches TO {{app_role}};
GRANT INSERT ON app.connection_health_observations TO {{app_role}};
GRANT UPDATE (applied_at) ON app.connection_health_observations TO {{app_role}};
