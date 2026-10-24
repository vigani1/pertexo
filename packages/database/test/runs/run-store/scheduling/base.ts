import { requestText } from '../../../support/postgres/query-text.js';
import { expect } from 'vitest';
import { z } from 'zod';
import type { Pool as PgPool, PoolClient } from 'pg';
import {
  FailureNotificationContextSchema,
  Pool,
  asOwner,
  asRuntime,
  checkpoint,
  createFailureNotificationStore,
  databaseUrl,
  insertRun,
  notificationConnectionId,
  notificationDestinationId,
  notificationSecretVersionId,
  parseDatabaseConfig,
  randomUUID,
  rawStore,
  testDelivery,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../fixtures.js';
import { createDatabaseRuntime } from '../../../../src/platform/pool/runtime.js';

const predecessorPrimaryFailureSchema = z
  .object({
    nodeId: z.string().min(1).max(128),
    invocationKey: z.string().min(1).max(256),
    nodeStatus: z.enum(['failed', 'timed_out', 'outcome_unknown']),
    attemptNumber: z.number().int().nonnegative(),
    safeErrorCode: z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u),
  })
  .strict();

export const predecessorFailureNotificationContextV1Schema =
  FailureNotificationContextSchema.extend({
    primaryFailure: predecessorPrimaryFailureSchema,
  });

export async function commitPinnedFailureNotificationRun(
  pin = {
    destinationId: notificationDestinationId,
    secretVersionId: notificationSecretVersionId,
  },
): Promise<{
  invocationKey: string;
  runId: string;
}> {
  const invocationKey = `failure/primary/${randomUUID()}`;
  const runId = await insertRun({
    status: 'running',
    schedulerState: checkpoint({
      runStatus: 'running',
      invocations: [
        {
          invocationKey,
          nodeId: 'primary',
          status: 'running',
          attemptNumber: 1,
        },
      ],
    }),
    failureNotificationPolicy: {
      destinationId: pin.destinationId,
      destinationConfigVersion: 1,
      sideEffectClass: 'idempotent_with_key',
      connectionSecretVersionId: pin.secretVersionId,
    },
  });
  const nodeRunId = randomUUID();
  const attemptId = randomUUID();
  await asRuntime(workerBaseUrl, workspaceA, async (client) => {
    await client.query(
      `insert into app.node_runs (
           id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
           status,side_effect_class,current_attempt_id,current_attempt_number
         ) values ($1,$2,$3,'primary',$4,'{}','running','safe',$5,1)`,
      [nodeRunId, workspaceA, runId, invocationKey, attemptId],
    );
    await client.query(
      `insert into app.node_attempts (
           id,workspace_id,node_run_id,attempt_number,status,side_effect_class,
           safe_error_code,executor_failure_kind,executor_error_kind,
           executor_possibly_dispatched,retry_decision
         ) values ($1,$2,$3,1,'failed','safe','provider.unavailable',
           'failed','provider',false,'pending')`,
      [attemptId, workspaceA, nodeRunId],
    );
  });
  const plan = {
    expectedRevision: 0,
    expectedNextEventSequence: 2,
    consumedThroughEventSequence: 1,
    checkpoint: checkpoint({
      revision: 1,
      runStatus: 'failed',
      nextEventSequence: 4,
      invocations: [
        {
          invocationKey,
          nodeId: 'primary',
          status: 'failed',
          attemptNumber: 1,
        },
      ],
    }),
    events: [
      {
        sequence: 2,
        name: 'node.failed' as const,
        occurredAt: '2026-08-24T10:01:00.000Z',
        invocationKey,
        nodeId: 'primary',
        attemptNumber: 1,
        reasonCode: 'provider.unavailable',
      },
      {
        sequence: 3,
        name: 'run.failed' as const,
        occurredAt: '2026-08-24T10:01:00.000Z',
      },
    ],
    nodeRunAdmissions: [],
    attempts: [],
  };
  const delivery = await testDelivery(workspaceA, runId, 0);
  const input = {
    workspaceId: workspaceA,
    runId,
    workflowVersionId: versionA,
    signal: new AbortController().signal,
    delivery,
    plan,
  };
  await expect(rawStore.commitAdvancePlan(input)).resolves.toMatchObject({
    kind: 'committed',
  });
  await expect(rawStore.commitAdvancePlan(input)).resolves.toMatchObject({
    kind: 'already_committed',
  });
  return { invocationKey, runId };
}

export async function failureNotificationIdentity(runId: string): Promise<{
  intent_id: string;
  outbox_id: string;
  payload_checksum: string;
}> {
  const identity = await asRuntime(workerBaseUrl, workspaceA, (client) =>
    client.query<{
      intent_id: string;
      outbox_id: string;
      payload_checksum: string;
    }>(
      `select intent.id intent_id,outbox.id outbox_id,outbox.payload_checksum
         from app.run_failure_notification_intents intent
         join app.outbox_events outbox on outbox.aggregate_id=intent.id
         where intent.workflow_run_id=$1 order by outbox.created_at limit 1`,
      [runId],
    ),
  );
  const first = identity.rows[0];
  if (first === undefined) throw new Error('notification fixture missing');
  return first;
}

/** The worker may only insert inbox events, so read them as the owner. */
export async function inboxEvents(runId: string) {
  return asOwner(
    workspaceA,
    async (client) =>
      (
        await client.query<{
          kind: string;
          terminal_event_sequence: string;
          occurred_at: string;
        }>(
          `select kind,terminal_event_sequence::text,
                to_char(occurred_at at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') occurred_at
           from app.workspace_inbox_events
          where workspace_id=$1 and run_id=$2`,
          [workspaceA, runId],
        )
      ).rows,
  );
}

