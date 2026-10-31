import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initialCheckpointFactory } from '@pertexo/execution';
import { createWorkflowRunDatabase } from '@pertexo/database/runs';
import {
  createOutboxDispatcherDatabase,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';
import {
  workflowErrorInputSchema,
  type WorkflowGraph,
  type WorkflowNode,
} from '@pertexo/workflow-model';
import { createCoordinatorRuntime } from '../../../dist/runs/runtime.js';
import { createMaintenanceRuntime } from '../../../dist/maintenance/runtime.js';
import { WorkerDrainState } from '../../../dist/runtime/shutdown/drain-state.js';
import { OutboxDispatcher } from '../../../dist/transport/outbox/dispatch/runtime.js';
import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';
import { insertCompiledWorkflow } from '../../support/coordinator/workflows.js';
import { testNodeAttemptRuntime } from '../../support/runtime-factories.js';

function graph(errorTrigger: boolean): WorkflowGraph {
  const node = (id: string, key: string): WorkflowNode => ({
    id,
    definition: { key, version: 1 },
    config: {},
    configVersion: 1,
    position: { x: 0, y: 0 },
    inputMappings: {},
    connectionRefs: {},
  });
  const entry = errorTrigger ? 'error' : 'manual';
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      node(entry, errorTrigger ? 'core.workflow_error' : 'core.manual'),
      {
        ...node(errorTrigger ? 'summary' : 'source', 'core.set'),
        label: errorTrigger ? 'Capture the summary' : 'Fetch invoices',
        inputMappings: errorTrigger
          ? { failure: { kind: 'node_output', nodeId: entry, path: '$' } }
          : {},
      },
      node('stop', 'core.terminate'),
    ],
    edges: [
      {
        id: 'entry-action',
        source: { nodeId: entry, port: 'out' },
        target: { nodeId: errorTrigger ? 'summary' : 'source', port: 'in' },
      },
      {
        id: 'action-stop',
        source: { nodeId: errorTrigger ? 'summary' : 'source', port: 'out' },
        target: { nodeId: 'stop', port: 'in' },
      },
    ],
  };
}

