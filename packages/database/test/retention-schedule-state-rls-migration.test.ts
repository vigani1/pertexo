import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../migrations/0074_retention_schedule_state_rls.sql',
  import.meta.url,
);

describe('retention schedule state RLS migration', () => {
  it('forces RLS while keeping maintenance access function-only', async () => {
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain(
      'ALTER TABLE app.retention_schedule_state ENABLE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'ALTER TABLE app.retention_schedule_state FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain('TO {{owner_role}}');
    expect(migration).not.toContain('TO {{maintenance_role}}');
    expect(migration).toContain(
      'ALTER FUNCTION app.schedule_workflow_run_input_retention(integer)',
    );
  });
});
