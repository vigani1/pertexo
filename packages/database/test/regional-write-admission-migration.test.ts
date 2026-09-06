import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/platform/readiness.js';

const migrationUrl = new URL(
  '../migrations/0069_regional_write_admission.sql',
  import.meta.url,
);

describe('regional write admission migration contract', () => {
  it('fails closed at five minutes behind a fresh monitored replica', async () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe('0081_schedule_claim_concurrency.sql');
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain('p_replay_lag_millis<300000');
    expect(migration).toContain("interval '15 seconds'");
    expect(migration).toContain("ERRCODE='PTA03'");
    expect(migration).toContain('TO {{maintenance_role}}');
    expect(migration).not.toContain(
      'GRANT SELECT ON app.regional_write_admission',
    );
  });
});
