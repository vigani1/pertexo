import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DATABASE_READINESS_SQL } from '../src/platform/readiness-probe.js';

describe('ordinary draft Graph2 registered storage', () => {
  it('requires the validated Graph2 draft header constraint in readiness', () => {
    expect(DATABASE_READINESS_SQL).toContain(
      'workflow_drafts_graph_schema_consistent',
    );
    expect(DATABASE_READINESS_SQL).toContain('convalidated');
  });
  it('registers draft-only support without rewriting retained rows or enabling native execution', async () => {
    const directory = new URL('../migrations/', import.meta.url);
    expect(await readdir(directory)).toContain(
      '0136_workflow_draft_graph_v2.sql',
    );
    const sql = await readFile(
      new URL('0136_workflow_draft_graph_v2.sql', directory),
      'utf8',
    );
    expect(sql).toContain('CHECK (schema_version IN (1, 2))');
    expect(sql).toContain(
      "jsonb_typeof(graph_json -> 'schemaVersion') = 'number'",
    );
    expect(sql).toContain(
      "graph_json -> 'schemaVersion' = to_jsonb(schema_version)",
    );
    expect(sql).toContain('IS TRUE');
    expect(sql).not.toMatch(
      /\b(?:UPDATE|INSERT|DELETE|GRANT|CREATE\s+(?:FUNCTION|TABLE|TRIGGER))\b/iu,
    );
    expect(sql).not.toContain('workflow_versions');
  });
});
