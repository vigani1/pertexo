import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/readiness.js';

describe('transient data retention migration', () => {
  it('defines bounded maintenance-only cleanup with safe claim and hold guards', async () => {
    const migration = await readFile(
      new URL(
        '../migrations/0073_transient_data_retention.sql',
        import.meta.url,
      ),
      'utf8',
    );

    expect(EXPECTED_MIGRATION_HEAD).toBe(
      '0074_retention_schedule_state_rls.sql',
    );
    expect(migration).toContain("interval '24 hours'");
    expect(migration).toContain("interval '30 days'");
    expect(migration).toContain("record.status = 'completed'");
    expect(migration).toContain("record.status IN ('completed', 'failed')");
    expect(migration).toContain('hold.released_sequence IS NULL');
    expect(migration).toContain('LIMIT p_limit');
    expect(migration).toContain('SKIP LOCKED');
    expect(migration).toContain('sessions_retention_idx');
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.reap_transient_data\(integer\)[\s\S]*TO \{\{maintenance_role\}\}/u,
    );
    expect(migration).not.toMatch(
      /GRANT (?:DELETE|UPDATE)[\s\S]*TO \{\{(?:api_runtime_role|worker_runtime_role|dispatcher_role)\}\}/u,
    );
  });
});
