-- Keep provider-idempotent invitation delivery payloads stable when a
-- workspace is renamed between an uncertain dispatch and its retry.
ALTER TABLE app.workspace_invitation_delivery_attempts
  ADD COLUMN workspace_name varchar(256);

UPDATE app.workspace_invitation_delivery_attempts attempt
   SET workspace_name = workspace.name
  FROM app.workspaces workspace
 WHERE workspace.id = attempt.workspace_id;

ALTER TABLE app.workspace_invitation_delivery_attempts
  ALTER COLUMN workspace_name SET NOT NULL;
