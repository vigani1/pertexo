import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('operator maintenance rerun migration', () => {
  it('keeps destructive execution under maintenance authority', async () => {
    const migration = await readFile(
      new URL(
        '../migrations/0066_operator_maintenance_rerun.sql',
        import.meta.url,
      ),
      'utf8',
    );
    expect(migration).toContain(
      'CREATE FUNCTION app.request_operator_maintenance_rerun(',
    );
    expect(migration).toContain(
      'CREATE FUNCTION app.process_operator_maintenance_rerun()',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION app.process_operator_maintenance_rerun()',
    );
    expect(migration).toContain('TO {{maintenance_role}}');
    expect(migration).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]*\{\{operator_role\}\}/u,
    );
  });
});
