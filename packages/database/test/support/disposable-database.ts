import { Pool } from 'pg';

// PostgreSQL may finish an already-running statement before noticing that its
// client socket closed. The cancellation integration intentionally exercises a
// five-second statement, so teardown allows that bounded backend to disappear.
const DISCONNECT_TIMEOUT_MS = 10_000;

/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters -- node-postgres-style result projection */
export interface DisposableDatabaseAdmin {
  end(): Promise<void>;
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: Row[] }>;
}
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */

function quoteIdentifier(value: string): string {
  if (value.length === 0 || value.includes('\0'))
    throw new Error('Disposable database name is invalid');
  return `"${value.replaceAll('"', '""')}"`;
}

function assertDisposableDatabaseName(value: string): void {
  if (
    !/^pertexo_test_[a-z0-9_]+$/u.test(value) ||
    Buffer.byteLength(value, 'utf8') > 63
  )
    throw new Error('Disposable database name is outside the test namespace');
}

function throwCleanupFailures(failures: unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

export function createDisposableDatabaseFixture(
  input: {
    readonly adminUrl: string;
    readonly connectRoles: readonly string[];
    readonly databaseName: string;
    readonly ownerRole: string;
  },
  dependencies: Readonly<{
    createAdmin?: () => DisposableDatabaseAdmin;
  }> = {},
) {
  assertDisposableDatabaseName(input.databaseName);
  const createAdmin =
    dependencies.createAdmin ??
    (() => new Pool({ connectionString: input.adminUrl, max: 1 }));
  const databaseUrl = (base: string): string => {
    const value = new URL(base);
    value.pathname = `/${input.databaseName}`;
    return value.toString();
  };

  return {
    create: async (): Promise<void> => {
      const admin = createAdmin();
      let databaseCreated = false;
      const failures: unknown[] = [];
      try {
        await admin.query(
          `create database ${quoteIdentifier(input.databaseName)} owner ${quoteIdentifier(input.ownerRole)}`,
        );
        databaseCreated = true;
        await admin.query(
          `revoke all on database ${quoteIdentifier(input.databaseName)} from public`,
        );
        await admin.query(
          `grant connect on database ${quoteIdentifier(input.databaseName)} to ${input.connectRoles.map(quoteIdentifier).join(', ')}`,
        );
      } catch (error: unknown) {
        failures.push(error);
        if (databaseCreated) {
          try {
            await dropDisconnectedDatabase(admin, input.databaseName);
          } catch (cleanupError: unknown) {
            failures.push(cleanupError);
          }
        }
      }
      try {
        await admin.end();
      } catch (error: unknown) {
        failures.push(error);
      }
      throwCleanupFailures(
        failures,
        'Disposable database creation or cleanup failed',
      );
    },
    databaseUrl,
    drop: async (): Promise<void> => {
      const admin = createAdmin();
      const failures: unknown[] = [];
      try {
        await dropDisconnectedDatabase(admin, input.databaseName);
      } catch (error: unknown) {
        failures.push(error);
      }
      try {
        await admin.end();
      } catch (error: unknown) {
        failures.push(error);
      }
      throwCleanupFailures(
        failures,
        'Disposable database drop or cleanup failed',
      );
    },
  };
}

/** Drop only after clients have disconnected; force-dropping creates late pg errors. */
export async function dropDisconnectedDatabase(
  admin: DisposableDatabaseAdmin,
  databaseName: string,
): Promise<void> {
  const deadline = Date.now() + DISCONNECT_TIMEOUT_MS;
  let remainingConnections = 0;
  do {
    const result = await admin.query<{ connections: number }>(
      `select count(*)::int connections
         from pg_stat_activity
        where datname=$1 and pid <> pg_backend_pid()`,
      [databaseName],
    );
    remainingConnections = result.rows[0]?.connections ?? 0;
    if (remainingConnections === 0) {
      await admin.query(
        `drop database if exists ${quoteIdentifier(databaseName)}`,
      );
      return;
    }
    if (Date.now() >= deadline) break;
    await admin.query('select pg_sleep(0.02)');
  } while (Date.now() < deadline);
  throw new Error(
    `Disposable database still has ${String(remainingConnections)} active connection(s) after ${String(DISCONNECT_TIMEOUT_MS)}ms: ${databaseName}`,
  );
}
