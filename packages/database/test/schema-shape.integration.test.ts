import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { getTableColumns, getTableName } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../src/migrations.js';
import { databaseSchema } from '../src/schema.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const databaseName = `pertexo_test_schema_${randomUUID().replaceAll('-', '')}`;
const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: [
    'pertexo_migration',
    'pertexo_api',
    'pertexo_dispatcher',
    'pertexo_lifecycle_command',
    'pertexo_maintenance',
    'pertexo_operator',
    'pertexo_worker',
  ],
  databaseName,
  ownerRole: 'pertexo_owner',
});
const migrationUrl = fixture.databaseUrl(migrationBaseUrl);
const owner = new Pool({ connectionString: migrationUrl, max: 1 });

type RawTableContract = Readonly<{
  accessRoles: readonly string[];
  name: string;
  rls: 'forced' | 'not_applicable';
}>;

function expectedColumnShape(value: unknown): Readonly<{
  column_name: string;
  is_not_null: boolean;
}> {
  if (typeof value !== 'object' || value === null)
    throw new Error('Drizzle column metadata must be an object');
  const name: unknown = Reflect.get(value, 'name');
  const notNull: unknown = Reflect.get(value, 'notNull');
  if (typeof name !== 'string' || typeof notNull !== 'boolean')
    throw new Error('Drizzle column metadata has an invalid shape');
  return { column_name: name, is_not_null: notNull };
}

const roleNames: Readonly<Record<string, string>> = Object.freeze({
  api_runtime_role: 'pertexo_api',
  dispatcher_role: 'pertexo_dispatcher',
  lifecycle_command_role: 'pertexo_lifecycle_command',
  maintenance_role: 'pertexo_maintenance',
  operator_role: 'pertexo_operator',
  worker_runtime_role: 'pertexo_worker',
});

beforeAll(async () => {
  await fixture.create();
  await migrateDatabase({
    apiRuntimeRole: roleNames.api_runtime_role ?? '',
    connectionString: migrationUrl,
    dispatcherRole: roleNames.dispatcher_role ?? '',
    lifecycleCommandRole: roleNames.lifecycle_command_role ?? '',
    maintenanceRole: roleNames.maintenance_role ?? '',
    operatorRole: roleNames.operator_role ?? '',
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: roleNames.worker_runtime_role ?? '',
  });
}, 60_000);

afterAll(async () => {
  await owner.end();
  await fixture.drop();
});

describe('migrated schema shape contract', () => {
  it('matches every typed table column name and nullability', async () => {
    const result = await owner.query<{
      column_name: string;
      is_not_null: boolean;
      table_name: string;
    }>(
      `select class.relname table_name,attribute.attname column_name,
              attribute.attnotnull is_not_null
         from pg_class class
         join pg_namespace namespace on namespace.oid=class.relnamespace
         join pg_attribute attribute on attribute.attrelid=class.oid
        where namespace.nspname='app' and class.relkind='r'
          and attribute.attnum > 0 and not attribute.attisdropped
        order by class.relname,attribute.attnum`,
    );
    const actualByTable = Map.groupBy(
      result.rows,
      ({ table_name: tableName }) => tableName,
    );

    for (const table of Object.values(databaseSchema)) {
      const tableName = getTableName(table);
      const columns: unknown = getTableColumns(table);
      if (typeof columns !== 'object' || columns === null)
        throw new Error(`Typed table ${tableName} has no column metadata`);
      const expected = Object.values(columns)
        .map(expectedColumnShape)
        .sort((left, right) =>
          left.column_name.localeCompare(right.column_name),
        );
      const actual = (actualByTable.get(tableName) ?? [])
        .map(({ column_name, is_not_null }) => ({
          column_name,
          is_not_null,
        }))
        .sort((left, right) =>
          left.column_name.localeCompare(right.column_name),
        );
      expect(actual, tableName).toEqual(expected);
    }
  });

  it('enforces registered raw-table RLS, grants, keys, and indexes', async () => {
    const registry = JSON.parse(
      await readFile(
        new URL('../raw-sql-table-registry.json', import.meta.url),
        'utf8',
      ),
    ) as RawTableContract[];
    const catalog = await owner.query<{
      has_index: boolean;
      has_primary_key: boolean;
      relforcerowsecurity: boolean;
      relname: string;
      relrowsecurity: boolean;
    }>(
      `select class.relname,class.relrowsecurity,class.relforcerowsecurity,
              exists(select 1 from pg_index where indrelid=class.oid) has_index,
              exists(select 1 from pg_constraint
                      where conrelid=class.oid and contype='p') has_primary_key
         from pg_class class
         join pg_namespace namespace on namespace.oid=class.relnamespace
        where namespace.nspname='app' and class.relkind='r'`,
    );
    const catalogByName = new Map(
      catalog.rows.map((row) => [row.relname, row]),
    );
    const grants = await owner.query<{
      grantee: string;
      table_name: string;
    }>(
      `select distinct class.relname table_name,role.rolname grantee
         from pg_class class
         join pg_namespace namespace on namespace.oid=class.relnamespace
         cross join lateral aclexplode(
           coalesce(class.relacl,acldefault('r',class.relowner))) acl
         join pg_roles role on role.oid=acl.grantee
        where namespace.nspname='app' and class.relkind='r'`,
    );
    const grantsByTable = Map.groupBy(
      grants.rows,
      ({ table_name: tableName }) => tableName,
    );

    for (const contract of registry) {
      const table = catalogByName.get(contract.name);
      expect(table, contract.name).toBeDefined();
      expect(table?.has_primary_key, contract.name).toBe(true);
      expect(table?.has_index, contract.name).toBe(true);
      expect(table?.relrowsecurity, contract.name).toBe(
        contract.rls === 'forced',
      );
      expect(table?.relforcerowsecurity, contract.name).toBe(
        contract.rls === 'forced',
      );
      const actualGrantees = new Set(
        (grantsByTable.get(contract.name) ?? []).map(({ grantee }) => grantee),
      );
      expect(actualGrantees, `${contract.name}:PUBLIC`).not.toContain('PUBLIC');
      const allowedGrantees = new Set([
        'pertexo_owner',
        ...contract.accessRoles.map((role) => roleNames[role]),
      ]);
      for (const grantee of actualGrantees)
        expect(allowedGrantees, `${contract.name}:${grantee}`).toContain(
          grantee,
        );
    }
  });
});
