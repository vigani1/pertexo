-- Workspace rename, invitation and member commands keep their command keys
-- in idempotency_records through platform/idempotency.ts, like every other
-- workspace command, so their seven receipt tables go. Profile commands
-- belong to a user rather than a workspace and keep their receipt table.

DROP TABLE app.workspace_rename_command_receipts;
DROP TABLE app.workspace_invitation_command_receipts;
DROP TABLE app.workspace_member_role_command_receipts;
DROP TABLE app.workspace_member_removal_command_receipts;
DROP TABLE app.workspace_member_departure_command_receipts;
DROP TABLE app.workspace_member_suspension_command_receipts;
DROP TABLE app.workspace_ownership_transfer_command_receipts;