type FailureNotificationQueryFailure = Readonly<{
  matches(sql: string, parameters: readonly unknown[]): boolean;
  message: string;
}>;

export function createTestFailureNotificationStore(
  failure?: FailureNotificationQueryFailure,
): {
  applicationName: string;
  store: ReturnType<typeof createFailureNotificationStore>;
} {
  const applicationName = `notification-delivery-${randomUUID()}`;
  const deliveryConnectionUrl = new URL(databaseUrl(workerBaseUrl));
  deliveryConnectionUrl.searchParams.set('application_name', applicationName);
  const config = parseDatabaseConfig({
    connectionString: deliveryConnectionUrl.toString(),
    max: 4,
    ownerRole: 'pertexo_owner',
  });
  if (failure === undefined) {
    // This fixture qualifies repository checkout, not independent telemetry
    // connections whose eager startup can race pg_stat_activity baselines.
    const runtime = createDatabaseRuntime(config, {
      role: 'worker',
      monitorLockWaits: false,
    });
    const repository = createFailureNotificationStore(config, runtime);
    return {
      applicationName,
      store: Object.freeze({
        ...repository,
        close: async (): Promise<void> => {
          const settled = await Promise.allSettled([
            repository.close(),
            runtime.close(),
          ]);
          const failures = settled.flatMap((result) =>
            result.status === 'rejected' ? [result.reason as unknown] : [],
          );
          if (failures.length > 0)
            throw new AggregateError(
              failures,
              'Notification fixture cleanup failed',
            );
        },
      }),
    };
  }

  const wrappedClients = new WeakSet<PoolClient>();
  let armed = true;
  const originalConnect = Reflect.get(Pool.prototype, 'connect') as (
    this: PgPool,
    ...arguments_: unknown[]
  ) => unknown;
  Pool.prototype.connect = function (
    this: PgPool,
    ...arguments_: unknown[]
  ): unknown {
    const options = (
      this as unknown as { options: { connectionString?: string } }
    ).options;
    const ownName =
      options.connectionString === undefined
        ? undefined
        : new URL(options.connectionString).searchParams.get(
            'application_name',
          );
    const connected = Reflect.apply(originalConnect, this, arguments_);
    if (ownName !== applicationName || arguments_.length > 0) return connected;
    return (connected as Promise<PoolClient>).then((client) => {
      if (wrappedClients.has(client)) return client;
      wrappedClients.add(client);
      const originalQuery = client.query.bind(client) as unknown as (
        ...queryArguments: unknown[]
      ) => unknown;
      client.query = ((...queryArguments: unknown[]): unknown => {
        const request = queryArguments[0];
        const text = requestText(request);
        const query = originalQuery(...queryArguments);
        const parameters = Array.isArray(queryArguments[1])
          ? queryArguments[1]
          : [];
        if (armed && failure.matches(text, parameters)) {
          armed = false;
          return Promise.resolve(query).then(() => {
            throw new Error(failure.message);
          });
        }
        return query;
      }) as typeof client.query;
      return client;
    });
  } as typeof Pool.prototype.connect;

  const { runtime, repository } = (() => {
    try {
      const createdRuntime = createDatabaseRuntime(config, {
        monitorLockWaits: false,
      });
      return {
        runtime: createdRuntime,
        repository: createFailureNotificationStore(config, createdRuntime),
      };
    } finally {
      Pool.prototype.connect = originalConnect as typeof Pool.prototype.connect;
    }
  })();
  const ownedRuntime = runtime;
  const ownedRepository = repository;
  const store = Object.freeze({
    ...ownedRepository,
    close: async (): Promise<void> => {
      const settled = await Promise.allSettled([
        ownedRepository.close(),
        ownedRuntime.close(),
      ]);
      const failures = settled.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      );
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          'Injected notification store cleanup failed',
        );
    },
  });
  return {
    applicationName,
    store,
  };
}

async function restoreNotificationConfiguration(): Promise<void> {
  await asOwner(workspaceA, async (client) => {
    await client.query(
      `update app.failure_notification_destinations
       set status='enabled',current_config_version=1
       where workspace_id=$1 and id=$2`,
      [workspaceA, notificationDestinationId],
    );
    await client.query(
      `update app.connections
       set status='active',provider_key='email',auth_type='resend_api_key',
           current_secret_version_id=$3,health_revision=health_revision+1,
           last_tested_at=null,last_healthy_at=null,last_error_code=null,last_run_observed_at=null,
           last_health_transition_at=clock_timestamp(),last_health_transition_source='rotation'
       where workspace_id=$1 and id=$2`,
      [workspaceA, notificationConnectionId, notificationSecretVersionId],
    );
  });
}

export async function closeFailureNotificationFixture(
  store: ReturnType<typeof createFailureNotificationStore>,
): Promise<void> {
  const cleanup = await Promise.allSettled([
    restoreNotificationConfiguration(),
    store.close(),
  ]);
  const cleanupFailures: Error[] = [];
  for (const result of cleanup)
    if (result.status === 'rejected')
      cleanupFailures.push(
        result.reason instanceof Error
          ? result.reason
          : new Error('Failure-notification cleanup rejected', {
              cause: result.reason,
            }),
      );
  if (cleanupFailures.length > 0)
    throw new AggregateError(
      cleanupFailures,
      'Failure-notification fixture cleanup failed',
    );
}
