import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateDatabaseSchemaOwnership,
  validateDatabaseSchemaSources,
} from './validate-database-schema.mjs';

const validSources = Object.freeze({
  migrationSql: `
    CREATE TABLE app.first_table(id uuid primary key);
    CREATE TABLE app.second_table(id uuid primary key);
  `,
  schemaSource: `
    export const firstTable = appSchema.table('first_table');
    export const secondTable = appSchema.table('second_table');
  `,
});

test('types every migration-owned application table', async () => {
  assert.deepEqual(await validateDatabaseSchemaOwnership(), {
    tableCount: 133,
  });
});

test('validates a minimal typed inventory', () => {
  assert.deepEqual(validateDatabaseSchemaSources(validSources), {
    tableCount: 2,
  });
});

test('reads Drizzle quoted identifiers and mixed quoted migration history', () => {
  const quoted = `
    CREATE TABLE "app"."first_table"(id uuid primary key);
    CREATE TABLE app."second_table"(id uuid primary key);
    CREATE TABLE "app".retired_table(id uuid primary key);
    DROP TABLE IF EXISTS "app"."retired_table";
  `;
  assert.deepEqual(
    validateDatabaseSchemaSources({ ...validSources, migrationSql: quoted }),
    { tableCount: 2 },
  );
  assert.throws(
    () =>
      validateDatabaseSchemaSources({
        ...validSources,
        migrationSql: `${quoted}\nCREATE TABLE "app"."untyped"(id uuid primary key);`,
      }),
    /Migration tables without a typed schema: untyped/u,
  );
});

test('ignores tables a later migration drops', () => {
  const retired = `${validSources.migrationSql}
    CREATE TABLE app.retired_table(id uuid primary key);
    DROP TABLE app.retired_table;`;
  assert.deepEqual(
    validateDatabaseSchemaSources({ ...validSources, migrationSql: retired }),
    { tableCount: 2 },
  );
  assert.throws(
    () =>
      validateDatabaseSchemaSources({
        ...validSources,
        migrationSql: `${validSources.migrationSql}\nDROP TABLE IF EXISTS app.first_table;`,
      }),
    /Typed tables absent from migrations: first_table/u,
  );
});

test('rejects untyped and missing tables and UUID defaults', () => {
  assert.throws(
    () =>
      validateDatabaseSchemaSources({
        ...validSources,
        schemaSource:
          "export const firstTable = appSchema.table('first_table');",
      }),
    /Migration tables without a typed schema: second_table/u,
  );
  assert.throws(
    () =>
      validateDatabaseSchemaSources({
        ...validSources,
        schemaSource: `${validSources.schemaSource}\nexport const missing = appSchema.table('missing_table');`,
      }),
    /Typed tables absent from migrations: missing_table/u,
  );
  assert.throws(
    () =>
      validateDatabaseSchemaSources({
        ...validSources,
        migrationSql: `${validSources.migrationSql}\nALTER TABLE app.first_table ALTER COLUMN id SET DEFAULT gen_random_uuid();`,
      }),
    /Persisted UUID defaults must be generated explicitly/u,
  );
});

test('applies chained quoted and bare table renames in statement order without treating column renames as tables', () => {
  assert.deepEqual(
    validateDatabaseSchemaSources({
      migrationSql: `CREATE TABLE app.old_table(id uuid primary key);
      ALTER TABLE "app"."old_table" RENAME TO "intermediate";
      ALTER TABLE app.intermediate RENAME COLUMN id TO entry_id;
      ALTER TABLE "app".intermediate RENAME TO final_table;
      CREATE TABLE app.retired(id uuid primary key);
      ALTER TABLE app.retired RENAME TO dropped;
      DROP TABLE app.dropped;`,
      schemaSource: `export const finalTable = appSchema.table('final_table');`,
    }),
    { tableCount: 1 },
  );
});
