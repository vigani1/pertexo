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
const appRole = 'pertexo_app';
const maintenanceRole = 'pertexo_maintenance';
const databaseName = `pertexo_test_schema_${randomUUID().replaceAll('-', '')}`;
const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', appRole, maintenanceRole],
  databaseName,
  ownerRole: 'pertexo_owner',
});
const migrationUrl = fixture.databaseUrl(migrationBaseUrl);
const owner = new Pool({ connectionString: migrationUrl, max: 1 });

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

beforeAll(async () => {
  await fixture.create();
  await migrateDatabase({
    appRole,
    connectionString: migrationUrl,
    maintenanceRole,
    ownerRole: 'pertexo_owner',
  });
}, 60_000);

afterAll(async () => {
  const failures: unknown[] = [];
  try {
    await owner.end();
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    await fixture.drop();
  } catch (error: unknown) {
    failures.push(error);
  }
  if (failures.length > 0)
    throw new AggregateError(failures, 'Schema fixture cleanup failed');
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
    const typedNames = Object.values(databaseSchema).map((table) =>
      getTableName(table),
    );
    expect(new Set(typedNames).size).toBe(typedNames.length);
    expect([...actualByTable.keys()].sort()).toEqual(typedNames.sort());

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

  it('keeps every table owned, keyed, tenant-isolated and privately granted', async () => {
    const catalog = await owner.query<{
      has_primary_key: boolean;
      has_workspace_id: boolean;
      owner_name: string;
      relforcerowsecurity: boolean;
      relname: string;
      relrowsecurity: boolean;
    }>(
      `select class.relname,class.relrowsecurity,class.relforcerowsecurity,
              pg_get_userbyid(class.relowner) owner_name,
              exists(select 1 from pg_constraint
                      where conrelid=class.oid and contype='p') has_primary_key,
              exists(select 1 from pg_attribute
                      where attrelid=class.oid and attname='workspace_id'
                        and not attisdropped) has_workspace_id
         from pg_class class
         join pg_namespace namespace on namespace.oid=class.relnamespace
        where namespace.nspname='app' and class.relkind='r'`,
    );
    const grants = await owner.query<{
      grantee: string;
      is_grantable: boolean;
      privilege_type: string;
      table_name: string;
    }>(
      `select distinct class.relname table_name,acl.privilege_type,acl.is_grantable,
              case when acl.grantee=0 then 'PUBLIC'
                   else pg_get_userbyid(acl.grantee) end grantee
         from pg_class class
         join pg_namespace namespace on namespace.oid=class.relnamespace
         cross join lateral aclexplode(
           coalesce(class.relacl,acldefault('r',class.relowner))) acl
        where namespace.nspname='app' and class.relkind='r'`,
    );
    const grantsByTable = Map.groupBy(
      grants.rows,
      ({ table_name: tableName }) => tableName,
    );
    const runtimeRoles = new Set([appRole, maintenanceRole]);

    expect(catalog.rows.length).toBeGreaterThan(0);
    for (const table of catalog.rows) {
      expect(table.owner_name, table.relname).toBe('pertexo_owner');
      expect(table.has_primary_key, table.relname).toBe(true);
      if (table.has_workspace_id) {
        expect(table.relrowsecurity, table.relname).toBe(true);
        expect(table.relforcerowsecurity, table.relname).toBe(true);
      }
      for (const grant of grantsByTable.get(table.relname) ?? []) {
        if (grant.grantee === 'pertexo_owner') continue;
        const label = `${table.relname}:${grant.grantee}:${grant.privilege_type}`;
        expect(runtimeRoles, label).toContain(grant.grantee);
        expect(['DELETE', 'INSERT', 'SELECT', 'UPDATE'], label).toContain(
          grant.privilege_type,
        );
        expect(grant.is_grantable, label).toBe(false);
      }
    }
  });

  it('keeps PUBLIC visible when probing table ACL grantees', async () => {
    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query('grant select on app.artifacts to public');
      const result = await owner.query<{ grantee: string }>(
        `select distinct case when acl.grantee=0 then 'PUBLIC'
                              else pg_get_userbyid(acl.grantee) end grantee
           from pg_class class
           join pg_namespace namespace on namespace.oid=class.relnamespace
           cross join lateral aclexplode(
             coalesce(class.relacl,acldefault('r',class.relowner))) acl
          where namespace.nspname='app' and class.relname='artifacts'`,
      );
      expect(result.rows.map(({ grantee }) => grantee)).toContain('PUBLIC');
    } finally {
      await owner.query('rollback');
    }
  });
});
