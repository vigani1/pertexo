import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('operator command ledger migration', () => {
  it('broadens bounded status without granting generic table authority', async () => {
    const migration = await readFile(
      new URL(
        '../migrations/0062_operator_command_ledger.sql',
        import.meta.url,
      ),
      'utf8',
    );
    expect(migration).toContain("'attempt.reconcile'");
    expect(migration).toContain("'purge.rerun'");
    expect(migration).toContain('octet_length(result::text)<=16384');
    expect(migration).toContain("audit.action LIKE 'operator.%'");
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION app.get_operator_command(uuid,uuid,varchar,varchar)',
    );
    expect(migration).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)/u);
  });
});
