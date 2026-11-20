import { randomUUID } from 'node:crypto';
import type { PostgresCredential } from '@pertexo/contracts';
import pg from 'pg';
import { createDisposableDatabaseFixture } from './disposable-database.js';

export async function createPostgresDestination(adminUrl: string) {
  const suffix = randomUUID().replaceAll('-', '');
  const user = `pertexo_destination_${suffix}`;
  const database = `pertexo_test_destination_${suffix}`;
  const password = randomUUID();
  const admin = new URL(adminUrl);
  const credential: PostgresCredential = {
    type: 'postgres',
    host: admin.hostname,
    port: Number(admin.port),
    database,
    user,
    password,
    tls: 'disable',
  };
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    databaseName: database,
    ownerRole: user,
    connectRoles: [user],
  });
  const runAdmin = async (query: string) => {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(query);
    } finally {
      await client.end();
    }
  };
  const dropRole = () => runAdmin(`drop role ${pg.escapeIdentifier(user)}`);
  await runAdmin(
    `create role ${pg.escapeIdentifier(user)} login password ${pg.escapeLiteral(password)}`,
  );
  try {
    await fixture.create();
    return {
      credential,
      async close() {
        await fixture.drop();
        await dropRole();
      },
    };
  } catch (error) {
    await dropRole();
    throw error;
  }
}
