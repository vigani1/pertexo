import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migration = await readFile(
  new URL(
    '../migrations/0082_legal_hold_destruction_serialization.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('legal hold destruction serialization migration', () => {
  it('locks destructive authority before the workspace lifecycle row', () => {
    expect(migration).toMatch(
      /pg_advisory_xact_lock[\s\S]*SELECT \* INTO STRICT v_workspace/u,
    );
    expect(migration).toContain('1934781127');
  });
});
