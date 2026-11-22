ALTER TABLE "app"."api_tokens" DROP CONSTRAINT "api_tokens_scopes_valid";--> statement-breakpoint
ALTER TABLE "app"."workflows" ADD COLUMN "mcp_exposure" jsonb;--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ADD COLUMN "mcp_invocation" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_mcp_tool_name_unique" ON "app"."workflows" USING btree ("workspace_id",("mcp_exposure"->>'name')) WHERE "app"."workflows"."mcp_exposure"->>'versionId'="app"."workflows"."published_version_id"::text;--> statement-breakpoint
ALTER TABLE "app"."api_tokens" ADD CONSTRAINT "api_tokens_scopes_valid" CHECK (jsonb_typeof(scopes) = 'array' and jsonb_array_length(scopes) between 1 and 12 and scopes <@ '["workflow:read","workflow:create","workflow:update","workflow:publish","run:read","run:read-data","run:start","mcp:invoke","run:cancel","connection:read","workspace:read","variable:manage"]'::jsonb);
--> statement-breakpoint
GRANT SELECT (mcp_exposure, trigger_pause_state), UPDATE (mcp_exposure)
  ON app.workflows TO pertexo_app;
--> statement-breakpoint
GRANT UPDATE (mcp_invocation) ON app.workflow_runs TO pertexo_maintenance;
