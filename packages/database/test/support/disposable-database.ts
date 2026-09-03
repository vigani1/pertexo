import { Pool } from 'pg';

// PostgreSQL may finish an already-running statement before noticing that its
// client socket closed. The cancellation integration intentionally exercises a
// five-second statement, so teardown allows that bounded backend to disappear.
const DISCONNECT_ATTEMPTS = 500;

function quoteIdentifier(value: string): string {
  if (value.length === 0 || value.includes('\0'))
    throw new Error('Disposable database name is invalid');
  return `"${value.replaceAll('"', '""')}"`;
}

export function createDisposableDatabaseFixture(input: {
  readonly adminUrl: string;
  readonly connectRoles: readonly string[];
  readonly databaseName: string;
  readonly ownerRole: string;
}) {
  const databaseUrl = (base: string): string => {
    const value = new URL(base);
    value.pathname = `/${input.databaseName}`;
    return value.toString();
  };

  return {
    create: async (): Promise<void> => {
      const admin = new Pool({ connectionString: input.adminUrl, max: 1 });
      try {
        await admin.query(
          `create database ${quoteIdentifier(input.databaseName)} owner ${quoteIdentifier(input.ownerRole)}`,
        );
        await admin.query(
          `revoke all on database ${quoteIdentifier(input.databaseName)} from public`,
        );
        await admin.query(
          `grant connect on database ${quoteIdentifier(input.databaseName)} to ${input.connectRoles.map(quoteIdentifier).join(', ')}`,
        );
      } finally {
        await admin.end();
      }
    },
    databaseUrl,
    drop: async (): Promise<void> => {
      const admin = new Pool({ connectionString: input.adminUrl, max: 1 });
      try {
        await dropDisconnectedDatabase(admin, input.databaseName);
      } finally {
        await admin.end();
      }
    },
  };
}

/** Drop only after clients have disconnected; force-dropping creates late pg errors. */
export async function dropDisconnectedDatabase(
  admin: Pool,
  databaseName: string,
): Promise<void> {
  for (let attempt = 0; attempt < DISCONNECT_ATTEMPTS; attempt += 1) {
    const result = await admin.query<{ connections: number }>(
      `select count(*)::int connections
         from pg_stat_activity
        where datname=$1 and pid <> pg_backend_pid()`,
      [databaseName],
    );
    if (result.rows[0]?.connections === 0) {
      await admin.query(
        `drop database if exists ${quoteIdentifier(databaseName)}`,
      );
      return;
    }
    await admin.query('select pg_sleep(0.02)');
  }
  throw new Error(
    `Disposable database still has active connections: ${databaseName}`,
  );
}
