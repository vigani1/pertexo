import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { Pool as PgPool, PoolClient, QueryResult } from 'pg';

import {
  FailureNotificationContextV1Schema,
  Pool,
  actorId,
  apiBaseUrl,
  asOwner,
  asRuntime,
  checkpoint,
  createCoordinatorRunStore,
  createFailureNotificationStore,
  databaseUrl,
  insertRun,
  notificationConnectionId,
  notificationDestinationId,
  notificationSecretVersionId,
  parseDatabaseConfig,
  randomUUID,
  rawStore,
  ownedDeliveryStore,
  testDelivery,
  versionA,
  versionB,
  waitForApplicationLocks,
  workerBaseUrl,
  workflowB,
  workspaceA,
  workspaceB,
} from './coordinator-run-store.fixtures.js';
import { createDatabaseRuntime } from '../src/platform/database-runtime.js';

const predecessorPrimaryFailureSchema = z
  .object({
    nodeId: z.string().min(1).max(128),
    invocationKey: z.string().min(1).max(256),
    nodeStatus: z.enum(['failed', 'timed_out', 'outcome_unknown']),
    attemptNumber: z.number().int().nonnegative(),
    safeErrorCode: z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u),
  })
  .strict();
const predecessorFailureNotificationContextV1Schema =
  FailureNotificationContextV1Schema.extend({
    primaryFailure: predecessorPrimaryFailureSchema,
  });

