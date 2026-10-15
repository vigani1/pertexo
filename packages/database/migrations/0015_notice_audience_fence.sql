-- Matching application readers enforce audiences before this SQL fence is reduced.
ALTER POLICY workspace_inbox_threads_recipient_select ON app.workspace_inbox_threads USING (
  workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'') AND (
    NULLIF(current_setting('app.actor_id',true),'') IS NULL OR
    app.workspace_inbox_recipient_eligible(workspace_id,NULLIF(current_setting('app.actor_id',true),'')::uuid)
  )
);
--> statement-breakpoint
DROP FUNCTION app.workspace_notice_visible(uuid,varchar,uuid,uuid,uuid);
