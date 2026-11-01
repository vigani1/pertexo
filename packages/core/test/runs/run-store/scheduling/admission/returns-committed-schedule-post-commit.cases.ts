import { requestText } from '../../../../support/postgres/query-text.js';
import { it, expect } from 'vitest';

import type { Pool as PgPool, PoolClient, QueryResult } from 'pg';
import {
  Pool,
  asRuntime,
  checkpoint,
  createTestRunStore,
  databaseUrl,
  insertRun,
  parseDatabaseConfig,
  randomUUID,
  rawStore,
  testDelivery,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../../fixtures.js';
import { createDatabaseRuntime } from '@pertexo/database/platform';

export function registerReturnsCommittedSchedulePostCommit(): void {
  it('returns a committed schedule when post-commit observation is aborted', async () => {
    const applicationName = `held-schedule-observation-${randomUUID()}`;
    const connectionUrl = new URL(databaseUrl(workerBaseUrl));
    connectionUrl.searchParams.set('application_name', applicationName);
    const config = parseDatabaseConfig({
      connectionString: connectionUrl.toString(),
      max: 1,
      ownerRole: 'pertexo_owner',
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
          const text = requestText(request);
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
    let scheduleStore: ReturnType<typeof createTestRunStore> | undefined;
    try {
      runtime = createDatabaseRuntime(config, { monitorLockWaits: false });
      scheduleStore = createTestRunStore(config, runtime);
    } finally {
      Pool.prototype.connect = originalConnect as typeof Pool.prototype.connect;
    }

    const scheduledAt = '2026-09-13T00:00:00.000Z';
    const runId = await insertRun({
      triggerType: 'schedule',
      inputRef: {
        kind: 'inline',
        value: {
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
}
