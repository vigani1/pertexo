import assert from 'node:assert/strict';
import test from 'node:test';

import { validateDatabaseSchemaOwnership } from './validate-database-schema.mjs';

test('accounts for every migration-owned application table', async () => {
  assert.deepEqual(await validateDatabaseSchemaOwnership(), {
    migrationTableCount: 68,
    typedTableCount: 49,
    rawSqlTableCount: 19,
  });
});