describe.runIf(fixture.enabled)(
  'error workflows through PostgreSQL, outbox, BullMQ and real workers',
  () => {
    beforeAll(fixture.setup, 60_000);
    afterAll(fixture.restoreServicesAndClose);
    it('runs the captured error trigger once with safe data and suppresses a failing error workflow', async () => {
      const sourceWorkflowId = randomUUID(),
        sourceVersionId = randomUUID(),
        targetWorkflowId = randomUUID(),
        targetVersionId = randomUUID(),
        fallbackWorkflowId = randomUUID(),
        fallbackVersionId = randomUUID();
      for (const [workflowId, workflowVersionId, errorTrigger] of [
        [sourceWorkflowId, sourceVersionId, false],
        [targetWorkflowId, targetVersionId, true],
        [fallbackWorkflowId, fallbackVersionId, true],
      ] as const) {
        await insertCompiledWorkflow(fixture.ownerQuery, {
          actorId: fixture.actorId,
          workspaceId: fixture.workspaceId,
          identity: { workflowId, workflowVersionId },
          graph: graph(errorTrigger),
          name: errorTrigger ? 'Failure summary handler' : 'Original workflow',
          catalog: PLATFORM_NODE_CATALOG,
        });
        await fixture.ownerQuery(
          'update app.workflows set published_version_id=$2 where id=$1',
          [workflowId, workflowVersionId],
        );
      }
      for (const [source, target] of [
        [sourceWorkflowId, targetWorkflowId],
        [targetWorkflowId, fallbackWorkflowId],
      ])
        await fixture.ownerQuery(
          'insert into app.workflow_error_policies(workspace_id,workflow_id,target_workflow_id) values($1,$2,$3)',
          [fixture.workspaceId, source, target],
        );
      const config = (url: string, max: number) =>
        parseDatabaseConfig({
          connectionString: fixture.databaseUrl(url),
          max,
        });
      const runs = createWorkflowRunDatabase(config(fixture.apiUrl, 4));
      const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
      const registry = createPlatformNodeRegistry();
      const owners: (() => Promise<void>)[] = [() => runs.close()];
      const executed: { runId: string; nodeId: string; input: unknown }[] = [];
      let failHandler = false;
      let primary: unknown;
      const cleanupFailures: unknown[] = [];
      try {
        const coordinator = await createCoordinatorRuntime({
          database: config(fixture.workerUrl, 6),
          maintenanceDatabase: config(fixture.dispatcherUrl, 2),
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
            workerId: `error-workflow-${randomUUID()}`,
          },
          {
            registry: {
              dispatchMode: registry.dispatchMode,
              execute: async (request) => {
                const runtime = request.runtime;
                if (runtime === undefined)
                  throw new Error('Real run scope missing');
                executed.push({
                  runId: runtime.runId,
                  nodeId: runtime.nodeId,
                  input: request.input,
                });
                if (
                  runtime.nodeId === 'source' ||
                  (runtime.nodeId === 'summary' && failHandler)
                ) {
                  const failure = new NodeExecutorFailure({
                    kind: 'failed',
                    errorKind: 'authentication',
                    possiblyDispatched: false,
                  });
                  failure.message = 'provider body contains sensitive-password';
                  throw failure;
                }
                return registry.execute(request);
              },
            },
          },
        );
        owners.push(() => attempts.close());
        let maintenance = await createMaintenanceRuntime({
          database: config(fixture.workerUrl, 6),
          redisUrl: fixture.redisUrl,
        });
        owners.push(() => maintenance.close());
        const outbox = createOutboxDispatcherDatabase(
          config(fixture.dispatcherUrl, 2),
        );
        owners.push(() => outbox.close());
        const producer = createQueueProducer({ redisUrl: fixture.redisUrl });
        owners.push(() => producer.close());
        const dispatcher = new OutboxDispatcher(outbox, producer, {
          drainState: new WorkerDrainState(),
          options: {
            batchSize: 10,
            jobNames: [
              JOB_NAME.advanceWorkflowRun,
              JOB_NAME.executeNodeAttempt,
              JOB_NAME.startErrorWorkflow,
            ],
            leaseDurationMillis: 30_000,
            leaseOwner: `error-workflows-${randomUUID()}`,
            retryDelayMillis: 1_000,
            pollIntervalMillis: 250,
          },
        });
        owners.splice(-2, 2, () => dispatcher.close());
        await Promise.all([
          coordinator.consumer.waitUntilReady(5_000),
          attempts.consumer.waitUntilReady(5_000),
          maintenance.consumer.waitUntilReady(5_000),
          producer.waitUntilReady(5_000),
        ]);
        dispatcher.start();
        const start = async () => {
          const key = createHash('sha256').update(randomUUID()).digest('hex');
          return runs.start({
            actorId: fixture.actorId,
            workspaceId: fixture.workspaceId,
            workflowId: sourceWorkflowId,
            idempotencyKeyHash: key,
            requestHash: key,
            scope: `workflow:${sourceWorkflowId}:manual`,
            input: {
              password: 'sensitive-password',
              customer: { private: true },
            },
            checkpointFactory: initialCheckpointFactory({ catalog }),
          });
        };
        const wait = async (runId: string, status: string) =>
          fixture.waitFor(
            () =>
              fixture.workerQuery<{ status: string }>(
                'select status from app.workflow_runs where id=$1',
                [runId],
              ),
            (rows) => rows[0]?.status === status,
            30_000,
          );
        const first = await start();
        await wait(first.run.id, 'failed');
        const accepted = await fixture.waitFor(
          () =>
            fixture.workerQuery<{
              accepted_run_id: string | null;
              status: string;
            }>(
              'select status,accepted_run_id from app.run_error_workflow_intents where source_run_id=$1',
              [first.run.id],
            ),
          (rows) => rows[0]?.status === 'accepted',
          30_000,
        );
        const errorRunId = accepted[0]?.accepted_run_id;
        if (errorRunId == null) throw new Error('Error run missing');
        await wait(errorRunId, 'succeeded');
        const summary = workflowErrorInputSchema.parse(
          executed.find(
            (step) => step.runId === errorRunId && step.nodeId === 'error',
          )?.input,
        );
        expect(summary).toMatchObject({
          workflow: { id: sourceWorkflowId, versionId: sourceVersionId },
          run: { id: first.run.id, status: 'failed' },
          failedStep: {
            id: 'source',
            name: 'Fetch invoices',
            nodeType: 'core.set',
            errorKind: 'authentication',
            safeErrorCode: 'execution.authentication',
          },
          error: { code: 'execution.failed', message: 'The workflow failed.' },
        });
        expect(
          executed.find(
            (step) => step.runId === errorRunId && step.nodeId === 'summary',
          )?.input,
        ).toEqual({ failure: summary });
        expect(JSON.stringify(summary)).not.toMatch(
          /sensitive-password|customer|private/u,
        );
        expect(
          (
            await runs.get({
              actorId: fixture.actorId,
              workspaceId: fixture.workspaceId,
              runId: first.run.id,
            })
          )?.errorWorkflow,
        ).toMatchObject({ status: 'accepted', acceptedRunId: errorRunId });
        await maintenance.close();
        failHandler = true;
        const second = await start();
        await wait(second.run.id, 'failed');
        await fixture.waitFor(
          () =>
            fixture.workerQuery<{ status: string }>(
              'select status from app.run_error_workflow_intents where source_run_id=$1',
              [second.run.id],
            ),
          (rows) => rows[0]?.status === 'pending',
          30_000,
        );
        maintenance = await createMaintenanceRuntime({
          database: config(fixture.workerUrl, 6),
          redisUrl: fixture.redisUrl,
        });
        await maintenance.consumer.waitUntilReady(5_000);
        const next = await fixture.waitFor(
          () =>
            fixture.workerQuery<{
              accepted_run_id: string | null;
              status: string;
            }>(
              'select status,accepted_run_id from app.run_error_workflow_intents where source_run_id=$1',
              [second.run.id],
            ),
          (rows) => rows[0]?.status === 'accepted',
          30_000,
        );
        const nextError = next[0]?.accepted_run_id;
        if (nextError == null) throw new Error('Second error run missing');
        await wait(nextError, 'failed');
        expect(
          await fixture.workerQuery(
            'select source_run_id from app.run_error_workflow_intents where source_run_id=$1',
            [nextError],
          ),
        ).toHaveLength(0);
        expect(
          await fixture.workerQuery(
            'select id from app.workflow_runs where workflow_id=$1',
            [fallbackWorkflowId],
          ),
        ).toHaveLength(0);
        expect(
          await fixture.workerQuery(
            "select message_id from app.inbox_receipts where consumer_name='error-workflow'",
          ),
        ).toHaveLength(2);
      } catch (error) {
        primary = error;
      } finally {
        for (const close of owners.toReversed()) {
          try {
            await close();
          } catch (error) {
            cleanupFailures.push(error);
          }
        }
      }
      if (primary !== undefined || cleanupFailures.length > 0)
        throw new AggregateError(
          [...(primary === undefined ? [] : [primary]), ...cleanupFailures],
          'Error workflow qualification failed',
        );
    }, 60_000);
  },
);
