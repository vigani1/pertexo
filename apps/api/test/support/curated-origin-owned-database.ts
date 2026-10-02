import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrateDatabase } from '@pertexo/database/testing';

/** Opt-in caller only. Never consults DATABASE_URL or a default/user port. */
export function createCuratedOriginOwnedDatabase() {
  const name = `pertexo_test_f06_guard_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const host = '127.0.0.1:55438';
  const adminUrl = `postgresql://postgres:pertexo-local-superuser@${host}/postgres`;
  const migrationUrl = `postgresql://pertexo_migration:pertexo-local-migration@${host}/${name}`;
  const apiUrl = `postgresql://pertexo_api:pertexo-local-api@${host}/${name}`;
  const workerUrl = `postgresql://pertexo_worker:pertexo-local-worker@${host}/${name}`;
  const inspectorUrl = `postgresql://postgres:pertexo-local-superuser@${host}/${name}`;
  let created = false;
  return {
    name,
    migrationUrl,
    apiUrl,
    workerUrl,
    inspectorUrl,
    async create() {
      const admin = new Pool({ connectionString: adminUrl, max: 1 });
      try {
        await admin.query(`create database "${name}" owner pertexo_owner`);
        created = true;
        await admin.query(`revoke all on database "${name}" from public`);
        await admin.query(
          `grant connect on database "${name}" to pertexo_migration,pertexo_api,pertexo_worker`,
        );
      } finally {
        await admin.end();
      }
      await migrateDatabase({
        connectionString: migrationUrl,
        ownerRole: 'pertexo_owner',
        apiRuntimeRole: 'pertexo_api',
        workerRuntimeRole: 'pertexo_worker',
        dispatcherRole: 'pertexo_dispatcher',
        maintenanceRole: 'pertexo_maintenance',
        lifecycleCommandRole: 'pertexo_lifecycle_command',
        operatorRole: 'pertexo_operator',
      });
    },
    async drop() {
      const admin = new Pool({ connectionString: adminUrl, max: 1 });
      try {
        if (created) {
          const deadline = Date.now() + 10_000;
          for (;;) {
            const remaining = await admin.query<{ count: number }>(
              'select count(*)::int count from pg_stat_activity where datname=$1',
              [name],
            );
            if (remaining.rows[0]?.count === 0) break;
            if (Date.now() >= deadline)
              throw new Error(
                `Owned fixture connections did not close: ${name}`,
              );
            await admin.query('select pg_sleep(0.02)');
          }
          await admin.query(`drop database "${name}"`);
          created = false;
        }
        const remaining = await admin.query(
          'select datname from pg_database where datname=$1 union all select datname from pg_stat_activity where datname=$1',
          [name],
        );
        if (remaining.rows.length !== 0)
          throw new Error(`Owned fixture cleanup incomplete: ${name}`);
      } finally {
        await admin.end();
      }
    },
  };
}
