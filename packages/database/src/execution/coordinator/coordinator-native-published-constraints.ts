// Fresh source expectations only. Installed expression identity is deliberately
// unqualified: no catalog presence or source digest grants native readiness.
type NativePublishedConstraintExpectation = Readonly<{
  relation: string;
  name: string;
  sourceSha256: string;
  sourceDefinition: string;
  qualifiedExpressionMd5: string | null;
}>;
export const NATIVE_PUBLISHED_CONSTRAINT_INVENTORY: readonly [
  NativePublishedConstraintExpectation,
] = [
  {
    relation: 'app.workflow_versions',
    name: 'workflow_versions_schema_version_supported',
    sourceSha256:
      '478158764f81629ae2afd713a40f096015cfa34fc14b0d375b62a70ec6f21a3d',
    sourceDefinition:
      "ALTER TABLE app.workflow_versions ADD CONSTRAINT workflow_versions_schema_version_supported CHECK ((\n  schema_version=1\n  OR (schema_version=2 AND graph_json->'schemaVersion'='2'::jsonb\n    AND checksum ~ '^wf:v3:sha256:[0-9a-f]{64}$' AND executable_schema_version=3\n    AND executable_json->'schemaVersion'='3'::jsonb\n    AND jsonb_typeof(executable_json->'graph')='object'\n    AND (graph_json->'callable') IS NOT DISTINCT FROM (executable_json#>'{graph,callable}')\n    AND compatibility_release_epoch>0)\n) IS TRUE);",
    qualifiedExpressionMd5: null,
  },
];
