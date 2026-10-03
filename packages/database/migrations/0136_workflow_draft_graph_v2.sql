-- Editable Graph2 drafts only. Published and executable formats remain unchanged.
ALTER TABLE app.workflow_drafts
  DROP CONSTRAINT workflow_drafts_schema_version_supported,
  ADD CONSTRAINT workflow_drafts_schema_version_supported
    CHECK (schema_version IN (1, 2)),
  ADD CONSTRAINT workflow_drafts_graph_schema_consistent
    CHECK ((jsonb_typeof(graph_json -> 'schemaVersion') = 'number'
      AND graph_json -> 'schemaVersion' = to_jsonb(schema_version)) IS TRUE);
