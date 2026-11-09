-- Unreleased cleanup: serving requests use app organization context, never maintenance.
-- Keep this slot so the existing 0119 history does not need renumbering.
DROP FUNCTION IF EXISTS app.password_credential_count(uuid);
