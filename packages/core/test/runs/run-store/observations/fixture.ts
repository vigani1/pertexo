import type { Pool as PgPool, PoolClient } from 'pg';

import {
  Pool,
  asRuntime,
  createTestRunStore,
  databaseUrl,
  parseDatabaseConfig,
  randomUUID,
  workerBaseUrl,
  workspaceA,
} from '../fixtures.js';
import { generatePersistedId } from '@pertexo/database/platform';

type ObservedCoordinatorQuery = Readonly<{
  kind: string;
  values: readonly unknown[];
}>;

export async function measureObservationLoad<T>(
  scenario: 'application_oversized' | 'normal' | 'numeric_expansion',
  operation: () => Promise<T>,
): Promise<T> {
  const heapBefore = process.memoryUsage().heapUsed;
  let peakHeap = heapBefore;
  const startedAt = performance.now();
  let outcome = 'fulfilled';
  const sampler = setInterval(() => {
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }, 1);
  sampler.unref();
  try {
    return await operation();
  } catch (error: unknown) {
    outcome = 'rejected';
    throw error;
  } finally {
    clearInterval(sampler);
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    console.info(
      `Q12_OBSERVATION_MATERIALIZATION=${JSON.stringify({
        scenario,
        outcome,
        operationMs: performance.now() - startedAt,
        processPeakHeapDeltaBytes: peakHeap - heapBefore,
        attributableMemory: false,
      })}`,
    );
  }
}

function coordinatorQueryKind(text: string): string {
  const normalized = text
    .replaceAll('"', '')
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
  if (normalized.includes("current_setting('app.workspace_id'")) {
    return normalized.includes("pg_settings where name='statement_timeout'")
      ? 'verify_workspace_context'
      : 'empty_tenant_context';
  }
  if (normalized === 'begin isolation level repeatable read read only')
    return 'begin_repeatable_read_only';
  if (normalized.includes("set_config('app.workspace_id'"))
    return 'install_workspace_context';
  if (normalized.includes('from app.workflow_runs run'))
    return 'run_checkpoint';
  const factKind = factQueryKind(normalized);
  if (factKind !== undefined) return factKind;
  if (
    normalized.includes("attempt.retry_decision='pending'") &&
    normalized.includes('from app.node_attempts attempt')
  )
    return 'pending_failures';
  if (
    normalized.includes('from app.node_runs node') &&
    normalized.includes('left join app.node_attempts attempt')
  )
    return 'checkpoint_physical_state';
  if (normalized.includes('from app.artifacts')) return 'available_artifacts';
  if (normalized.includes('coalesce(retry_due_at, resume_at) as due_at'))
    return 'due_wakeups';
  if (normalized === 'commit' || normalized === 'rollback') return normalized;
  return 'unexpected';
}

function factQueryKind(normalized: string): string | undefined {
  if (
    normalized.includes('count(*)::int') &&
    normalized.includes('from app.run_events')
  )
    return 'fact_capacity';
  if (
    normalized.includes('from app.run_events') &&
    normalized.includes('order by') &&
    normalized.includes('limit')
  )
    return 'fact_page';
  if (
    normalized.includes('from app.node_attempts') &&
    normalized.includes('inner join app.node_runs')
  )
    return 'fact_physical_attempts';
  return undefined;
}

export function hasConstraint(expected: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    let current: unknown = error;
    while (current instanceof Error) {
      if ('constraint' in current && current.constraint === expected)
        return true;
      current = current.cause;
    }
    return false;
  };
}

function queryTextAndValues(arguments_: readonly unknown[]): Readonly<{
  text: string;
  values: readonly unknown[];
}> {
  const request = arguments_[0];
  if (typeof request === 'string')
    return {
      text: request,
      values: Array.isArray(arguments_[1]) ? arguments_[1] : [],
    };
  if (
    typeof request === 'object' &&
    request !== null &&
    'text' in request &&
    typeof request.text === 'string'
  ) {
    const embeddedValues =
      'values' in request && Array.isArray(request.values)
        ? request.values
        : [];
    return {
      text: request.text,
      values: Array.isArray(arguments_[1]) ? arguments_[1] : embeddedValues,
    };
  }
  throw new Error('Coordinator test observed an unsupported PostgreSQL query');
}

export function observedCoordinatorStore(afterQuery?: (kind: string) => void) {
  const originalConnect = Reflect.get(Pool.prototype, 'connect');
  const applicationName = `observed-coordinator-${randomUUID()}`;
  const connectWithPromise = originalConnect as unknown as (
    this: PgPool,
  ) => Promise<PoolClient>;
  const observedQueries: ObservedCoordinatorQuery[] = [];
  let clientsAcquired = 0;
  Pool.prototype.connect = function (
    this: PgPool,
    ...arguments_: unknown[]
  ): unknown {
    const options = (
      this as unknown as {
        options: { application_name?: string; connectionString?: string };
      }
    ).options;
    const ownApplicationName =
      options.application_name ??
      (options.connectionString === undefined
        ? undefined
        : new URL(options.connectionString).searchParams.get(
            'application_name',
          ));
    if (ownApplicationName !== applicationName)
      return Reflect.apply(
        originalConnect as (...values: unknown[]) => unknown,
        this,
        arguments_,
      );
    if (arguments_.length > 0)
      throw new Error('Coordinator test expected promise-based pool checkout');
    return connectWithPromise.call(this).then((client) => {
      clientsAcquired += 1;
      const originalQuery = client.query.bind(client) as unknown as (
        ...queryArguments: unknown[]
      ) => unknown;
      client.query = ((...queryArguments: unknown[]): unknown => {
        const { text, values } = queryTextAndValues(queryArguments);
        const kind = coordinatorQueryKind(text);
        observedQueries.push({ kind, values });
        const result = originalQuery(...queryArguments);
        if (afterQuery === undefined) return result;
        return Promise.resolve(result).then((value) => {
          afterQuery(kind);
          return value;
        });
      }) as typeof client.query;
      return client;
    });
  } as typeof Pool.prototype.connect;
  let observedStore: ReturnType<typeof createTestRunStore>;
  try {
    const connectionUrl = new URL(databaseUrl(workerBaseUrl));
    connectionUrl.searchParams.set('application_name', applicationName);
    observedStore = createTestRunStore(
      parseDatabaseConfig({
        connectionString: connectionUrl.toString(),
        max: 1,
        ownerRole: 'pertexo_owner',
      }),
    );
  } catch (error: unknown) {
    Pool.prototype.connect = originalConnect;
    throw error;
  }
  return {
    close: async (): Promise<void> => {
      try {
        await observedStore.close();
      } finally {
        Pool.prototype.connect = originalConnect;
      }
    },
    get clientsAcquired(): number {
      return clientsAcquired;
    },
    observedQueries,
    store: observedStore,
  };
}

export function observedKinds(
  queries: readonly ObservedCoordinatorQuery[],
): readonly string[] {
  return queries.map(({ kind }) => kind);
}

export async function seedAvailableArtifact(): Promise<string> {
  const artifactId = generatePersistedId();
  await asRuntime(workerBaseUrl, workspaceA, (client) =>
    client.query(
      `insert into app.artifacts (
           id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
           status,expires_at,finalized_at
         ) values ($1,$2,'node-output',$3,'application/json',1,$4,
           'available',now()+interval '1 day',now())`,
      [
        artifactId,
        workspaceA,
        `workspaces/${workspaceA}/artifacts/${artifactId}`,
        'f'.repeat(64),
      ],
    ),
  );
  return artifactId;
}
