DROP INDEX "app"."pending_run_tasks_callback_inventory_idx";--> statement-breakpoint
CREATE INDEX "pending_run_tasks_callback_inventory_idx" ON "app"."pending_run_tasks" USING btree ("callback_key_version" collate "C","id") WHERE kind='callback' and consumed_at is null and status in ('prepared','pending','submitted');
--> statement-breakpoint
DROP FUNCTION app.pending_callback_key_inventory(uuid);
--> statement-breakpoint
CREATE FUNCTION app.pending_callback_key_inventory(p_after text)
RETURNS TABLE(id uuid,callback_token_hash char(64),callback_key_version varchar)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO pg_catalog,app SET row_security TO on AS $$
 -- Seek past each version instead of scanning every live callback.
 WITH RECURSIVE samples AS (
   (SELECT task.id,task.callback_token_hash,task.callback_key_version,1 AS sample_number
    FROM app.pending_run_tasks task
    WHERE task.kind='callback' AND task.consumed_at IS NULL AND task.status IN ('prepared','pending','submitted')
      AND task.callback_key_version COLLATE "C">coalesce(p_after,'') COLLATE "C"
    ORDER BY task.callback_key_version COLLATE "C",task.id LIMIT 1)
   UNION ALL
   SELECT candidate.id,candidate.callback_token_hash,candidate.callback_key_version,previous.sample_number+1
   FROM samples previous CROSS JOIN LATERAL (
     SELECT task.id,task.callback_token_hash,task.callback_key_version
     FROM app.pending_run_tasks task
     WHERE task.kind='callback' AND task.consumed_at IS NULL AND task.status IN ('prepared','pending','submitted')
       AND task.callback_key_version COLLATE "C">previous.callback_key_version COLLATE "C"
     ORDER BY task.callback_key_version COLLATE "C",task.id LIMIT 1
   ) candidate WHERE previous.sample_number<250
 ) SELECT id,callback_token_hash,callback_key_version FROM samples ORDER BY callback_key_version COLLATE "C"
$$;
REVOKE ALL ON FUNCTION app.pending_callback_key_inventory(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pending_callback_key_inventory(text) TO {{app_role}};
