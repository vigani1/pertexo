-- Readiness proves the database can still store new data, not just answer. Writing
-- into an existing row keeps working on a full disk, so the probe empties this table
-- and inserts again, which makes PostgreSQL extend a file. See checkDatabaseWrites.
CREATE TABLE pertexo_internal.write_probe (
  checked_at timestamptz NOT NULL DEFAULT now()
);
GRANT INSERT, TRUNCATE ON pertexo_internal.write_probe TO {{app_role}};