async function commitPinnedFailureNotificationRun(): Promise<{
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
      destinationId: notificationDestinationId,
      destinationConfigVersion: 1,
      sideEffectClass: 'idempotent_with_key',
      connectionSecretVersionId: notificationSecretVersionId,
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
        schemaVersion: 1 as const,
        sequence: 2,
        name: 'node.failed' as const,
        occurredAt: '2026-08-24T10:01:00.000Z',
        invocationKey,
        nodeId: 'primary',
        attemptNumber: 1,
        reasonCode: 'provider.unavailable',
      },
      {
        schemaVersion: 1 as const,
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

async function failureNotificationIdentity(runId: string): Promise<{
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

type FailureNotificationQueryFailure = Readonly<{
  matches(sql: string): boolean;
  message: string;
}>;

function createTestFailureNotificationStore(
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
    workerRuntimeRole: 'pertexo_worker',
  });
  if (failure === undefined)
    return {
      applicationName,
      store: createFailureNotificationStore(config),
    };

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
        const text =
          typeof request === 'string'
            ? request
            : typeof request === 'object' &&
                request !== null &&
                'text' in request &&
                typeof request.text === 'string'
              ? request.text
              : '';
        const query = originalQuery(...queryArguments);
        if (armed && failure.matches(text)) {
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
           current_secret_version_id=$3
       where workspace_id=$1 and id=$2`,
      [workspaceA, notificationConnectionId, notificationSecretVersionId],
    );
  });
}

async function closeFailureNotificationFixture(
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

describe('Coordinator scheduling and notification invariants', () => {
  it('defers queued coordination durably until an active entitlement slot is free', async () => {
    await asOwner(workspaceB, async (client) => {
      await client.query(
        `insert into app.workspace_execution_entitlement_versions (
             workspace_id,version,status,active_run_limit,queued_run_limit,effective_at
           ) values ($1,3,'active',5,100,'-infinity'::timestamptz)`,
        [workspaceB],
      );
      await client.query(
        `update app.workspace_execution_entitlements set current_version=3
            where workspace_id=$1`,
        [workspaceB],
      );
    });
    const runScope = {
      workspaceId: workspaceB,
      workflowId: workflowB,
      workflowVersionId: versionB,
    } as const;
    const activeRunIds = await Promise.all(
      Array.from({ length: 5 }, () =>
        insertRun({ ...runScope, status: 'running' }),
      ),
    );
    const runId = await insertRun(runScope);
    await asOwner(workspaceB, (client) =>
      client.query(
        `update app.workspace_execution_entitlements set current_version=2
            where workspace_id=$1`,
        [workspaceB],
      ),
    );
    const plan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: checkpoint({
        workflowVersionId: versionB,
        revision: 1,
        runStatus: 'running',
        nextEventSequence: 3,
      }),
      events: [
        {
          schemaVersion: 1 as const,
          sequence: 2,
          name: 'run.started' as const,
          occurredAt: '2026-08-25T00:00:00.000Z',
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    };
    const delivery = await testDelivery(workspaceB, runId, 0);
    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceB,
        runId,
        workflowVersionId: versionB,
        delivery,
        plan,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'deferred', revision: 0 });

    const deferred = await asRuntime(workerBaseUrl, workspaceB, (client) =>
      client.query<{ id: string; payload_checksum: string }>(
        `select id,payload_checksum from app.outbox_events
            where workspace_id=$1 and aggregate_id=$2 and job_name='advance-workflow-run'
              and id<>$3
            order by created_at desc limit 1`,
        [workspaceB, runId, delivery.outboxEventId],
      ),
    );
    expect(deferred.rows).toHaveLength(1);
    const retry = deferred.rows[0];
    if (retry === undefined)
      throw new Error('Deferred coordinator row missing');
    await asRuntime(workerBaseUrl, workspaceB, (client) =>
      client.query(
        `update app.workflow_runs set status='succeeded',completed_at=clock_timestamp()
            where workspace_id=$1 and id=$2`,
        [workspaceB, activeRunIds[0]],
      ),
    );
    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceB,
        runId,
        workflowVersionId: versionB,
        delivery: {
          outboxEventId: retry.id,
          payloadChecksum: retry.payload_checksum,
        },
        plan,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
    const proof = await asRuntime(workerBaseUrl, workspaceB, (client) =>
      client.query<{
        active_runs: number;
        actual_queued: number;
        queued_runs: number;
        run_status: string;
      }>(
        `select counter.active_runs,counter.queued_runs,run.status run_status,
                  (select count(*)::integer from app.workflow_runs queued
                    where queued.workspace_id=counter.workspace_id
                      and queued.status='queued') actual_queued
             from app.workspace_execution_admission_counters counter
             join app.workflow_runs run on run.workspace_id=counter.workspace_id
            where counter.workspace_id=$1 and run.id=$2`,
        [workspaceB, runId],
      ),
    );
    expect(proof.rows).toEqual([
      {
        active_runs: 5,
        actual_queued: 0,
        queued_runs: 0,
        run_status: 'running',
      },
    ]);
  });

  it('reports database-observed schedule-to-start only for the CAS winner', async () => {
    const due = await asOwner(workspaceA, (client) =>
      client.query<{ scheduled_at: Date }>(
        "select clock_timestamp()-interval '4.25 seconds' scheduled_at",
      ),
    );
    const scheduledAt = due.rows[0]?.scheduled_at.toISOString();
    if (scheduledAt === undefined)
      throw new Error('Database schedule timestamp missing');
    const startedAt = new Date(Date.parse(scheduledAt) + 4_250).toISOString();
    const runId = await insertRun({
      triggerType: 'schedule',
      inputRef: {
        schemaVersion: 1,
        kind: 'inline',
        value: {
          schemaVersion: 1,
          triggerId: randomUUID(),
          nodeId: 'schedule-start-proof',
          scheduledAt,
        },
      },
    });
    const plan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: checkpoint({
        revision: 1,
        runStatus: 'running',
        nextEventSequence: 3,
      }),
      events: [
        {
          schemaVersion: 1 as const,
          sequence: 2,
          name: 'run.started' as const,
          occurredAt: startedAt,
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    };
    const delivery = await testDelivery(workspaceA, runId, 0);
    const before = await asOwner(workspaceA, (client) =>
      client.query<{ observed_at: Date }>(
        'select clock_timestamp() observed_at',
      ),
    );
    const committed = await rawStore.commitAdvancePlan({
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      delivery,
      plan,
      signal: new AbortController().signal,
    });
    const after = await asOwner(workspaceA, (client) =>
      client.query<{ observed_at: Date }>(
        'select clock_timestamp() observed_at',
      ),
    );
    expect(committed).toMatchObject({ kind: 'committed', revision: 1 });
    if (committed.kind !== 'committed')
      throw new Error('Schedule start was not committed');
    const beforeSeconds =
      ((before.rows[0]?.observed_at.getTime() ?? Number.NaN) -
        Date.parse(scheduledAt)) /
      1_000;
    const afterSeconds =
      ((after.rows[0]?.observed_at.getTime() ?? Number.NaN) -
        Date.parse(scheduledAt)) /
      1_000;
    expect(committed.scheduleToStartSeconds).toBeGreaterThanOrEqual(
      beforeSeconds,
    );
    expect(committed.scheduleToStartSeconds).toBeLessThanOrEqual(afterSeconds);
    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        delivery,
        plan,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'already_committed', revision: 1 });
  });

  it('returns a committed schedule when post-commit observation is aborted', async () => {
    const applicationName = `held-schedule-observation-${randomUUID()}`;
    const connectionUrl = new URL(databaseUrl(workerBaseUrl));
    connectionUrl.searchParams.set('application_name', applicationName);
    const config = parseDatabaseConfig({
      connectionString: connectionUrl.toString(),
      max: 1,
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    });
    let resolveMetric!: (result: QueryResult<{ observed_at: Date }>) => void;
    const metric = new Promise<QueryResult<{ observed_at: Date }>>(
      (resolve) => {
        resolveMetric = resolve;
      },
    );
    let markMetricStarted!: () => void;
    const metricStarted = new Promise<void>((resolve) => {
      markMetricStarted = resolve;
    });
    const wrappedClients = new WeakSet<PoolClient>();
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
      if (ownName !== applicationName || arguments_.length > 0)
        return connected;
      return (connected as Promise<PoolClient>).then((client) => {
        if (wrappedClients.has(client)) return client;
        wrappedClients.add(client);
        const originalQuery = client.query.bind(client) as unknown as (
          ...queryArguments: unknown[]
        ) => unknown;
        client.query = ((...queryArguments: unknown[]): unknown => {
          const request = queryArguments[0];
          const text =
            typeof request === 'string'
              ? request
              : typeof request === 'object' &&
                  request !== null &&
                  'text' in request &&
                  typeof request.text === 'string'
                ? request.text
                : '';
          if (text.trim() === 'select clock_timestamp() observed_at') {
            markMetricStarted();
            return metric;
          }
          return originalQuery(...queryArguments);
        }) as typeof client.query;
        return client;
      });
    } as typeof Pool.prototype.connect;

    let runtime: ReturnType<typeof createDatabaseRuntime> | undefined;
    let scheduleStore: ReturnType<typeof createCoordinatorRunStore> | undefined;
    try {
      runtime = createDatabaseRuntime(config, { monitorLockWaits: false });
      scheduleStore = createCoordinatorRunStore(config, runtime);
    } finally {
      Pool.prototype.connect = originalConnect as typeof Pool.prototype.connect;
    }

    const scheduledAt = '2026-09-13T00:00:00.000Z';
    const runId = await insertRun({
      triggerType: 'schedule',
      inputRef: {
        schemaVersion: 1,
        kind: 'inline',
        value: {
          schemaVersion: 1,
          triggerId: randomUUID(),
          nodeId: 'held-observation',
          scheduledAt,
        },
      },
    });
    const delivery = await testDelivery(workspaceA, runId, 0);
    const plan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: checkpoint({
        revision: 1,
        runStatus: 'running',
        nextEventSequence: 3,
      }),
      events: [
        {
          schemaVersion: 1 as const,
          sequence: 2,
          name: 'run.started' as const,
          occurredAt: scheduledAt,
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    };
    const controller = new AbortController();
    let commitSettled = false;
    const committing = scheduleStore
      .commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        delivery,
        plan,
        signal: controller.signal,
      })
      .finally(() => {
        commitSettled = true;
      });
    try {
      await metricStarted;
      expect(commitSettled).toBe(false);
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query(
            `select checkpoint.revision,receipt.completed_at is not null completed
             from app.run_checkpoints checkpoint
             join app.inbox_receipts receipt on receipt.message_id=$3
             where checkpoint.workspace_id=$1 and checkpoint.workflow_run_id=$2`,
            [workspaceA, runId, delivery.outboxEventId],
          ),
        ),
      ).resolves.toMatchObject({
        rows: [{ revision: 1, completed: true }],
      });
      controller.abort();
      await expect(committing).resolves.toEqual({
        kind: 'committed',
        revision: 1,
        admittedAttempts: [],
      });
      resolveMetric({
        command: 'SELECT',
        fields: [],
        oid: 0,
        rowCount: 1,
        rows: [{ observed_at: new Date('2026-09-13T00:00:01.000Z') }],
      });
      await metric;
      await expect(
        rawStore.commitAdvancePlan({
          workspaceId: workspaceA,
          runId,
          workflowVersionId: versionA,
          delivery,
          plan,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ kind: 'already_committed', revision: 1 });
    } finally {
      controller.abort();
      resolveMetric({
        command: 'SELECT',
        fields: [],
        oid: 0,
        rowCount: 0,
        rows: [],
      });
      const closed = await Promise.allSettled([
        scheduleStore.close(),
        runtime.close(),
        committing,
      ]);
      const failures: Error[] = [];
      for (const result of closed)
        if (result.status === 'rejected')
          failures.push(
            result.reason instanceof Error
              ? result.reason
              : new Error('Held schedule cleanup rejected', {
                  cause: result.reason,
                }),
          );
      if (failures.length > 0) {
        // eslint-disable-next-line no-unsafe-finally -- Every cleanup owner has settled and its failure must remain visible.
        throw new AggregateError(
          failures,
          'Held schedule fixture cleanup failed',
        );
      }
    }
  });

  it('preserves one queued-timeout intent through predecessor rejection and R1 rollback recovery', async () => {
    const runId = await insertRun({
      failureNotificationPolicy: {
        destinationId: notificationDestinationId,
        destinationConfigVersion: 1,
        sideEffectClass: 'idempotent_with_key',
        connectionSecretVersionId: notificationSecretVersionId,
      },
    });
    const plan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: checkpoint({
        revision: 1,
        runStatus: 'timed_out',
        nextEventSequence: 3,
        invocations: [],
      }),
      events: [
        {
          schemaVersion: 1 as const,
          sequence: 2,
          name: 'run.timed_out' as const,
          occurredAt: '2026-08-24T10:01:00.000Z',
          reasonCode: 'execution.deadline_exceeded',
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    };
    const input = {
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      signal: new AbortController().signal,
      plan,
    };

    await expect(
      ownedDeliveryStore.commitAdvancePlan(input),
    ).resolves.toMatchObject({
      kind: 'committed',
    });
    await expect(
      ownedDeliveryStore.commitAdvancePlan(input),
    ).resolves.toMatchObject({
      kind: 'already_committed',
    });

    const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        context: Record<string, unknown>;
        intent_count: number;
        outbox_count: number;
        run_status: string;
        terminal_event_count: number;
      }>(
        `select run.status run_status,
                count(distinct event.sequence) filter (
                  where event.type='run.timed_out'
                )::int terminal_event_count,
                count(distinct intent.id)::int intent_count,
                count(distinct outbox.id)::int outbox_count,
                min(intent.context::text)::jsonb context
           from app.workflow_runs run
           left join app.run_events event
             on event.workspace_id=run.workspace_id
            and event.workflow_run_id=run.id
           left join app.run_failure_notification_intents intent
             on intent.workspace_id=run.workspace_id
            and intent.workflow_run_id=run.id
           left join app.outbox_events outbox on outbox.aggregate_id=intent.id
          where run.workspace_id=$1 and run.id=$2
          group by run.status`,
        [workspaceA, runId],
      ),
    );
    expect(proof.rows[0]).toMatchObject({
      run_status: 'timed_out',
      terminal_event_count: 1,
      intent_count: 1,
      outbox_count: 1,
    });
    expect(
      FailureNotificationContextV1Schema.parse(proof.rows[0]?.context),
    ).toMatchObject({
      terminalStatus: 'timed_out',
      primaryFailure: {
        source: 'run',
        runStatus: 'timed_out',
        safeErrorCode: 'execution.deadline_exceeded',
      },
      totalFailureCount: 1,
    });

    const identity = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        context: Record<string, unknown>;
        context_checksum: string;
        intent_id: string;
        outbox_id: string;
        payload_checksum: string;
      }>(
        `select intent.id intent_id,intent.context,intent.context_checksum,
                outbox.id outbox_id,outbox.payload_checksum
           from app.run_failure_notification_intents intent
           join app.outbox_events outbox on outbox.aggregate_id=intent.id
          where intent.workspace_id=$1 and intent.workflow_run_id=$2
          order by outbox.created_at,outbox.id limit 1`,
        [workspaceA, runId],
      ),
    );
    const first = identity.rows[0];
    if (first === undefined) throw new Error('notification fixture missing');

    await expect(
      asRuntime(workerBaseUrl, workspaceA, async (client) => {
        const selected = await client.query<{ context: unknown }>(
          `select context from app.run_failure_notification_intents
            where workspace_id=$1 and id=$2 for update`,
          [workspaceA, first.intent_id],
        );
        predecessorFailureNotificationContextV1Schema.parse(
          selected.rows[0]?.context,
        );
      }),
    ).rejects.toThrow();
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `select 1 from app.run_failure_notification_intents
            where workspace_id=$1 and id=$2 and status='pending' and delivery_attempts=0`,
          [workspaceA, first.intent_id],
        ),
      ),
    ).resolves.toMatchObject({ rowCount: 1 });

    const claimInput = {
      workspaceId: workspaceA,
      intentId: first.intent_id,
      delivery: {
        outboxEventId: first.outbox_id,
        payloadChecksum: first.payload_checksum,
      },
      recoverySeconds: 1,
      maxAttempts: 3,
    } as const;
    const candidateStore = createFailureNotificationStore(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 2,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    );
    try {
      await expect(
        candidateStore.claimDelivery(claimInput),
      ).resolves.toMatchObject({
        kind: 'ready',
        attemptNumber: 1,
        context: first.context,
      });
    } finally {
      await candidateStore.close();
    }

    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `update app.run_failure_notification_intents
            set recovery_at=clock_timestamp()-interval '1 second'
          where workspace_id=$1 and id=$2`,
        [workspaceA, first.intent_id],
      ),
    );
    const rollbackReaderStore = createFailureNotificationStore(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 2,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    );
    try {
      await expect(rollbackReaderStore.recoverDue(10, 3)).resolves.toBe(1);
      const recovered = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          context: Record<string, unknown>;
          context_checksum: string;
          delivery_attempts: number;
          intent_count: number;
          outbox_count: number;
          outbox_id: string;
          payload_checksum: string;
        }>(
          `select intent.context,intent.context_checksum,intent.delivery_attempts,
                    (select count(*)::int from app.run_failure_notification_intents other
                      where other.workflow_run_id=intent.workflow_run_id) intent_count,
                    (select count(*)::int from app.outbox_events other
                      where other.aggregate_id=intent.id) outbox_count,
                    outbox.id outbox_id,outbox.payload_checksum
               from app.run_failure_notification_intents intent
               join lateral (
                 select id,payload_checksum from app.outbox_events
                  where aggregate_id=intent.id order by created_at desc,id desc limit 1
               ) outbox on true
              where intent.workspace_id=$1 and intent.id=$2`,
          [workspaceA, first.intent_id],
        ),
      );
      const retry = recovered.rows[0];
      expect(retry).toMatchObject({
        context: first.context,
        context_checksum: first.context_checksum,
        delivery_attempts: 1,
        intent_count: 1,
        outbox_count: 2,
      });
      if (retry === undefined) throw new Error('recovery fixture missing');
      const reclaimed = await rollbackReaderStore.claimDelivery({
        ...claimInput,
        delivery: {
          outboxEventId: retry.outbox_id,
          payloadChecksum: retry.payload_checksum,
        },
      });
      expect(reclaimed).toMatchObject({
        kind: 'ready',
        attemptNumber: 2,
        context: first.context,
      });
      if (reclaimed.kind !== 'ready')
        throw new Error('Recovered notification was not claimable');
      await expect(
        rollbackReaderStore.completeDelivery({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: reclaimed.attemptNumber,
          maxAttempts: 3,
          retryDelaySeconds: 0,
          result: {
            schemaVersion: 1,
            kind: 'definite_failure',
            safeErrorCode: 'provider.rejected',
            possiblyDispatched: false,
          },
        }),
      ).resolves.toBe('completed');
    } finally {
      await rollbackReaderStore.close();
    }
  });

  it('keeps R1 run-timeout context production disabled while committing terminal truth', async () => {
    const runId = await insertRun({
      failureNotificationPolicy: {
        destinationId: notificationDestinationId,
        destinationConfigVersion: 1,
        sideEffectClass: 'idempotent_with_key',
        connectionSecretVersionId: notificationSecretVersionId,
      },
    });
    const r1Store = createCoordinatorRunStore(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 2,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    );
    try {
      await expect(
        r1Store.commitAdvancePlan({
          workspaceId: workspaceA,
          runId,
          workflowVersionId: versionA,
          delivery: await testDelivery(workspaceA, runId, 0),
          signal: new AbortController().signal,
          plan: {
            expectedRevision: 0,
            expectedNextEventSequence: 2,
            consumedThroughEventSequence: 1,
            checkpoint: checkpoint({
              revision: 1,
              runStatus: 'timed_out',
              nextEventSequence: 3,
              invocations: [],
            }),
            events: [
              {
                schemaVersion: 1,
                sequence: 2,
                name: 'run.timed_out',
                occurredAt: '2026-08-24T10:01:00.000Z',
                reasonCode: 'execution.deadline_exceeded',
              },
            ],
            nodeRunAdmissions: [],
            attempts: [],
          },
        }),
      ).resolves.toMatchObject({ kind: 'committed' });
    } finally {
      await r1Store.close();
    }

    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ intent_count: number; run_status: string }>(
          `select run.status run_status,
                  count(intent.id)::int intent_count
             from app.workflow_runs run
             left join app.run_failure_notification_intents intent
               on intent.workspace_id=run.workspace_id
              and intent.workflow_run_id=run.id
            where run.workspace_id=$1 and run.id=$2
            group by run.status`,
          [workspaceA, runId],
        ),
      ),
    ).resolves.toMatchObject({
      rows: [{ run_status: 'timed_out', intent_count: 0 }],
    });
  });

  it('atomically creates one policy-pinned safe failure notification intent', async () => {
    const { invocationKey, runId } = await commitPinnedFailureNotificationRun();
    const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        intent_count: number;
        outbox_count: number;
        context: Record<string, unknown>;
      }>(
        `select count(distinct intent.id)::int intent_count,
                  count(distinct outbox.id)::int outbox_count,
                  min(intent.context::text)::jsonb context
           from app.run_failure_notification_intents intent
           join app.outbox_events outbox on outbox.aggregate_id=intent.id
           where intent.workspace_id=$1 and intent.workflow_run_id=$2`,
        [workspaceA, runId],
      ),
    );
    expect(proof.rows[0]).toMatchObject({ intent_count: 1, outbox_count: 1 });
    const persistedContext = FailureNotificationContextV1Schema.parse(
      proof.rows[0]?.context,
    );
    expect(persistedContext.terminalStatus).toBe('failed');
    expect(persistedContext.primaryFailure).toMatchObject({
      invocationKey,
      safeErrorCode: 'provider.unavailable',
    });
    expect(JSON.stringify(proof.rows[0]?.context)).not.toMatch(
      /errorSummary|secret|input|output|connection|actor/i,
    );
    const hidden = await asRuntime(workerBaseUrl, workspaceB, (client) =>
      client.query(
        `select id from app.run_failure_notification_intents where workflow_run_id=$1`,
        [runId],
      ),
    );
    expect(hidden.rowCount).toBe(0);

    const identity = await failureNotificationIdentity(runId);
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ matches_pin: boolean }>(
          `select intent.destination_config_version = 1
                    and intent.connection_secret_version_id = $2 as matches_pin
             from app.run_failure_notification_intents intent
             where intent.id=$1`,
          [identity.intent_id, notificationSecretVersionId],
        ),
      ),
    ).resolves.toMatchObject({ rows: [{ matches_pin: true }] });
  });

  it('rejects each forged queue identity and corrupt context before claiming', async () => {
    const { runId } = await commitPinnedFailureNotificationRun();
    const first = await failureNotificationIdentity(runId);
    const { store: deliveryStore } = createTestFailureNotificationStore();
    const claimInput = {
      workspaceId: workspaceA,
      intentId: first.intent_id,
      delivery: {
        outboxEventId: first.outbox_id,
        payloadChecksum: first.payload_checksum,
      },
      recoverySeconds: 30,
      maxAttempts: 3,
    } as const;
    const originalOutbox = await asOwner(workspaceA, (client) =>
      client.query<{
        aggregate_id: string;
        aggregate_type: string;
        job_name: string;
        payload: unknown;
        payload_checksum: string;
        schema_version: number;
      }>(
        `select aggregate_id,aggregate_type,job_name,payload,payload_checksum,schema_version
           from app.outbox_events where workspace_id=$1 and id=$2`,
        [workspaceA, first.outbox_id],
      ),
    );
    const authoritative = originalOutbox.rows[0];
    if (authoritative === undefined)
      throw new Error('Notification outbox fixture missing');
    const assertUnclaimed = async (): Promise<void> => {
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{ delivery_attempts: number; status: string }>(
            `select status,delivery_attempts
               from app.run_failure_notification_intents
              where workspace_id=$1 and id=$2`,
            [workspaceA, first.intent_id],
          ),
        ),
      ).resolves.toMatchObject({
        rows: [{ delivery_attempts: 0, status: 'pending' }],
      });
    };
    const restoreOutbox = () =>
      asOwner(workspaceA, (client) =>
        client.query(
          `update app.outbox_events
              set aggregate_id=$3,aggregate_type=$4,job_name=$5,payload=$6::jsonb,
                  payload_checksum=$7,schema_version=$8
            where workspace_id=$1 and id=$2`,
          [
            workspaceA,
            first.outbox_id,
            authoritative.aggregate_id,
            authoritative.aggregate_type,
            authoritative.job_name,
            JSON.stringify(authoritative.payload),
            authoritative.payload_checksum,
            authoritative.schema_version,
          ],
        ),
      );
    const mutations = [
      {
        name: 'aggregate id',
        sql: 'update app.outbox_events set aggregate_id=$3 where workspace_id=$1 and id=$2',
        value: randomUUID(),
        checksum: first.payload_checksum,
      },
      {
        name: 'aggregate type',
        sql: 'update app.outbox_events set aggregate_type=$3 where workspace_id=$1 and id=$2',
        value: 'workflow-run',
        checksum: first.payload_checksum,
      },
      {
        name: 'job name',
        sql: 'update app.outbox_events set job_name=$3 where workspace_id=$1 and id=$2',
        value: 'advance-workflow-run',
        checksum: first.payload_checksum,
      },
      {
        name: 'schema version',
        sql: 'update app.outbox_events set schema_version=$3 where workspace_id=$1 and id=$2',
        value: 2,
        checksum: first.payload_checksum,
      },
      {
        name: 'stored checksum',
        sql: 'update app.outbox_events set payload_checksum=$3 where workspace_id=$1 and id=$2',
        value: 'f'.repeat(64),
        checksum: 'f'.repeat(64),
      },
      {
        name: 'stored payload',
        sql: `update app.outbox_events
                 set payload=jsonb_set(payload,'{tampered}','true'::jsonb)
               where workspace_id=$1 and id=$2`,
        checksum: first.payload_checksum,
      },
    ] as const;
    try {
      for (const mutation of mutations) {
        try {
          await asOwner(workspaceA, (client) =>
            client.query(
              mutation.sql,
              'value' in mutation
                ? [workspaceA, first.outbox_id, mutation.value]
                : [workspaceA, first.outbox_id],
            ),
          );
          await expect(
            deliveryStore.claimDelivery({
              ...claimInput,
              delivery: {
                ...claimInput.delivery,
                payloadChecksum: mutation.checksum,
              },
            }),
            mutation.name,
          ).rejects.toThrow('Delivery identity mismatch');
          await assertUnclaimed();
        } finally {
          await restoreOutbox();
        }
      }

      await expect(
        deliveryStore.claimDelivery({
          ...claimInput,
          delivery: {
            ...claimInput.delivery,
            payloadChecksum: 'e'.repeat(64),
          },
        }),
      ).rejects.toThrow('Delivery identity mismatch');
      await assertUnclaimed();

      const originalContext = await asOwner(workspaceA, (client) =>
        client.query<{ context: unknown; context_checksum: string }>(
          `select context,context_checksum
             from app.run_failure_notification_intents
            where workspace_id=$1 and id=$2`,
          [workspaceA, first.intent_id],
        ),
      );
      const persisted = originalContext.rows[0];
      if (persisted === undefined)
        throw new Error('Notification context fixture missing');
      try {
        await asOwner(workspaceA, (client) =>
          client.query(
            `update app.run_failure_notification_intents
                set context='{}'::jsonb
              where workspace_id=$1 and id=$2`,
            [workspaceA, first.intent_id],
          ),
        );
        await expect(deliveryStore.claimDelivery(claimInput)).rejects.toThrow();
        await assertUnclaimed();
      } finally {
        await asOwner(workspaceA, (client) =>
          client.query(
            `update app.run_failure_notification_intents
                set context=$3::jsonb,context_checksum=$4
              where workspace_id=$1 and id=$2`,
            [
              workspaceA,
              first.intent_id,
              JSON.stringify(persisted.context),
              persisted.context_checksum,
            ],
          ),
        );
      }
      try {
        await asOwner(workspaceA, (client) =>
          client.query(
            `update app.run_failure_notification_intents
                set context_checksum=$3
              where workspace_id=$1 and id=$2`,
            [workspaceA, first.intent_id, 'd'.repeat(64)],
          ),
        );
        await expect(deliveryStore.claimDelivery(claimInput)).rejects.toThrow(
          'Intent checksum mismatch',
        );
        await assertUnclaimed();
      } finally {
        await asOwner(workspaceA, (client) =>
          client.query(
            `update app.run_failure_notification_intents
                set context_checksum=$3
              where workspace_id=$1 and id=$2`,
            [workspaceA, first.intent_id, persisted.context_checksum],
          ),
        );
      }

      const validClaim = await deliveryStore.claimDelivery(claimInput);
      expect(validClaim).toMatchObject({ attemptNumber: 1, kind: 'ready' });
      if (validClaim.kind !== 'ready')
        throw new Error('Valid notification claim missing');
      await expect(
        deliveryStore.completeDelivery({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: validClaim.attemptNumber,
          maxAttempts: 3,
          retryDelaySeconds: 0,
          result: {
            schemaVersion: 1,
            kind: 'definite_failure',
            safeErrorCode: 'provider.rejected',
            possiblyDispatched: false,
          },
        }),
      ).resolves.toBe('completed');
    } finally {
      await closeFailureNotificationFixture(deliveryStore);
    }
  });

  it('distinguishes busy, due-boundary, terminal, and lowered attempt-ceiling claims', async () => {
    const firstRun = await commitPinnedFailureNotificationRun();
    const first = await failureNotificationIdentity(firstRun.runId);
    const secondRun = await commitPinnedFailureNotificationRun();
    const second = await failureNotificationIdentity(secondRun.runId);
    const { store: deliveryStore } = createTestFailureNotificationStore();
    const claim = (identity: typeof first, maxAttempts = 3) => ({
      workspaceId: workspaceA,
      intentId: identity.intent_id,
      delivery: {
        outboxEventId: identity.outbox_id,
        payloadChecksum: identity.payload_checksum,
      },
      recoverySeconds: 30,
      maxAttempts,
    });
    const latestDelivery = async (intentId: string) => {
      const outbox = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ id: string; payload_checksum: string }>(
          `select id,payload_checksum from app.outbox_events
            where workspace_id=$1 and aggregate_id=$2
            order by created_at desc,id desc limit 1`,
          [workspaceA, intentId],
        ),
      );
      const latest = outbox.rows[0];
      if (latest === undefined) throw new Error('Retry outbox missing');
      return {
        workspaceId: workspaceA,
        intentId,
        delivery: {
          outboxEventId: latest.id,
          payloadChecksum: latest.payload_checksum,
        },
        recoverySeconds: 30,
        maxAttempts: 3,
      };
    };
    try {
      const firstReady = await deliveryStore.claimDelivery(claim(first));
      if (firstReady.kind !== 'ready') throw new Error('First claim missing');
      await expect(deliveryStore.claimDelivery(claim(first))).resolves.toEqual({
        kind: 'busy',
      });
      await expect(
        deliveryStore.fenceDispatch({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: firstReady.attemptNumber,
          deliveryBinding: `email:v1:sha256:${'c'.repeat(64)}`,
        }),
      ).resolves.toBeUndefined();
      await expect(deliveryStore.claimDelivery(claim(first))).resolves.toEqual({
        kind: 'busy',
      });
      await expect(
        deliveryStore.completeDelivery({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: firstReady.attemptNumber,
          maxAttempts: 3,
          retryDelaySeconds: 0,
          result: {
            schemaVersion: 1,
            kind: 'definite_failure',
            safeErrorCode: 'provider.rejected',
            possiblyDispatched: false,
          },
        }),
      ).resolves.toBe('completed');
      await expect(deliveryStore.claimDelivery(claim(first))).resolves.toEqual({
        kind: 'terminal',
      });

      const secondReady = await deliveryStore.claimDelivery(claim(second));
      if (secondReady.kind !== 'ready') throw new Error('Second claim missing');
      await expect(
        deliveryStore.completeDelivery({
          workspaceId: workspaceA,
          intentId: second.intent_id,
          attemptNumber: secondReady.attemptNumber,
          maxAttempts: 3,
          retryDelaySeconds: 30,
          result: {
            schemaVersion: 1,
            kind: 'retry',
            safeErrorCode: 'provider.unavailable',
            possiblyDispatched: false,
          },
        }),
      ).resolves.toBe('completed');
      const attemptTwo = await latestDelivery(second.intent_id);
      await expect(deliveryStore.claimDelivery(attemptTwo)).resolves.toEqual({
        kind: 'busy',
      });
      await asOwner(workspaceA, (client) =>
        client.query(
          `update app.run_failure_notification_intents
              set next_delivery_at=clock_timestamp()
            where workspace_id=$1 and id=$2`,
          [workspaceA, second.intent_id],
        ),
      );
      const attemptTwoReady = await deliveryStore.claimDelivery(attemptTwo);
      expect(attemptTwoReady).toMatchObject({
        attemptNumber: 2,
        kind: 'ready',
      });
      if (attemptTwoReady.kind !== 'ready')
        throw new Error('Due-boundary claim missing');
      await expect(
        deliveryStore.completeDelivery({
          workspaceId: workspaceA,
          intentId: second.intent_id,
          attemptNumber: attemptTwoReady.attemptNumber,
          maxAttempts: 3,
          retryDelaySeconds: 30,
          result: {
            schemaVersion: 1,
            kind: 'retry',
            safeErrorCode: 'provider.unavailable',
            possiblyDispatched: false,
          },
        }),
      ).resolves.toBe('completed');
      const attemptThree = await latestDelivery(second.intent_id);
      await asOwner(workspaceA, (client) =>
        client.query(
          `update app.run_failure_notification_intents
              set next_delivery_at=clock_timestamp()
            where workspace_id=$1 and id=$2`,
          [workspaceA, second.intent_id],
        ),
      );
      await expect(
        deliveryStore.claimDelivery({ ...attemptThree, maxAttempts: 2 }),
      ).resolves.toEqual({ kind: 'terminal' });
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{
            delivery_attempts: number;
            safe_error_code: string;
            status: string;
          }>(
            `select status,delivery_attempts,safe_error_code
               from app.run_failure_notification_intents
              where workspace_id=$1 and id=$2`,
            [workspaceA, second.intent_id],
          ),
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            delivery_attempts: 2,
            safe_error_code: 'delivery.attempts_exhausted',
            status: 'dead_letter',
          },
        ],
      });
    } finally {
      await closeFailureNotificationFixture(deliveryStore);
    }
  });

  it.each([
    {
      boundary: 'intent update',
      matches: (sql: string) =>
        sql.includes('update app.run_failure_notification_intents') &&
        sql.includes("set status='retry'"),
    },
    {
      boundary: 'retry outbox insert',
      matches: (sql: string) => sql.includes('insert into app.outbox_events'),
    },
    {
      boundary: 'completion audit insert',
      matches: (sql: string) =>
        sql.includes('insert into app.run_failure_notification_audit_facts'),
    },
  ])(
    'rolls back every completion write after an injected $boundary failure',
    async ({ boundary, matches }) => {
      const { runId } = await commitPinnedFailureNotificationRun();
      const first = await failureNotificationIdentity(runId);
      const message = `Injected failure after ${boundary}`;
      const { store: deliveryStore } = createTestFailureNotificationStore({
        matches,
        message,
      });
      try {
        const claimed = await deliveryStore.claimDelivery({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          delivery: {
            outboxEventId: first.outbox_id,
            payloadChecksum: first.payload_checksum,
          },
          recoverySeconds: 30,
          maxAttempts: 3,
        });
        if (claimed.kind !== 'ready')
          throw new Error('Failure-injection claim missing');
        await expect(
          deliveryStore.completeDelivery({
            workspaceId: workspaceA,
            intentId: first.intent_id,
            attemptNumber: claimed.attemptNumber,
            maxAttempts: 3,
            retryDelaySeconds: 30,
            result: {
              schemaVersion: 1,
              kind: 'retry',
              safeErrorCode: 'provider.unavailable',
              possiblyDispatched: false,
            },
          }),
        ).rejects.toThrow(message);
        await expect(
          asRuntime(workerBaseUrl, workspaceA, (client) =>
            client.query<{
              completion_fact_count: number;
              next_delivery_at: Date | null;
              outbox_count: number;
              status: string;
            }>(
              `select intent.status,intent.next_delivery_at,
                      (select count(*)::int from app.outbox_events outbox
                        where outbox.aggregate_id=intent.id) outbox_count,
                      (select count(*)::int
                         from app.run_failure_notification_audit_facts fact
                        where fact.notification_intent_id=intent.id
                          and fact.fact_type='retry_scheduled') completion_fact_count
                 from app.run_failure_notification_intents intent
                where intent.workspace_id=$1 and intent.id=$2`,
              [workspaceA, first.intent_id],
            ),
          ),
        ).resolves.toMatchObject({
          rows: [
            {
              completion_fact_count: 0,
              next_delivery_at: null,
              outbox_count: 1,
              status: 'claimed',
            },
          ],
        });
        await expect(
          deliveryStore.completeDelivery({
            workspaceId: workspaceA,
            intentId: first.intent_id,
            attemptNumber: claimed.attemptNumber,
            maxAttempts: 3,
            retryDelaySeconds: 0,
            result: {
              schemaVersion: 1,
              kind: 'definite_failure',
              safeErrorCode: 'provider.rejected',
              possiblyDispatched: false,
            },
          }),
        ).resolves.toBe('completed');
      } finally {
        await closeFailureNotificationFixture(deliveryStore);
      }
    },
  );

  it('cancels completion before checkout and while its intent lock is blocked', async () => {
    const preabortRun = await commitPinnedFailureNotificationRun();
    const preabortIdentity = await failureNotificationIdentity(
      preabortRun.runId,
    );
    const { applicationName: preabortApplicationName, store: preabortStore } =
      createTestFailureNotificationStore();
    const preabortConnectionsBefore = await asOwner(workspaceA, (client) =>
      client.query<{ connections: number }>(
        `select count(*)::int connections from pg_stat_activity
            where datname=current_database() and application_name=$1`,
        [preabortApplicationName],
      ),
    );
    const preabortController = new AbortController();
    preabortController.abort();
    try {
      await expect(
        preabortStore.completeDelivery({
          workspaceId: workspaceA,
          intentId: preabortIdentity.intent_id,
          attemptNumber: 1,
          maxAttempts: 3,
          retryDelaySeconds: 30,
          result: {
            schemaVersion: 1,
            kind: 'retry',
            safeErrorCode: 'provider.unavailable',
            possiblyDispatched: false,
          },
          signal: preabortController.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      const preabortConnections = await asOwner(workspaceA, (client) =>
        client.query<{ connections: number }>(
          `select count(*)::int connections from pg_stat_activity
            where datname=current_database() and application_name=$1`,
          [preabortApplicationName],
        ),
      );
      expect(preabortConnections.rows[0]?.connections).toBe(
        preabortConnectionsBefore.rows[0]?.connections,
      );
    } finally {
      await closeFailureNotificationFixture(preabortStore);
    }

    const blockedRun = await commitPinnedFailureNotificationRun();
    const blockedIdentity = await failureNotificationIdentity(blockedRun.runId);
    const { applicationName: blockedApplicationName, store: blockedStore } =
      createTestFailureNotificationStore();
    const claim = await blockedStore.claimDelivery({
      workspaceId: workspaceA,
      intentId: blockedIdentity.intent_id,
      delivery: {
        outboxEventId: blockedIdentity.outbox_id,
        payloadChecksum: blockedIdentity.payload_checksum,
      },
      recoverySeconds: 30,
      maxAttempts: 3,
    });
    if (claim.kind !== 'ready') throw new Error('Blocked claim missing');
    const blockerPool = new Pool({
      connectionString: databaseUrl(workerBaseUrl),
      max: 1,
    });
    const blocker = await blockerPool.connect();
    const controller = new AbortController();
    let completion: Promise<'completed' | 'stale'> | undefined;
    try {
      await blocker.query('begin');
      await blocker.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      await blocker.query(
        `select id from app.run_failure_notification_intents
          where workspace_id=$1 and id=$2 for update`,
        [workspaceA, blockedIdentity.intent_id],
      );
      completion = blockedStore.completeDelivery({
        workspaceId: workspaceA,
        intentId: blockedIdentity.intent_id,
        attemptNumber: claim.attemptNumber,
        maxAttempts: 3,
        retryDelaySeconds: 30,
        result: {
          schemaVersion: 1,
          kind: 'retry',
          safeErrorCode: 'provider.unavailable',
          possiblyDispatched: false,
        },
        signal: controller.signal,
      });
      await waitForApplicationLocks(blockedApplicationName, 1);
      controller.abort();
      await expect(completion).rejects.toMatchObject({ name: 'AbortError' });
      await blocker.query('commit');
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{ outbox_count: number; status: string }>(
            `select intent.status,
                    (select count(*)::int from app.outbox_events outbox
                      where outbox.aggregate_id=intent.id) outbox_count
               from app.run_failure_notification_intents intent
              where intent.workspace_id=$1 and intent.id=$2`,
            [workspaceA, blockedIdentity.intent_id],
          ),
        ),
      ).resolves.toMatchObject({
        rows: [{ outbox_count: 1, status: 'claimed' }],
      });
      await expect(
        blockedStore.completeDelivery({
          workspaceId: workspaceA,
          intentId: blockedIdentity.intent_id,
          attemptNumber: claim.attemptNumber,
          maxAttempts: 3,
          retryDelaySeconds: 0,
          result: {
            schemaVersion: 1,
            kind: 'definite_failure',
            safeErrorCode: 'provider.rejected',
            possiblyDispatched: false,
          },
        }),
      ).resolves.toBe('completed');
    } finally {
      controller.abort();
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
      await blockerPool.end();
      await Promise.allSettled([
        completion,
        closeFailureNotificationFixture(blockedStore),
      ]);
    }
  });

  it('surfaces commit-ack uncertainty while a repeated completion observes committed truth', async () => {
    const { runId } = await commitPinnedFailureNotificationRun();
    const first = await failureNotificationIdentity(runId);
    const { store: ordinaryStore } = createTestFailureNotificationStore();
    const claimed = await ordinaryStore.claimDelivery({
      workspaceId: workspaceA,
      intentId: first.intent_id,
      delivery: {
        outboxEventId: first.outbox_id,
        payloadChecksum: first.payload_checksum,
      },
      recoverySeconds: 30,
      maxAttempts: 3,
    });
    if (claimed.kind !== 'ready')
      throw new Error('Commit-uncertainty claim missing');
    await ordinaryStore.fenceDispatch({
      workspaceId: workspaceA,
      intentId: first.intent_id,
      attemptNumber: claimed.attemptNumber,
      deliveryBinding: `email:v1:sha256:${'9'.repeat(64)}`,
    });
    const { store: uncertainStore } = createTestFailureNotificationStore({
      matches: (sql) => sql.trim().toLowerCase() === 'commit',
      message: 'Injected notification commit acknowledgement loss',
    });
    const completion = {
      workspaceId: workspaceA,
      intentId: first.intent_id,
      attemptNumber: claimed.attemptNumber,
      maxAttempts: 3,
      retryDelaySeconds: 0,
      result: {
        schemaVersion: 1 as const,
        kind: 'delivered' as const,
        possiblyDispatched: true as const,
        providerReference: 'provider-reference-committed',
      },
    };
    try {
      await expect(uncertainStore.completeDelivery(completion)).rejects.toThrow(
        'Injected notification commit acknowledgement loss',
      );
      await expect(ordinaryStore.completeDelivery(completion)).resolves.toBe(
        'stale',
      );
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{
            delivered_facts: number;
            provider_reference: string;
            status: string;
          }>(
            `select intent.status,intent.provider_reference,
                    (select count(*)::int
                       from app.run_failure_notification_audit_facts fact
                      where fact.notification_intent_id=intent.id
                        and fact.fact_type='delivered') delivered_facts
               from app.run_failure_notification_intents intent
              where intent.workspace_id=$1 and intent.id=$2`,
            [workspaceA, first.intent_id],
          ),
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            delivered_facts: 1,
            provider_reference: 'provider-reference-committed',
            status: 'delivered',
          },
        ],
      });
    } finally {
      await Promise.allSettled([
        closeFailureNotificationFixture(ordinaryStore),
        closeFailureNotificationFixture(uncertainStore),
      ]);
    }
  });

  it('enforces destination disable and dispatch fencing against the pinned configuration', async () => {
    const { runId } = await commitPinnedFailureNotificationRun();
    const first = await failureNotificationIdentity(runId);

    const { applicationName: deliveryApplicationName, store: deliveryStore } =
      createTestFailureNotificationStore();
    try {
      const claimInput = {
        workspaceId: workspaceA,
        intentId: first.intent_id,
        delivery: {
          outboxEventId: first.outbox_id,
          payloadChecksum: first.payload_checksum,
        },
        recoverySeconds: 1,
        maxAttempts: 3,
      } as const;
      await asOwner(workspaceA, (client) =>
        client.query(
          `update app.failure_notification_destinations set status='disabled'
              where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        ),
      );
      const claims = await Promise.all([
        deliveryStore.claimDelivery(claimInput),
        deliveryStore.claimDelivery(claimInput),
      ]);
      expect(claims.map(({ kind }) => kind).sort()).toEqual(['busy', 'ready']);
      const ready = claims.find(({ kind }) => kind === 'ready');
      expect(ready?.kind).toBe('ready');
      if (ready?.kind !== 'ready') throw new Error('delivery claim missing');
      expect(ready.context.runId).toBe(runId);

      await asRuntime(apiBaseUrl, workspaceA, async (client) => {
        await client.query(
          `insert into app.failure_notification_destination_versions
               (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
             select workspace_id,destination_id,2,kind,side_effect_class,
                    jsonb_set(config,'{toEmail}','"changed@example.test"'),$3
               from app.failure_notification_destination_versions
              where workspace_id=$1 and destination_id=$2 and version=1`,
          [workspaceA, notificationDestinationId, actorId],
        );
        await client.query(
          `update app.failure_notification_destinations
                set current_config_version=2,status='disabled'
               where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        );
      });
      await expect(
        deliveryStore.loadDestination({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: ready.attemptNumber,
          workerId: 'notification-test-worker',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('Delivery destination is unavailable');
      await asOwner(workspaceA, (client) =>
        client.query(
          `update app.failure_notification_destinations set status='enabled'
              where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        ),
      );
      await expect(
        deliveryStore.loadDestination({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: ready.attemptNumber,
          workerId: 'notification-test-worker',
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        kind: 'email',
        secretVersionId: notificationSecretVersionId,
        toEmail: 'run-store@example.test',
      });
      const credentialAudit = await asOwner(workspaceA, (client) =>
        client.query<{
          actor_id: string;
          actor_kind: string;
          connection_id: string;
          metadata: Record<string, unknown>;
        }>(
          `select connection_id::text,actor_kind,actor_id,metadata
               from app.connection_events
              where workspace_id=$1 and connection_id=$2
                and event_type='connection.credential_accessed'
                and actor_kind='worker' and actor_id='notification-test-worker'
              order by created_at,id`,
          [workspaceA, notificationConnectionId],
        ),
      );
      expect(credentialAudit.rows).toEqual([
        {
          actor_id: 'notification-test-worker',
          actor_kind: 'worker',
          connection_id: notificationConnectionId,
          metadata: {
            purpose: 'failure_notification.deliver',
            secretVersionId: notificationSecretVersionId,
          },
        },
      ]);
      expect(JSON.stringify(credentialAudit.rows)).not.toMatch(
        /run-store@example\.test|ciphertext|encryptedDataKey|kmsKeyReference|nonce|authTag|providerReference/u,
      );

      await asOwner(workspaceA, (client) =>
        client.query(
          `update app.connections set status='revoked'
              where workspace_id=$1 and id=$2`,
          [workspaceA, notificationConnectionId],
        ),
      );
      await expect(
        deliveryStore.loadDestination({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: ready.attemptNumber,
          workerId: 'notification-test-worker-revoked',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('Delivery destination is unavailable');
      await asOwner(workspaceA, (client) =>
        client.query(
          `update app.connections
              set status='active',provider_key='http'
            where workspace_id=$1 and id=$2`,
          [workspaceA, notificationConnectionId],
        ),
      );
      await expect(
        deliveryStore.loadDestination({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: ready.attemptNumber,
          workerId: 'notification-test-worker-wrong-provider',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('Delivery destination is unavailable');
      await asOwner(workspaceA, (client) =>
        client.query(
          `update app.connections
              set provider_key='email',auth_type='http_headers'
            where workspace_id=$1 and id=$2`,
          [workspaceA, notificationConnectionId],
        ),
      );
      await expect(
        deliveryStore.loadDestination({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: ready.attemptNumber,
          workerId: 'notification-test-worker-wrong-auth',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('Delivery destination is unavailable');
      await asOwner(workspaceA, (client) =>
        client.query(
          `update app.connections set auth_type='resend_api_key'
            where workspace_id=$1 and id=$2`,
          [workspaceA, notificationConnectionId],
        ),
      );

      const disablePool = new Pool({
        connectionString: databaseUrl(apiBaseUrl),
        max: 1,
      });
      const disableClient = await disablePool.connect();
      try {
        await disableClient.query('begin');
        await disableClient.query(
          "select set_config('app.workspace_id',$1,true)",
          [workspaceA],
        );
        await disableClient.query(
          `update app.failure_notification_destinations set status='disabled'
              where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        );
        const disabledFence = deliveryStore
          .fenceDispatch({
            workspaceId: workspaceA,
            intentId: first.intent_id,
            attemptNumber: ready.attemptNumber,
            deliveryBinding: `email:v1:sha256:${'a'.repeat(64)}`,
          })
          .then(
            () => ({ kind: 'resolved' as const }),
            (error: unknown) => ({ kind: 'rejected' as const, error }),
          );
        await waitForApplicationLocks(deliveryApplicationName, 1);
        await disableClient.query('commit');
        const fenceResult = await disabledFence;
        expect(fenceResult.kind).toBe('rejected');
        if (fenceResult.kind !== 'rejected')
          throw new Error('disabled destination fence unexpectedly committed');
        expect(fenceResult.error).toEqual(
          expect.objectContaining({
            message: 'Delivery dispatch fence failed',
          }),
        );
      } finally {
        await disableClient.query('rollback').catch(() => undefined);
        disableClient.release();
        await disablePool.end();
      }
      await asRuntime(apiBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.failure_notification_destinations set status='enabled'
              where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        ),
      );
      await expect(
        deliveryStore.fenceDispatch({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: ready.attemptNumber,
          deliveryBinding: `email:v1:sha256:${'a'.repeat(64)}`,
        }),
      ).resolves.toBeUndefined();
      await asRuntime(apiBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.failure_notification_destinations set status='disabled'
              where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        ),
      );
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{ status: string }>(
            `select status from app.run_failure_notification_intents
                where workspace_id=$1 and id=$2`,
            [workspaceA, first.intent_id],
          ),
        ),
      ).resolves.toMatchObject({ rows: [{ status: 'dispatching' }] });
      await asRuntime(apiBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.failure_notification_destinations set status='enabled'
              where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        ),
      );
      await expect(
        deliveryStore.completeDelivery({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: ready.attemptNumber,
          maxAttempts: 3,
          retryDelaySeconds: 0,
          result: {
            schemaVersion: 1,
            kind: 'definite_failure',
            safeErrorCode: 'provider.rejected',
            possiblyDispatched: false,
          },
        }),
      ).resolves.toBe('completed');
    } finally {
      await closeFailureNotificationFixture(deliveryStore);
    }
  });

  it('pins secret rotation while retry recovery preserves historical uncertainty', async () => {
    const { runId } = await commitPinnedFailureNotificationRun();
    const first = await failureNotificationIdentity(runId);
    const { store: deliveryStore } = createTestFailureNotificationStore();
    const claimInput = {
      workspaceId: workspaceA,
      intentId: first.intent_id,
      delivery: {
        outboxEventId: first.outbox_id,
        payloadChecksum: first.payload_checksum,
      },
      recoverySeconds: 1,
      maxAttempts: 3,
    } as const;
    try {
      const firstClaim = await deliveryStore.claimDelivery(claimInput);
      if (firstClaim.kind !== 'ready')
        throw new Error('initial delivery was not claimable');
      await expect(
        deliveryStore.fenceDispatch({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: firstClaim.attemptNumber,
          deliveryBinding: `email:v1:sha256:${'a'.repeat(64)}`,
        }),
      ).resolves.toBeUndefined();
      await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.run_failure_notification_intents
             set recovery_at=clock_timestamp()-interval '1 second'
             where id=$1`,
          [first.intent_id],
        ),
      );
      await expect(deliveryStore.recoverDue(10, 3)).resolves.toBe(1);
      for (let attempt = 2; attempt <= 3; attempt += 1) {
        const next = await asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{ id: string; payload_checksum: string }>(
            `select id,payload_checksum from app.outbox_events
               where aggregate_id=$1 order by created_at desc,id desc limit 1`,
            [first.intent_id],
          ),
        );
        const outbox = next.rows[0];
        if (outbox === undefined) throw new Error('retry outbox missing');
        const claimed = await deliveryStore.claimDelivery({
          ...claimInput,
          delivery: {
            outboxEventId: outbox.id,
            payloadChecksum: outbox.payload_checksum,
          },
        });
        if (claimed.kind !== 'ready')
          throw new Error('retry was not claimable');
        if (attempt === 2) {
          expect(claimed.deliveryBinding).toBe(
            `email:v1:sha256:${'a'.repeat(64)}`,
          );
          await expect(
            deliveryStore.fenceDispatch({
              workspaceId: workspaceA,
              intentId: first.intent_id,
              attemptNumber: claimed.attemptNumber,
              deliveryBinding: `email:v1:sha256:${'b'.repeat(64)}`,
            }),
          ).rejects.toThrow('Delivery dispatch fence failed');
          await expect(
            deliveryStore.fenceDispatch({
              workspaceId: workspaceA,
              intentId: first.intent_id,
              attemptNumber: claimed.attemptNumber,
              deliveryBinding: `email:v1:sha256:${'a'.repeat(64)}`,
            }),
          ).resolves.toBeUndefined();
          const rotatedSecretVersionId = randomUUID();
          await asRuntime(apiBaseUrl, workspaceA, async (client) => {
            await client.query(
              `insert into app.connection_secret_versions (
                   id,workspace_id,connection_id,schema_version,kms_key_reference,
                   encrypted_data_key,ciphertext,nonce,auth_tag,created_by
                 ) values ($1,$2,$3,1,'kms','key2','cipher2','BBBBBBBBBBBBBBBB',
                   'BBBBBBBBBBBBBBBBBBBBBB',$4)`,
              [
                rotatedSecretVersionId,
                workspaceA,
                notificationConnectionId,
                actorId,
              ],
            );
            await client.query(
              `update app.connections set current_secret_version_id=$3
                  where workspace_id=$1 and id=$2`,
              [workspaceA, notificationConnectionId, rotatedSecretVersionId],
            );
          });
          await expect(
            deliveryStore.loadDestination({
              workspaceId: workspaceA,
              intentId: first.intent_id,
              attemptNumber: claimed.attemptNumber,
              workerId: 'notification-test-worker',
              signal: new AbortController().signal,
            }),
          ).rejects.toThrow('Delivery destination is unavailable');
        }
        const workerClock =
          attempt === 2
            ? vi
                .spyOn(Date, 'now')
                .mockReturnValue(Date.parse('2099-01-01T00:00:00.000Z'))
            : undefined;
        try {
          await expect(
            deliveryStore.completeDelivery({
              workspaceId: workspaceA,
              intentId: first.intent_id,
              attemptNumber: claimed.attemptNumber,
              maxAttempts: 3,
              retryDelaySeconds: attempt === 2 ? 30 : 0,
              result: {
                schemaVersion: 1,
                kind: 'retry',
                safeErrorCode: 'provider.unavailable',
                possiblyDispatched: false,
              },
            }),
          ).resolves.toBe('completed');
          if (attempt === 2) {
            const scheduled = await asRuntime(
              workerBaseUrl,
              workspaceA,
              (client) =>
                client.query<{
                  due_in_seconds: number;
                  id: string;
                  payload_checksum: string;
                }>(
                  `select extract(epoch from intent.next_delivery_at-clock_timestamp())::float8 due_in_seconds,
                            outbox.id,outbox.payload_checksum
                     from app.run_failure_notification_intents intent
                     join app.outbox_events outbox on outbox.aggregate_id=intent.id
                     where intent.id=$1 order by outbox.created_at desc,outbox.id desc limit 1`,
                  [first.intent_id],
                ),
            );
            const retry = scheduled.rows[0];
            expect(retry?.due_in_seconds).toBeGreaterThan(25);
            expect(retry?.due_in_seconds).toBeLessThanOrEqual(30);
            if (retry === undefined) throw new Error('retry schedule missing');
            await expect(
              deliveryStore.claimDelivery({
                ...claimInput,
                delivery: {
                  outboxEventId: retry.id,
                  payloadChecksum: retry.payload_checksum,
                },
              }),
            ).resolves.toEqual({ kind: 'busy' });
            await asRuntime(workerBaseUrl, workspaceA, (client) =>
              client.query(
                `update app.run_failure_notification_intents
                   set next_delivery_at=clock_timestamp()-interval '1 second'
                   where id=$1`,
                [first.intent_id],
              ),
            );
          }
        } finally {
          workerClock?.mockRestore();
        }
      }
      const terminal = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          status: string;
          run_status: string;
          event_count: number;
        }>(
          `select intent.status,run.status run_status,
                    (select count(*)::int from app.run_events event
                      where event.workflow_run_id=run.id) event_count
             from app.run_failure_notification_intents intent
             join app.workflow_runs run on run.id=intent.workflow_run_id
             where intent.id=$1`,
          [first.intent_id],
        ),
      );
      expect(terminal.rows[0]).toEqual({
        status: 'outcome_unknown',
        run_status: 'failed',
        event_count: 3,
      });

      const exhaustedId = randomUUID();
      await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `insert into app.run_failure_notification_intents (
               id,workspace_id,workflow_run_id,terminal_event_sequence,policy_version,
               destination_id,destination_config_version,side_effect_class,
               connection_secret_version_id,delivery_binding,context,context_checksum,
               status,delivery_attempts,dispatch_marked_at,recovery_at,possibly_dispatched
             ) select $1,workspace_id,workflow_run_id,terminal_event_sequence+2,policy_version,
                      destination_id,destination_config_version,'idempotent_with_key',
                      connection_secret_version_id,$3,context,context_checksum,
                      'dispatching',3,clock_timestamp(),clock_timestamp()+interval '1 minute',true
                 from app.run_failure_notification_intents where id=$2`,
          [exhaustedId, first.intent_id, `email:v1:sha256:${'b'.repeat(64)}`],
        ),
      );
      await expect(
        deliveryStore.completeDelivery({
          workspaceId: workspaceA,
          intentId: exhaustedId,
          attemptNumber: 3,
          maxAttempts: 3,
          retryDelaySeconds: 0,
          result: {
            schemaVersion: 1,
            kind: 'retry',
            safeErrorCode: 'delivery.provider_ambiguous',
            possiblyDispatched: true,
          },
        }),
      ).resolves.toBe('completed');
      const exhausted = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ status: string; possibly_dispatched: boolean }>(
          `select status,possibly_dispatched
                 from app.run_failure_notification_intents where id=$1`,
          [exhaustedId],
        ),
      );
      expect(exhausted.rows[0]).toEqual({
        status: 'outcome_unknown',
        possibly_dispatched: true,
      });

      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query(
            `insert into app.run_failure_notification_intents (
               id,workspace_id,workflow_run_id,terminal_event_sequence,policy_version,
               destination_id,destination_config_version,side_effect_class,
               context,context_checksum,status,delivery_attempts,dispatch_marked_at,recovery_at
             ) select $1,workspace_id,workflow_run_id,terminal_event_sequence+1,policy_version,
                       destination_id,destination_config_version,'unsafe',context,context_checksum,
                      'dispatching',1,clock_timestamp()-interval '2 seconds',
                      clock_timestamp()-interval '1 second'
               from app.run_failure_notification_intents where id=$2`,
            [randomUUID(), first.intent_id],
          ),
        ),
      ).rejects.toThrow(
        'new failure notification intent must exactly match its run pin',
      );
    } finally {
      await closeFailureNotificationFixture(deliveryStore);
    }
  });

  it('excludes a policy-pinned canceled transition from notification intent creation', async () => {
    const canceledRun = await insertRun({
      status: 'running',
      schedulerState: checkpoint({ runStatus: 'running' }),
      failureNotificationPolicy: {
        destinationId: notificationDestinationId,
        destinationConfigVersion: 1,
        sideEffectClass: 'idempotent_with_key',
        connectionSecretVersionId: notificationSecretVersionId,
      },
    });
    await asRuntime(apiBaseUrl, workspaceA, async (client) => {
      await client.query(
        `update app.workflow_runs
         set cancel_requested_at=clock_timestamp(),cancel_requested_by='q12-test'
         where workspace_id=$1 and id=$2`,
        [workspaceA, canceledRun],
      );
      await client.query(
        `insert into app.run_events (
           workspace_id,workflow_run_id,sequence,type,payload
         ) values ($1,$2,2,'run.cancel_requested','{"schemaVersion":1}')`,
        [workspaceA, canceledRun],
      );
    });
    const delivery = await testDelivery(workspaceA, canceledRun, 0);
    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: canceledRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        delivery,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 2,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'canceled',
            nextEventSequence: 4,
            cancelRequested: true,
          }),
          events: [
            {
              schemaVersion: 1,
              sequence: 3,
              name: 'run.canceled',
              occurredAt: '2026-09-13T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
    const excluded = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ intent_count: number; notification_outbox_count: number }>(
        `select count(distinct intent.id)::int intent_count,
                count(distinct outbox.id)::int notification_outbox_count
         from app.workflow_runs run
         left join app.run_failure_notification_intents intent
           on intent.workspace_id=run.workspace_id
          and intent.workflow_run_id=run.id
         left join app.outbox_events outbox on outbox.aggregate_id=intent.id
         where run.workspace_id=$1 and run.id=$2`,
        [workspaceA, canceledRun],
      ),
    );
    expect(excluded.rows).toEqual([
      { intent_count: 0, notification_outbox_count: 0 },
    ]);
  });
});
