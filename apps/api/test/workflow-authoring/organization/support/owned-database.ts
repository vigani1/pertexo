import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { migrateDatabase } from '@pertexo/database/testing';
import {
  verifyCuratedFixtureOwnership,
  recheckCuratedFixtureOwnership,
  type CuratedOwnedFixture,
} from '../../../../../../infrastructure/testing/curated-template-owned-fixture.mjs';

/** F07 owns its own fresh namespace; canonical attestation never supplies a
 * default port, shared database, or authority to reuse F06 fixture databases. */
export function createWorkflowOrganizationOwnedDatabase() {
  const name = `pertexo_test_f07_organization_${randomBytes(12).toString('hex')}`;
  let attestation: CuratedOwnedFixture | undefined;
  let created = false;
  function connection(role: 'adminUrl' | 'migrationUrl' | 'apiUrl') {
    if (attestation === undefined)
      throw new Error('F07 database ownership has not been attested');
    const url = new URL(attestation[role]);
    url.pathname = `/${name}`;
    return url.toString();
  }
  return {
    get apiUrl() {
      return connection('apiUrl');
    },
    get inspectorUrl() {
      return connection('adminUrl');
    },
    async create() {
      if (process.env.F07_ORGANIZATION_OWNED_FIXTURE !== 'true')
        throw new Error('Explicit F07 ownership flag is required');
      if (created) throw new Error('F07 fixture already exists');
      attestation = await verifyCuratedFixtureOwnership();
      const admin = new Pool({
        connectionString: attestation.adminUrl,
        max: 1,
      });
      try {
        await admin.query(`create database "${name}" owner pertexo_owner`);
        created = true;
        await admin.query(`revoke all on database "${name}" from public`);
        await admin.query(
          `grant connect on database "${name}" to pertexo_migration,pertexo_app`,
        );
      } finally {
        await admin.end();
      }
      await migrateDatabase({
        connectionString: connection('migrationUrl'),
        ownerRole: 'pertexo_owner',
        appRole: 'pertexo_app',
        maintenanceRole: 'pertexo_maintenance',
      });
    },
    async drop() {
      if (!created || attestation === undefined) return;
      await recheckCuratedFixtureOwnership(attestation);
      const admin = new Pool({
        connectionString: attestation.adminUrl,
        max: 1,
      });
      try {
        const read = async () =>
          (
            await admin.query<{ owner: string; sessions: number }>(
              `select pg_get_userbyid(datdba) owner,
                (select count(*)::int from pg_stat_activity where datname=$1) sessions
               from pg_database where datname=$1`,
              [name],
            )
          ).rows[0];
        // A closed pool's backends leave pg_stat_activity a moment after the
        // client disconnects; only a session still there after that is a leak.
        let state = await read();
        for (let wait = 0; wait < 50 && state?.sessions !== 0; wait += 1) {
          await delay(100);
          state = await read();
        }
        if (state?.owner !== 'pertexo_owner' || state.sessions !== 0)
          throw new Error('F07 fixture cleanup ownership/session check failed');
        // No force: any leaked connection blocks destruction instead of being killed.
        await admin.query(`drop database "${name}"`);
        created = false;
      } finally {
        await admin.end();
      }
    },
  };
}
