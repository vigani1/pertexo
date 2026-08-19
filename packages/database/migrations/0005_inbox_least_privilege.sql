REVOKE UPDATE ON app.inbox_receipts
  FROM {{api_runtime_role}}, {{worker_runtime_role}};
GRANT UPDATE (completed_at) ON app.inbox_receipts
  TO {{api_runtime_role}}, {{worker_runtime_role}};
