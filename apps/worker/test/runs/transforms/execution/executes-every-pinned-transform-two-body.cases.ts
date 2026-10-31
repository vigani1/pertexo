import { createHash, randomUUID } from 'node:crypto';
import { createWorkflowRunDatabase } from '@pertexo/database/runs';
import {
  createOutboxDispatcherDatabase,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { initialCheckpointFactory } from '@pertexo/execution';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';
import {
  validateWorkflowGraph,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import { expect, it } from 'vitest';
import { createCoordinatorRuntime } from '../../../../dist/runs/runtime.js';
import { WorkerDrainState } from '../../../../dist/runtime/shutdown/drain-state.js';
import { OutboxDispatcher } from '../../../../dist/transport/outbox/dispatch/runtime.js';
import { coordinatorFixture as fixture } from '../../../support/coordinator/consumer.js';
import { insertCompiledWorkflow } from '../../../support/coordinator/workflows.js';
import { node, output, links, graph } from './fixture.js';
import { testNodeAttemptRuntime } from '../../../support/runtime-factories.js';

export function registerExecutesEveryPinnedTransformTwoBody(): void {
  it('executes every pinned transform in two body invocations and retains existing v1 nodes', async () => {
    const workflowId = randomUUID(),
      workflowVersionId = randomUUID();
    expect(validateWorkflowGraph(graph()).issues).toEqual([]);
    await insertCompiledWorkflow(fixture.ownerQuery, {
      actorId: fixture.actorId,
      workspaceId: fixture.workspaceId,
      identity: { workflowId, workflowVersionId },
      graph: graph(),
      name: 'Transform loop proof',
      catalog: PLATFORM_NODE_CATALOG,
    });
    await fixture.ownerQuery(
      'update app.workflows set published_version_id=$2 where id=$1',
      [workflowId, workflowVersionId],
    );
    const config = (url: string, max: number) =>
      parseDatabaseConfig({
        connectionString: fixture.databaseUrl(url),
        max,
      });
    const runs = createWorkflowRunDatabase(config(fixture.apiUrl, 4));
    const owners: (() => Promise<void>)[] = [() => runs.close()];
    const errors: unknown[] = [];
    try {
      const coordinator = await createCoordinatorRuntime({
        maintenanceDatabase: config(fixture.dispatcherUrl, 2),
        database: config(fixture.workerUrl, 6),
        maximumAdmissions: 10,
        redisUrl: fixture.redisUrl,
      });
      owners.push(() => coordinator.close());
      const attempts = await testNodeAttemptRuntime(
        {
          database: config(fixture.workerUrl, 6),
          heartbeatIntervalMillis: 1_000,
          leaseDurationSeconds: 10,
          redisUrl: fixture.redisUrl,
          workerId: `transforms-${randomUUID()}`,
        },
        { registry: createPlatformNodeRegistry() },
      );
      owners.push(() => attempts.close());
      const store = createOutboxDispatcherDatabase(
        config(fixture.dispatcherUrl, 2),
      );
      owners.push(() => store.close());
      const producer = createQueueProducer({ redisUrl: fixture.redisUrl });
      owners.push(() => producer.close());
      const dispatcher = new OutboxDispatcher(store, producer, {
        drainState: new WorkerDrainState(),
        options: {
          batchSize: 10,
          jobNames: [JOB_NAME.advanceWorkflowRun, JOB_NAME.executeNodeAttempt],
          leaseDurationMillis: 30_000,
          leaseOwner: `transforms-${randomUUID()}`,
          retryDelayMillis: 1_000,
          pollIntervalMillis: 250,
        },
      });
      owners.splice(-2, 2, () => dispatcher.close());
      await Promise.all([
        coordinator.consumer.waitUntilReady(5_000),
        attempts.consumer.waitUntilReady(5_000),
        producer.waitUntilReady(5_000),
      ]);
      dispatcher.start();
      const key = createHash('sha256').update(randomUUID()).digest('hex');
      const accepted = await runs.start({
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        workflowId,
        idempotencyKeyHash: key,
        requestHash: key,
        scope: `workflow:${workflowId}:manual`,
        input: {},
        checkpointFactory: initialCheckpointFactory({
          catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG),
        }),
      });
      const terminal = await fixture.waitFor(
        () =>
          fixture.workerQuery<{ status: string; error_summary: unknown }>(
            'select status,error_summary from app.workflow_runs where id=$1',
            [accepted.run.id],
          ),
        (rows) =>
          ['succeeded', 'failed', 'outcome_unknown'].includes(
            rows[0]?.status ?? '',
          ),
        30_000,
      );
      expect(terminal).toEqual([{ status: 'succeeded', error_summary: null }]);
      const facts = await fixture.workerQuery<{
        node_id: string;
        status: string;
        output_ref: unknown;
      }>(
        'select node_id,status,output_ref from app.node_runs where workflow_run_id=$1 order by node_id,invocation_key',
        [accepted.run.id],
      );
      expect(facts.every((f) => f.status === 'succeeded')).toBe(true);
      for (const id of [
        'filter',
        'sort',
        'unique',
        'summary',
        'date',
        'take',
        'concat',
        'batch',
        'result',
      ])
        expect(facts.filter((f) => f.node_id === id)).toHaveLength(2);
      expect(
        facts.filter((f) => f.node_id === 'unique').map((f) => f.output_ref),
      ).toEqual([
        {
          kind: 'inline',
          value: {
            items: [3, 1],
            inputCount: 3,
            duplicateCount: 1,
            skippedCount: 0,
          },
        },
        {
          kind: 'inline',
          value: {
            items: [4, 2],
            inputCount: 3,
            duplicateCount: 1,
            skippedCount: 0,
          },
        },
      ]);
      expect(
        facts.filter((f) => f.node_id === 'date').map((f) => f.output_ref),
      ).toEqual(
        [0, 1].map(() => ({
          kind: 'inline',
          value: { value: 1767225600000 },
        })),
      );
      expect(
        facts.filter((f) => f.node_id === 'result').map((f) => f.output_ref),
      ).toEqual(
        [4, 6].map((sum, i) => ({
          kind: 'inline',
          value: {
            summary: {
              groups: [
                {
                  key: null,
                  count: 3,
                  sum,
                  min: 0,
                  max: i + 3,
                  average: sum / 3,
                },
              ],
              inputCount: 3,
              skippedCount: 0,
            },
          },
        })),
      );
      const maximumId = {
        workflowId: randomUUID(),
        workflowVersionId: randomUUID(),
      };
      const maximum: WorkflowGraph = {
        settings: { maxRunDurationMs: 60_000 },
        nodes: [
          node('manual', 'core.manual'),
          node(
            'take',
            'core.take',
            { count: 4998 },
            {
              items: {
                kind: 'literal',
                value: Array.from({ length: 4998 }, (_, i) => i),
              },
            },
          ),
          node(
            'concat',
            'core.concat',
            {},
            {
              items: output('take', '$.items'),
              otherItems: { kind: 'literal', value: [] },
            },
          ),
          node(
            'batch',
            'core.batch',
            { size: 1 },
            { items: output('concat', '$.items') },
          ),
          node(
            'stop',
            'core.terminate',
            {},
            { result: output('batch', '$.batches') },
          ),
        ],
        edges: links(['manual', 'take', 'concat', 'batch', 'stop']),
      };
      await insertCompiledWorkflow(fixture.ownerQuery, {
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        identity: maximumId,
        graph: maximum,
        name: 'Maximum bounded list proof',
        catalog: PLATFORM_NODE_CATALOG,
      });
      await fixture.ownerQuery(
        'update app.workflows set published_version_id=$2 where id=$1',
        [maximumId.workflowId, maximumId.workflowVersionId],
      );
      const maximumKey = createHash('sha256')
        .update(randomUUID())
        .digest('hex');
      const maximumRun = await runs.start({
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        workflowId: maximumId.workflowId,
        idempotencyKeyHash: maximumKey,
        requestHash: maximumKey,
        scope: `workflow:${maximumId.workflowId}:manual`,
        input: {},
        checkpointFactory: initialCheckpointFactory({
          catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG),
        }),
      });
      const maximumTerminal = await fixture.waitFor(
        () =>
          fixture.workerQuery<{ status: string }>(
            'select status from app.workflow_runs where id=$1',
            [maximumRun.run.id],
          ),
        (rows) =>
          ['succeeded', 'failed', 'outcome_unknown'].includes(
            rows[0]?.status ?? '',
          ),
        30_000,
      );
      expect(maximumTerminal).toEqual([{ status: 'succeeded' }]);
      const maximumOutput = await fixture.workerQuery<{
        output_ref: {
          value: {
            batches: number[][];
            inputCount: number;
            batchCount: number;
          };
        };
      }>(
        'select output_ref from app.node_runs where workflow_run_id=$1 and node_id=$2',
        [maximumRun.run.id, 'batch'],
      );
      expect(maximumOutput[0]?.output_ref.value).toEqual({
        batches: Array.from({ length: 4998 }, (_, i) => [i]),
        inputCount: 4998,
        batchCount: 4998,
      });
      expect(
        await fixture.workerQuery<{ count: number }>(
          'select count(*)::int count from app.node_attempts attempt join app.node_runs node on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id where node.workflow_run_id=$1',
          [maximumRun.run.id],
        ),
      ).toEqual([{ count: 5 }]);
    } catch (error) {
      errors.push(error);
    } finally {
      for (const close of owners.reverse())
        await close().catch((error: unknown) => errors.push(error));
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(
        errors,
        'Transform qualification and cleanup failed',
      );
  });
}
