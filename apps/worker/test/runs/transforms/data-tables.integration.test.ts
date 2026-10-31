import { node, literal } from '../../support/coordinator/workflows/graph.js';
import { createHash, randomUUID } from 'node:crypto';
import { createWorkflowRunDatabase } from '@pertexo/database/runs';
import {
  createDataTablesStore,
  createWorkerDataTablesStore,
} from '@pertexo/database/data-tables';
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
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createCoordinatorRuntime } from '../../../src/runs/runtime.js';
import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import { OutboxDispatcher } from '../../../src/transport/outbox/dispatch/runtime.js';
import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';
import { insertCompiledWorkflow } from '../../support/coordinator/workflows.js';
import { testNodeAttemptRuntime } from '../../support/runtime-factories.js';

const qualified = fixture.enabled ? describe : describe.skip;
qualified('workspace table steps through the real worker', () => {
  beforeAll(fixture.setup, 60_000);
  afterAll(fixture.restoreServicesAndClose);
  it('retries a lost insert acknowledgement once, reuses its receipt and executes all five operations', async () => {
    const config = (url: string, max: number) =>
      parseDatabaseConfig({ connectionString: fixture.databaseUrl(url), max });
    const tables = createDataTablesStore(config(fixture.apiUrl, 4));
    const worker = createWorkerDataTablesStore(config(fixture.workerUrl, 4));
    const runs = createWorkflowRunDatabase(config(fixture.apiUrl, 4));
    const owners: (() => Promise<void>)[] = [
      () => tables.close(),
      () => worker.close(),
      () => runs.close(),
    ];
    const errors: unknown[] = [];
    try {
      await tables.create({
        workspaceId: fixture.workspaceId,
        actorId: fixture.actorId,
        idempotencyKey: randomUUID(),
        name: 'Orders',
        columns: [
          { name: 'key', type: 'text', required: true },
          { name: 'amount', type: 'number', required: true },
        ],
        keyColumn: 'key',
      });
      const query = {
        filters: [{ column: 'key', operator: 'equals', value: 'a' }],
        limit: 100,
        offset: 0,
      };
      const steps = [
        node('start', 'core.manual'),
        node(
          'insert',
          'core.table_insert',
          { values: literal({ key: 'a', amount: 1 }) },
          { table: 'Orders' },
        ),
        node(
          'update',
          'core.table_update',
          { values: literal({ amount: 2 }), query: literal(query) },
          { table: 'Orders' },
        ),
        node(
          'upsert',
          'core.table_upsert',
          { values: literal({ key: 'a', amount: 3 }) },
          { table: 'Orders' },
        ),
        node(
          'find',
          'core.table_find',
          { query: literal(query) },
          { table: 'Orders' },
        ),
        node(
          'delete',
          'core.table_delete',
          { query: literal(query) },
          { table: 'Orders' },
        ),
        node('stop', 'core.terminate', {
          result: { kind: 'node_output', nodeId: 'delete', path: '$.affected' },
        }),
      ];
      const graph: WorkflowGraph = {
        settings: { maxRunDurationMs: 120_000 },
        nodes: steps,
        edges: steps.flatMap((step, index) => {
          const next = steps[index + 1];
          return next === undefined
            ? []
            : [
                {
                  id: `link-${String(index)}`,
                  source: { nodeId: step.id, port: 'out' },
                  target: { nodeId: next.id, port: 'in' },
                },
              ];
        }),
      };
      expect(validateWorkflowGraph(graph).issues).toEqual([]);
      const workflowId = randomUUID(),
        workflowVersionId = randomUUID();
      await insertCompiledWorkflow(fixture.ownerQuery, {
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        identity: { workflowId, workflowVersionId },
        graph,
        name: 'Table receipt proof',
        catalog: PLATFORM_NODE_CATALOG,
      });
      await fixture.ownerQuery(
        'update app.workflows set published_version_id=$2 where id=$1',
        [workflowId, workflowVersionId],
      );
      const coordinator = await createCoordinatorRuntime({
        maintenanceDatabase: config(fixture.dispatcherUrl, 2),
        database: config(fixture.workerUrl, 6),
        maximumAdmissions: 10,
        redisUrl: fixture.redisUrl,
      });
      owners.push(() => coordinator.close());
      let lost = false;
      let firstReceipt: unknown;
      const attempts = await testNodeAttemptRuntime(
        {
          database: config(fixture.workerUrl, 6),
          heartbeatIntervalMillis: 1000,
          leaseDurationSeconds: 30,
          redisUrl: fixture.redisUrl,
          workerId: `tables-${randomUUID()}`,
        },
        {
          registry: createPlatformNodeRegistry(),
          runtimeCapabilities: {
            dataTables: (context) => ({
              execute: async ({ command, signal }) => {
                const result = await worker.execute({
                  ...context,
                  command,
                  signal,
                });
                if (command.operation === 'insert' && !lost) {
                  lost = true;
                  firstReceipt = result;
                  throw new NodeExecutorFailure({
                    kind: 'retry',
                    errorKind: 'network',
                    possiblyDispatched: true,
                  });
                }
                if (command.operation === 'insert')
                  expect(result).toEqual(firstReceipt);
                return result;
              },
            }),
          },
        },
      );
      owners.push(() => attempts.close());
      const store = createOutboxDispatcherDatabase(
        config(fixture.dispatcherUrl, 2),
      );
      const producer = createQueueProducer({ redisUrl: fixture.redisUrl });
      const dispatcher = new OutboxDispatcher(store, producer, {
        drainState: new WorkerDrainState(),
        options: {
          batchSize: 10,
          jobNames: [JOB_NAME.advanceWorkflowRun, JOB_NAME.executeNodeAttempt],
          leaseDurationMillis: 30_000,
          leaseOwner: `tables-${randomUUID()}`,
          retryDelayMillis: 250,
          pollIntervalMillis: 100,
        },
      });
      owners.push(() => dispatcher.close());
      await Promise.all([
        coordinator.consumer.waitUntilReady(5000),
        attempts.consumer.waitUntilReady(5000),
        producer.waitUntilReady(5000),
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
        60_000,
      );
      const diagnostics = await fixture.workerQuery(
        'select node_id,status,safe_error_code from app.node_runs where workflow_run_id=$1',
        [accepted.run.id],
      );
      expect(terminal, JSON.stringify(diagnostics)).toEqual([
        { status: 'succeeded', error_summary: null },
      ]);
      expect(lost).toBe(true);
      const receipts = await fixture.workerQuery<{ count: number }>(
        'select count(*)::int count from app.data_table_write_receipts where workspace_id=$1 and run_id=$2',
        [fixture.workspaceId, accepted.run.id],
      );
      expect(receipts[0]?.count).toBe(4);
      const nodes = await fixture.workerQuery<{
        node_id: string;
        output_ref: unknown;
      }>(
        'select node_id,output_ref from app.node_runs where workflow_run_id=$1',
        [accepted.run.id],
      );
      expect(
        nodes.find((row) => row.node_id === 'find')?.output_ref,
      ).toMatchObject({
        kind: 'inline',
        value: {
          rows: [{ values: { key: 'a', amount: 3 }, revision: 3 }],
          affected: 1,
        },
      });
      const count = await fixture.workerQuery<{ count: number }>(
        'select count(*)::int count from app.workspace_data_table_rows where workspace_id=$1',
        [fixture.workspaceId],
      );
      expect(count[0]?.count).toBe(0);
      const tries = await fixture.workerQuery<{ count: number }>(
        "select count(*)::int count from app.node_attempts attempt join app.node_runs node on node.id=attempt.node_run_id where node.workflow_run_id=$1 and node.node_id='insert'",
        [accepted.run.id],
      );
      expect(tries[0]?.count).toBe(2);
    } catch (error) {
      errors.push(error);
    } finally {
      for (const close of owners.reverse())
        try {
          await close();
        } catch (error) {
          errors.push(error);
        }
    }
    if (errors.length > 0)
      throw new AggregateError(errors, 'Table qualification failed');
  }, 90_000);
});
