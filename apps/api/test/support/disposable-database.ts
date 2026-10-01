import type { QueryResultRow } from 'pg';

const DISCONNECT_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 1_000;

type BoundedQuery = Readonly<{
  text: string;
  values?: unknown[];
  query_timeout: number;
}>;

export interface DisposableDatabaseQueryClient {
  query(config: BoundedQuery): Promise<Readonly<{ rows: QueryResultRow[] }>>;
}

export type DropDisconnectedDatabaseOptions = Readonly<{
  timeoutMs?: number;
  queryTimeoutMs?: number;
  now?: () => number;
  beforeDrop?: () => Promise<void>;
}>;

function quoteIdentifier(value: string): string {
  if (value.length === 0 || value.includes('\0'))
    throw new Error('Disposable database name is invalid');
  return `"${value.replaceAll('"', '""')}"`;
}

export async function dropDisconnectedDatabase(
  admin: DisposableDatabaseQueryClient,
  databaseName: string,
  options: DropDisconnectedDatabaseOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const timeoutMs = positiveMillis(
    options.timeoutMs ?? DISCONNECT_TIMEOUT_MS,
    'disconnect timeout',
  );
  const queryTimeoutMs = Math.min(
    QUERY_TIMEOUT_MS,
    positiveMillis(options.queryTimeoutMs ?? QUERY_TIMEOUT_MS, 'query timeout'),
  );
  const deadline = now() + timeoutMs;
  let remainingConnections: number | undefined;
  while (now() < deadline) {
    const result = await boundedQuery(
      admin,
      {
        text: `select count(*)::int connections from pg_stat_activity
          where datname=$1 and pid<>pg_backend_pid()`,
        values: [databaseName],
      },
      remainingBudget('connection_probe', queryTimeoutMs),
      'connection_probe',
    );
    const row = result.rows[0];
    const observed =
      typeof row === 'object' && row !== null && 'connections' in row
        ? row.connections
        : undefined;
    if (
      typeof observed !== 'number' ||
      !Number.isInteger(observed) ||
      observed < 0
    )
      throw new Error('Disposable database connection count is unavailable');
    remainingConnections = observed;
    if (remainingConnections === 0) {
      await options.beforeDrop?.();
      // DROP waits for a forced checkpoint; reuse the total cleanup budget,
      // not the shorter cap intended for connection polling.
      await boundedQuery(
        admin,
        {
          text: `drop database if exists ${quoteIdentifier(databaseName)}`,
        },
        remainingBudget('drop', timeoutMs),
        'drop',
      );
      return;
    }
    if (now() >= deadline) break;
    await boundedQuery(
      admin,
      { text: 'select pg_sleep(0.02)' },
      remainingBudget('poll_wait', queryTimeoutMs),
      'poll_wait',
    );
  }
  throw new Error(
    `Disposable database still has ${String(remainingConnections ?? 'unknown')} active connection(s) after ${String(timeoutMs)}ms: ${databaseName}`,
  );

  function remainingBudget(stage: CleanupStage, cap: number): number {
    const remaining = deadline - now();
    if (remaining <= 0)
      throw new Error(
        `Disposable database ${stage} deadline expired before dispatch`,
      );
    return Math.min(cap, remaining);
  }
}

type CleanupStage = 'connection_probe' | 'poll_wait' | 'drop';

async function boundedQuery(
  client: DisposableDatabaseQueryClient,
  query: Readonly<{ text: string; values?: unknown[] }>,
  timeoutMs: number,
  stage: CleanupStage,
): Promise<Readonly<{ rows: unknown[] }>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queryPromise = client.query({
    ...query,
    query_timeout: timeoutMs,
  });
  void queryPromise.catch(() => undefined);
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Disposable database ${stage} query exceeded ${String(timeoutMs)}ms`,
        ),
      );
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([queryPromise, timeoutPromise]);
    return { rows: result.rows };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function positiveMillis(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`Disposable database ${name} must be a positive integer`);
  return value;
}
