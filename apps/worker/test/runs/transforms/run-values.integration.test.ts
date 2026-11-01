import { node, literal } from '../../support/coordinator/workflows/graph.js';
import { createHash, randomUUID } from 'node:crypto';
import { createWorkflowRunDatabase } from '@pertexo/core/runs';
import { createOutboxDispatcherDatabase } from '@pertexo/core/testing';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { initialCheckpointFactory } from '@pertexo/core/execution';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';
import {
  validateWorkflowGraph,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createCoordinatorRuntime } from '../../../src/runs/runtime.js';
import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import { OutboxDispatcher } from '../../../src/transport/outbox/dispatch/runtime.js';
import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';
import { insertCompiledWorkflow } from '../../support/coordinator/workflows.js';
import { testNodeAttemptRuntime } from '../../support/runtime-factories.js';

const qualified = fixture.enabled ? describe : describe.skip;
qualified('business values through the real worker', () => {
  beforeAll(fixture.setup, 60_000);
  afterAll(fixture.restoreServicesAndClose);
  it('saves mapped run input, replaces keys and exposes values through the normal run read and exact list', async () => {
    const config = (url: string, max: number) =>
      parseDatabaseConfig({ connectionString: fixture.databaseUrl(url), max });
    const runs = createWorkflowRunDatabase(config(fixture.apiUrl, 4));
    const owners: (() => Promise<void>)[] = [() => runs.close()];
    const errors: unknown[] = [];
    try {
      const steps = [
        node('start', 'core.manual'),
        node('save', 'core.run_values', {
          values: { kind: 'run_input', path: '$.business' },
        }),
        node('replace', 'core.run_values', {
          values: literal({ orderId: 'A-1043', accessToken: 'opaque-secret' }),
        }),
        node('stop', 'core.terminate', {
          result: {
            kind: 'node_output',
            nodeId: 'replace',
            path: '$.values.orderId',
          },
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
        name: 'Business values proof',
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
      const attempts = await testNodeAttemptRuntime(
        {
          database: config(fixture.workerUrl, 6),
          heartbeatIntervalMillis: 1000,
          leaseDurationSeconds: 30,
          redisUrl: fixture.redisUrl,
          workerId: `values-${randomUUID()}`,
        },
        { registry: createPlatformNodeRegistry() },
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
          leaseOwner: `values-${randomUUID()}`,
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
        input: { business: { orderId: 'A-1042', customerId: 'C-9' } },
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
      const visible = await runs.get({
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        runId: accepted.run.id,
      });
      expect(visible?.run.runValues).toEqual({
        orderId: 'A-1043',
        customerId: 'C-9',
        accessToken: '[Redacted]',
      });
      const filtered = await runs.list({
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        limit: 20,
        runValueKey: 'orderId',
        runValue: 'A-1043',
      });
      expect(filtered.items.map((run) => run.id)).toContain(accepted.run.id);
      const prior = await runs.list({
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        limit: 20,
        runValueKey: 'orderId',
        runValue: 'A-1042',
      });
      expect(prior.items.map((run) => run.id)).not.toContain(accepted.run.id);
      const output = await fixture.workerQuery<{ output_ref: unknown }>(
        "select output_ref from app.node_runs where workflow_run_id=$1 and node_id='replace'",
        [accepted.run.id],
      );
      expect(JSON.stringify(output)).not.toContain('opaque-secret');
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
      throw new AggregateError(errors, 'Run values qualification failed');
  }, 90_000);
});
