import { requestText } from '../../../support/postgres/query-text.js';
import { Pool, type Pool as PgPool, type PoolClient } from 'pg';
import { it, expect } from 'vitest';
import {
  asRuntime,
  checkpoint,
  createTestRunStore,
  databaseUrl,
  insertRun,
  parseDatabaseConfig,
  rawStore,
  testDelivery,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../fixtures.js';
import { createDatabaseRuntime } from '@pertexo/database/platform';

export function registerReplaysSafelyCommitAcknowledgementIs(): void {
  it('replays safely when the commit acknowledgement is lost', async () => {
    const applicationName = `commit-ack-loss-${String(process.pid)}`;
    const connectionUrl = new URL(databaseUrl(workerBaseUrl));
    connectionUrl.searchParams.set('application_name', applicationName);
    const config = parseDatabaseConfig({
      connectionString: connectionUrl.toString(),
      max: 1,
      ownerRole: 'pertexo_owner',
    });
    const wrappedClients = new WeakSet<PoolClient>();
    let loseCommitAcknowledgement = true;
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
          const result = originalQuery(...queryArguments);
          if (
            loseCommitAcknowledgement &&
            text.trim().toLowerCase() === 'commit'
          ) {
            loseCommitAcknowledgement = false;
            return Promise.resolve(result).then(() => {
              throw new Error('Injected commit acknowledgement loss');
            });
          }
          return result;
        }) as typeof client.query;
        return client;
      });
    } as typeof Pool.prototype.connect;

    let runtime: ReturnType<typeof createDatabaseRuntime> | undefined;
    let lossStore: ReturnType<typeof createTestRunStore> | undefined;
    try {
      runtime = createDatabaseRuntime(config, { monitorLockWaits: false });
      lossStore = createTestRunStore(config, runtime);
    } finally {
      Pool.prototype.connect = originalConnect as typeof Pool.prototype.connect;
    }

    const runId = await insertRun({});
    const delivery = await testDelivery(workspaceA, runId, 0);
    const input = {
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      delivery,
      signal: new AbortController().signal,
      plan: {
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
            occurredAt: '2026-09-13T00:00:00.000Z',
          },
        ],
        nodeRunAdmissions: [],
        attempts: [],
      },
    };
    try {
      await expect(lossStore.commitAdvancePlan(input)).rejects.toThrow(
        'Injected commit acknowledgement loss',
      );
      await expect(rawStore.commitAdvancePlan(input)).resolves.toEqual({
        kind: 'already_committed',
        revision: 1,
      });
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query(
            `select checkpoint.revision,
                    count(event.sequence)::int event_count,
                    bool_and(receipt.completed_at is not null) receipt_completed
             from app.run_checkpoints checkpoint
             join app.run_events event
               on event.workflow_run_id=checkpoint.workflow_run_id
             join app.inbox_receipts receipt on receipt.message_id=$3
             where checkpoint.workspace_id=$1 and checkpoint.workflow_run_id=$2
             group by checkpoint.revision`,
            [workspaceA, runId, delivery.outboxEventId],
          ),
        ),
      ).resolves.toMatchObject({
        rows: [{ revision: 1, event_count: 2, receipt_completed: true }],
      });
    } finally {
      const closed = await Promise.allSettled([
        lossStore.close(),
        runtime.close(),
      ]);
      const failures: Error[] = [];
      for (const result of closed)
        if (result.status === 'rejected')
          failures.push(
            result.reason instanceof Error
              ? result.reason
              : new Error('Commit-loss cleanup rejected', {
                  cause: result.reason,
                }),
          );
      if (failures.length > 0) {
        // eslint-disable-next-line no-unsafe-finally -- Every cleanup owner has settled and its failure must remain visible.
        throw new AggregateError(
          failures,
          'Commit-loss fixture cleanup failed',
        );
      }
    }
  });
}
