import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateDatabaseSchemaOwnership,
  validateDatabaseSchemaSources,
  validateTableDictionary,
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
    tableCount: 138,
  });
});

test('inventories formatted chained table declarations', () => {
  assert.deepEqual(
    validateDatabaseSchemaSources({
      ...validSources,
      schemaSource: `export const first = appSchema
      .table('first_table').enableRLS();
      export const second = appSchema . table ('second_table').enableRLS();`,
    }),
    { tableCount: 2 },
  );
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

test('refuses a new SQL rule without an ADR 069 storage category', () => {
  assert.throws(
    () =>
      validateDatabaseSchemaSources({
        ...validSources,
        migrationSql: `${validSources.migrationSql}
        CREATE FUNCTION app.decide_workflow_retry() RETURNS boolean
        LANGUAGE sql AS $$ SELECT true $$;`,
      }),
    /SQL function.*app\.decide_workflow_retry.*category/iu,
  );
});

test('requires each live table in the dictionary and rejects retired entries', () => {
  const tables = new Set(['first_table', 'second_table']);
  assert.throws(
    () =>
      validateTableDictionary(tables, '## Tables\n| `first_table` | First |'),
    /missing live tables: second_table/u,
  );
  assert.throws(
    () =>
      validateTableDictionary(
        new Set(['first_table']),
        '## Tables\n| `first_table` | First |\n| `retired_table` | Old |',
      ),
    /retired tables: retired_table/u,
  );
});

test('keeps column explanations separate from the documented table inventory', () => {
  assert.doesNotThrow(() =>
    validateTableDictionary(
      new Set(['first_table']),
      '# Dictionary\n| `workspace_id` | Tenant identity |\n\n## Tables\n| `first_table`       | First |',
    ),
  );
  assert.throws(
    () => validateTableDictionary(new Set(['first_table']), '# Dictionary'),
    /requires a Tables section/u,
  );
});
