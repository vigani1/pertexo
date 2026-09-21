import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateDatabaseSchemaOwnership,
  validateDatabaseSchemaSources,
} from './validate-database-schema.mjs';

const validSources = Object.freeze({
  migrationSql: `
    CREATE TABLE app.typed_table(id uuid primary key);
    CREATE TABLE app.raw_table(id uuid primary key);
    ALTER TABLE app.raw_table ENABLE ROW LEVEL SECURITY;
    ALTER TABLE app.raw_table FORCE ROW LEVEL SECURITY;
  `,
  registry: [
    {
      accessRoles: ['worker_runtime_role'],
      name: 'raw_table',
      owner: 'owner_role',
      reason:
        'Raw table behavior is deliberately owned by reviewed SQL functions.',
      rls: 'forced',
    },
  ],
  schemaSource: "export const typedTable = appSchema.table('typed_table');",
});

test('accounts for every migration-owned application table', async () => {
  assert.deepEqual(await validateDatabaseSchemaOwnership(), {
    migrationTableCount: 76,
    typedTableCount: 57,
    rawSqlTableCount: 19,
  });
});

test('validates a minimal typed and raw ownership inventory', () => {
  assert.deepEqual(validateDatabaseSchemaSources(validSources), {
    migrationTableCount: 2,
    typedTableCount: 1,
    rawSqlTableCount: 1,
  });
});

test('rejects invalid raw-table registry fields', () => {
  const invalidEntries = [
    { name: 'Invalid-Name' },
    { owner: 'worker_runtime_role' },
    { accessRoles: [] },
    { accessRoles: ['unknown_role'] },
    { accessRoles: ['worker_runtime_role', 'worker_runtime_role'] },
    { rls: 'enabled' },
    { reason: 'too short' },
  ];
  for (const override of invalidEntries) {
    const entry = {
      ...validSources.registry[0],
      accessRoles: [...validSources.registry[0].accessRoles],
    };
    assert.throws(
      () =>
        validateDatabaseSchemaSources({
          ...validSources,
          registry: [{ ...entry, ...override }],
        }),
      /Invalid raw SQL table registry entry/u,
    );
  }
  assert.throws(
    () => validateDatabaseSchemaSources({ ...validSources, registry: {} }),
    /registry must be an array/u,
  );
});

test('rejects duplicate, typed, absent and unowned raw tables', () => {
  const [entry] = validSources.registry;
  assert.throws(
    () =>
      validateDatabaseSchemaSources({
        ...validSources,
        registry: [entry, entry],
      }),
    /Duplicate raw SQL table registry entry/u,
  );
  assert.throws(
    () =>
      validateDatabaseSchemaSources({
        ...validSources,
        registry: [{ ...entry, name: 'typed_table' }],
      }),
    /Typed table must not be in raw SQL registry/u,
  );
  assert.throws(
    () =>
      validateDatabaseSchemaSources({
        ...validSources,
        registry: [{ ...entry, name: 'absent_table' }],
      }),
    /Registered table is not migration-owned/u,
  );
  assert.throws(
    () =>
      validateDatabaseSchemaSources({
        ...validSources,
        registry: [],
      }),
    /Migration tables without typed schema or registry ownership/u,
  );
});

test('rejects missing typed tables, forbidden UUID defaults and incomplete forced RLS', () => {
  assert.throws(
    () =>
      validateDatabaseSchemaSources({
        ...validSources,
        schemaSource: `${validSources.schemaSource}\nexport const missing = appSchema.table('missing_table');`,
      }),
    /Typed tables absent from migrations/u,
  );
  assert.throws(
    () =>
      validateDatabaseSchemaSources({
        ...validSources,
        migrationSql: `${validSources.migrationSql}\nALTER TABLE app.typed_table ALTER COLUMN id SET DEFAULT gen_random_uuid();`,
      }),
    /Persisted UUID defaults must be generated explicitly/u,
  );
  assert.throws(
    () =>
      validateDatabaseSchemaSources({
        ...validSources,
        migrationSql: validSources.migrationSql.replace(
          'ALTER TABLE app.raw_table FORCE ROW LEVEL SECURITY;',
          '',
        ),
      }),
    /raw_table is registered as forced RLS without FORCE/u,
  );
});
