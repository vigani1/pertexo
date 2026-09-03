import assert from 'node:assert/strict';
import test from 'node:test';

import { validateDatabaseSchemaOwnership } from './validate-database-schema.mjs';

test('accounts for every migration-owned application table', async () => {
  await assert.doesNotReject(async () => {
    assert.deepEqual(await validateDatabaseSchemaOwnership(), {
      migrationTableCount: 67,
      typedTableCount: 48,
      rawSqlTableCount: 19,
    });
  });
});
