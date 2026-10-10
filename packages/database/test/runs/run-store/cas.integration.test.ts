import { Pool, type Pool as PgPool, type PoolClient } from 'pg';
import { describe, it, expect } from 'vitest';

import {
  CoordinatorRunStateCorruptError,
  asRuntime,
  checkpoint,
  createTestRunStore,
  databaseUrl,
  insertRun,
  nodeAttemptStore,
  ownedDeliveryStore,
  parseDatabaseConfig,
  rawStore,
  testDelivery,
  versionA,
  workerBaseUrl,
  workspaceA,
} from './run-store.fixtures.js';
import { createDatabaseRuntime } from '../../../src/platform/pool/runtime.js';

describe('Coordinator CAS and transition invariants', () => {
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
          const text =
            typeof request === 'string'
              ? request
              : typeof request === 'object' &&
                  request !== null &&
                  'text' in request &&
                  typeof request.text === 'string'
                ? request.text
                : '';
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
            schemaVersion: 1 as const,
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

  it('rolls back all writes when a late physical event membership check fails', async () => {
    const admitted = 'version-a/admitted';
    const ghost = 'version-a/ghost';
    const runId = await insertRun({
      schedulerState: checkpoint({
        readySet: [ghost],
        invocations: [
          {
            invocationKey: ghost,
            nodeId: 'ghost',
            status: 'ready',
            attemptNumber: 0,
          },
        ],
      }),
    });
    await expect(
      ownedDeliveryStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 5,
            readySet: [],
            admittedInvocationKeys: [admitted],
            invocations: [
              {
                invocationKey: admitted,
                nodeId: 'admitted',
                status: 'running',
                attemptNumber: 1,
              },
              {
                invocationKey: ghost,
                nodeId: 'ghost',
                status: 'failed',
                attemptNumber: 0,
              },
            ],
          }),
          events: [
            {
              schemaVersion: 1,
              sequence: 2,
              name: 'run.started',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
            {
              schemaVersion: 1,
              sequence: 3,
              name: 'node.ready',
              occurredAt: '2026-08-21T00:00:00.000Z',
              invocationKey: admitted,
              nodeId: 'admitted',
              attemptNumber: 0,
            },
            {
              schemaVersion: 1,
              sequence: 4,
              name: 'node.failed',
              occurredAt: '2026-08-21T00:00:00.000Z',
              invocationKey: ghost,
              nodeId: 'ghost',
              attemptNumber: 0,
            },
          ],
          nodeRunAdmissions: [
            {
              invocationKey: admitted,
              nodeId: 'admitted',
              sideEffectClass: 'safe',
            },
          ],
          attempts: [
            {
              invocationKey: admitted,
              nodeId: 'admitted',
              attemptNumber: 1,
              sideEffectClass: 'safe',
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
    const counts = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        nodes: number;
        attempts: number;
        events: number;
        inbox: number;
        revision: number;
      }>(
        `select
             (select count(*)::int from app.node_runs where workflow_run_id=$1) nodes,
             (select count(*)::int from app.node_attempts attempt join app.node_runs node on node.id=attempt.node_run_id where node.workflow_run_id=$1) attempts,
             (select count(*)::int from app.run_events where workflow_run_id=$1) events,
             (select count(*)::int from app.inbox_receipts receipt
               join app.outbox_events event on event.id=receipt.message_id
               where event.aggregate_id=$1) inbox,
             (select revision from app.run_checkpoints where workflow_run_id=$1) revision`,
        [runId],
      ),
    );
    expect(counts.rows[0]).toEqual({
      nodes: 0,
      attempts: 0,
      events: 1,
      inbox: 0,
      revision: 0,
    });
  });

  it('atomically persists branch-scoped ready and skipped node runs', async () => {
    const selectedKey = `${versionA}|selected|b:condition%3Atrue|i:`;
    const skippedKey = `${versionA}|skipped|b:condition%3Afalse|i:`;
    const initial = {
      ...checkpoint({}),
      schemaVersion: 2,
      branchSelections: [],
    } as const;
    const runId = await insertRun({ schedulerState: initial });

    await expect(
      ownedDeliveryStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: {
            ...initial,
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 5,
            admittedInvocationKeys: [selectedKey],
            invocations: [
              {
                invocationKey: selectedKey,
                nodeId: 'selected',
                status: 'running',
                attemptNumber: 1,
                branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
              },
              {
                invocationKey: skippedKey,
                nodeId: 'skipped',
                status: 'skipped',
                attemptNumber: 0,
                branchPath: [{ nodeId: 'condition', outputPort: 'false' }],
              },
            ],
          },
          events: [
            {
              schemaVersion: 1,
              sequence: 2,
              name: 'run.started',
              occurredAt: '2026-08-24T00:00:00.000Z',
            },
            {
              schemaVersion: 1,
              sequence: 3,
              name: 'node.ready',
              occurredAt: '2026-08-24T00:00:00.000Z',
              invocationKey: selectedKey,
              nodeId: 'selected',
              attemptNumber: 0,
            },
            {
              schemaVersion: 1,
              sequence: 4,
              name: 'node.skipped',
              occurredAt: '2026-08-24T00:00:00.000Z',
              invocationKey: skippedKey,
              nodeId: 'skipped',
              attemptNumber: 0,
            },
          ],
          nodeRunAdmissions: [
            {
              invocationKey: selectedKey,
              nodeId: 'selected',
              sideEffectClass: 'safe',
              branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
            },
            {
              invocationKey: skippedKey,
              nodeId: 'skipped',
              sideEffectClass: 'safe',
              branchPath: [{ nodeId: 'condition', outputPort: 'false' }],
            },
          ],
          attempts: [
            {
              invocationKey: selectedKey,
              nodeId: 'selected',
              attemptNumber: 1,
              sideEffectClass: 'safe',
              branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
            },
          ],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed' });

    const persisted = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        invocation_key: string;
        branch_context: unknown;
        status: string;
        attempts: number;
        deliveries: number;
      }>(
        `select node.invocation_key,node.branch_context,node.status,
                    count(distinct attempt.id)::int attempts,
                    count(distinct event.id)::int deliveries
               from app.node_runs node
               left join app.node_attempts attempt on attempt.node_run_id=node.id
               left join app.outbox_events event
                 on event.aggregate_id=attempt.id
                and event.job_name='execute-node-attempt'
              where node.workspace_id=$1 and node.workflow_run_id=$2
              group by node.id
              order by node.invocation_key`,
        [workspaceA, runId],
      ),
    );
    expect(persisted.rows).toEqual([
      {
        invocation_key: selectedKey,
        branch_context: {
          branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
        },
        status: 'ready',
        attempts: 1,
        deliveries: 1,
      },
      {
        invocation_key: skippedKey,
        branch_context: {
          branchPath: [{ nodeId: 'condition', outputPort: 'false' }],
        },
        status: 'skipped',
        attempts: 0,
        deliveries: 0,
      },
    ]);
    const selectedAttempt = await asRuntime(
      workerBaseUrl,
      workspaceA,
      (client) =>
        client.query<{
          attempt_id: string;
          node_run_id: string;
          outbox_id: string;
          payload_checksum: string;
        }>(
          `select attempt.id attempt_id,node.id node_run_id,
                    event.id outbox_id,event.payload_checksum
               from app.node_runs node
               join app.node_attempts attempt on attempt.node_run_id=node.id
               join app.outbox_events event on event.aggregate_id=attempt.id
              where node.workspace_id=$1 and node.workflow_run_id=$2
                and node.invocation_key=$3
                and event.job_name='execute-node-attempt'`,
          [workspaceA, runId, selectedKey],
        ),
    );
    const selectedDelivery = selectedAttempt.rows[0];
    if (selectedDelivery === undefined)
      throw new Error('branch-scoped fixture attempt missing');
    await expect(
      nodeAttemptStore.claimDelivery({
        workspaceId: workspaceA,
        runId,
        nodeRunId: selectedDelivery.node_run_id,
        attemptId: selectedDelivery.attempt_id,
        delivery: {
          outboxEventId: selectedDelivery.outbox_id,
          payloadChecksum: selectedDelivery.payload_checksum,
        },
        leaseDurationSeconds: 30,
        workerId: 'attempt-worker-branch',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      kind: 'claimed',
      lease: {
        invocationKey: selectedKey,
        branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
      },
    });
    await expect(
      ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'ready' });
  });
});
