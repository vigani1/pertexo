ALTER TABLE "app"."workspace_data_tables" ADD COLUMN "has_removed_columns" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE app.workspace_data_tables NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE app.workspace_data_tables SET columns_json=(
  SELECT jsonb_agg(column_value || jsonb_build_object('id',column_value->>'name') ORDER BY ordinal)
  FROM jsonb_array_elements(columns_json) WITH ORDINALITY AS columns(column_value,ordinal)
);
--> statement-breakpoint
ALTER TABLE app.workspace_data_tables FORCE ROW LEVEL SECURITY;
