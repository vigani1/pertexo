-- ADR 027: the public API may accept and read lifecycle operations but cannot
-- directly project workspace deletion or restore state.

REVOKE UPDATE (
  status,deletion_requested_at,deletion_requested_by,deletion_reason,
  purge_after
) ON app.workspaces FROM {{api_runtime_role}};
