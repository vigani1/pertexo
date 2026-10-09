-- A favorite is a row: a member marks a workflow, unmarks it by deleting the
-- row, and loses their favorites when they leave the workspace
-- (src/authoring/organization/favorites.repository.ts). Revisions, absence
-- tokens, membership generations, receipts and held evidence go, with the
-- organization rollout switch and the coordination lock row they used.

DROP POLICY workflow_favorites_actor ON app.workflow_favorites;

DROP TRIGGER workflow_favorite_membership_departure ON app.workspace_memberships;

-- Favorites from an earlier membership were hidden by their generation, and
-- earlier unfavorites were kept as false rows for retries; neither is a
-- favorite.
DELETE FROM app.workflow_favorites marked
USING app.workflow_favorite_membership_generations membership
WHERE membership.workspace_id = marked.workspace_id
  AND membership.actor_id = marked.actor_id
  AND membership.generation <> marked.generation;
DELETE FROM app.workflow_favorites WHERE NOT favorite;

ALTER TABLE app.workflow_favorites
  DROP CONSTRAINT workflow_favorites_workspace_id_actor_id_fkey;
DROP TABLE app.workflow_favorite_receipts;
DROP TABLE app.workflow_favorite_held_evidence;
DROP TABLE app.workflow_favorite_membership_generations;
DROP TABLE app.workflow_organization_coordination;
DROP TABLE app.workflow_organization_rollout;

DROP FUNCTION app.invalidate_workflow_favorite_membership();
DROP FUNCTION app.execute_workflow_favorite_command(uuid, text, jsonb, uuid, bigint, bigint);
DROP FUNCTION app.prepare_workflow_favorite_command(uuid, text, jsonb);
DROP FUNCTION app.workflow_favorite_command_body(jsonb);
DROP FUNCTION app.read_workflow_favorite_generation();
DROP FUNCTION app.lock_workflow_favorite_generation(boolean);
DROP FUNCTION app.current_workflow_favorite_generation();
DROP FUNCTION app.lock_workflow_organization_authority(text[]);
DROP FUNCTION app.lock_workflow_organization_coordination(boolean);
DROP FUNCTION app.assert_workflow_organization_writes_enabled();

ALTER TABLE app.workflow_favorites
  DROP COLUMN generation,
  DROP COLUMN favorite,
  DROP COLUMN revision,
  DROP COLUMN expires_at;

-- Favorites are private: every favorites query names its actor. Removing a
-- member deletes their favorites in the remover's transaction.
CREATE POLICY workflow_favorites_workspace_scope ON app.workflow_favorites
  TO {{app_role}}
  USING (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''));
GRANT INSERT, DELETE ON app.workflow_favorites TO {{app_role}};
