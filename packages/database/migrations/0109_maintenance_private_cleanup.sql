-- Directory detachment during purge already used this authority on the retired
-- capability (0034). Keep the same narrow removed-membership checks for workers.
GRANT EXECUTE ON FUNCTION app.delete_removed_member_private_rows(uuid,uuid[],regclass) TO {{maintenance_role}};
