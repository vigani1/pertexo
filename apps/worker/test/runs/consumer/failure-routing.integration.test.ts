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
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  parseCheckpoint,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine';
import type { WorkflowGraph, WorkflowNode } from '@pertexo/workflow-model';
import { createCoordinatorRuntime } from '../../../dist/runs/runtime.js';
import { createNodeAttemptRuntime } from '../../../dist/attempts/delivery/runtime.js';
import { WorkerDrainState } from '../../../dist/runtime/shutdown/drain-state.js';
import { OutboxDispatcher } from '../../../dist/transport/outbox/dispatcher.js';
import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';
import { insertCompiledWorkflow } from '../../support/coordinator/workflows.js';

function graph(): WorkflowGraph {
  const node = (id: string, key: string): WorkflowNode => ({
    id,
    definition: { key, version: 1 },
    config: {},
    configVersion: 1,
    position: { x: 0, y: 0 },
    inputMappings: {},
    connectionRefs: {},
  });
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      node('manual', 'core.manual'),
      {
        ...node('choice', 'core.condition'),
        inputMappings: { condition: { kind: 'literal', value: true } },
      },
      node('source', 'core.set'),
      node('normal-stop', 'core.terminate'),
      node('off-path', 'core.terminate'),
      {
        ...node('handler', 'core.set'),
        inputMappings: {
          failure: { kind: 'node_failure', nodeId: 'source', path: '$' },
        },
      },
      {
        ...node('handler-stop', 'core.terminate'),
        inputMappings: {
          result: { kind: 'node_output', nodeId: 'handler', path: '$' },
        },
      },
    ],
    edges: (
      [
        ['manual', 'choice', 'out'],
        ['choice', 'source', 'true'],
        ['choice', 'off-path', 'false'],
        ['source', 'normal-stop', 'out'],
        ['source', 'handler', '__failure'],
        ['handler', 'handler-stop', 'out'],
      ] as const
    ).map(([source, target, port], i) => ({
      id: `link-${String(i)}`,
      source: { nodeId: source, port: port },
      target: { nodeId: target, port: 'in' },
    })),
  };
}
function assertCleanup(errors: readonly unknown[], primary: unknown): void {
  if (errors.length > 0)
    throw new AggregateError(
      primary === undefined ? errors : [primary, ...errors],
      'Failure handling qualification cleanup failed',
    );
}
const qualified = fixture.enabled ? describe : describe.skip;
qualified(
  'failure handlers through durable outbox and compiled workers',
  () => {
    beforeAll(fixture.setup, 60_000);
    afterAll(fixture.restoreServicesAndClose);
    it('retains source failure truth, resumes its selected handler after coordinator restart, and preserves terminal precedence', async () => {
      const workflowId = randomUUID(),
        workflowVersionId = randomUUID();
      await insertCompiledWorkflow(fixture.ownerQuery, {
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        identity: { workflowId, workflowVersionId },
        graph: graph(),
        name: 'Failure handling proof',
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
      const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
      const registry = createPlatformNodeRegistry();
      const coordinatorConfig = {
        maintenanceDatabase: config(fixture.dispatcherUrl, 2),
        database: config(fixture.workerUrl, 6),
        maximumAdmissions: 10,
        redisUrl: fixture.redisUrl,
      };
      let mode:
        'handled' | 'handler-failed' | 'handler-retry' | 'unknown' | 'normal' =
        'handled';
      let handlerRetried = false;
      let releaseHandler!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      const executed: { runId: string; nodeId: string; input: unknown }[] = [];
      const owners: (() => Promise<void>)[] = [() => runs.close()];
      let primary: unknown;
      try {
        let coordinator = await createCoordinatorRuntime(coordinatorConfig);
        owners.push(() => coordinator.close());
        const attempts = await createNodeAttemptRuntime(
          {
            database: config(fixture.workerUrl, 6),
            heartbeatIntervalMillis: 1_000,
            leaseDurationSeconds: 10,
            redisUrl: fixture.redisUrl,
            workerId: `routing-${randomUUID()}`,
          },
          {
            registry: {
              dispatchMode: registry.dispatchMode,
              execute: async (request) => {
                const runtime = request.runtime;
                if (runtime === undefined)
                  throw new Error('Missing real execution scope');
                executed.push({
                  runId: runtime.runId,
                  nodeId: runtime.nodeId,
                  input: request.input,
                });
                if (runtime.nodeId === 'source' && mode !== 'normal')
                  throw new NodeExecutorFailure({
                    kind: mode === 'unknown' ? 'outcome_unknown' : 'failed',
                    errorKind: 'authentication',
                    possiblyDispatched: false,
                  });
                if (runtime.nodeId === 'handler') {
                  if (mode === 'handler-retry' && !handlerRetried) {
                    handlerRetried = true;
                    throw new NodeExecutorFailure({
                      kind: 'retry',
                      errorKind: 'network',
                      possiblyDispatched: false,
                    });
                  }
                  if (mode === 'handler-failed')
                    throw new NodeExecutorFailure({
                      kind: 'failed',
                      errorKind: 'provider',
                      possiblyDispatched: false,
                    });
                  await gate;
                }
                return registry.execute(request);
              },
            },
          },
        );
        owners.push(() => attempts.close());
        const store = createOutboxDispatcherDatabase(
          config(fixture.dispatcherUrl, 2),
        );
        owners.push(() => store.close());
        const producer = createQueueProducer({ redisUrl: fixture.redisUrl });
        owners.push(() => producer.close());
        const dispatcher = new OutboxDispatcher(
          store,
          producer,
          new WorkerDrainState(),
          {
            batchSize: 10,
            jobNames: [
              JOB_NAME.advanceWorkflowRun,
              JOB_NAME.executeNodeAttempt,
            ],
            leaseDurationMillis: 30_000,
            leaseOwner: `routing-${randomUUID()}`,
            maxAttempts: 3,
            retryDelayMillis: 1_000,
            pollIntervalMillis: 250,
          },
        );
        owners.splice(-2, 2, () => dispatcher.close());

        await Promise.all([
          coordinator.consumer.waitUntilReady(5_000),
          attempts.consumer.waitUntilReady(5_000),
          producer.waitUntilReady(5_000),
        ]);
        dispatcher.start();
        const start = async () => {
          const key = createHash('sha256').update(randomUUID()).digest('hex');
          return runs.start({
            actorId: fixture.actorId,
            workspaceId: fixture.workspaceId,
            workflowId,
            idempotencyKeyHash: key,
            requestHash: key,
            scope: `workflow:${workflowId}:manual`,
            input: {},
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
        await fixture.waitFor(
          () =>
            Promise.resolve(
              executed.some(
                (n) => n.runId === first.run.id && n.nodeId === 'handler',
              ),
            ),
          (entered) => entered,
        );
        const pending = await runs.get({
          actorId: fixture.actorId,
          workspaceId: fixture.workspaceId,
          runId: first.run.id,
        });
        const source = pending?.nodes.find((n) => n.nodeId === 'source');
        expect(source).toMatchObject({
          status: 'failed',
          currentAttemptNumber: 1,
          failureHandling: { disposition: 'pending' },
        });
        expect(pending?.run.status).toBe('running');
        const evidence = (
          await fixture.workerQuery<{ failure_ref: unknown }>(
            'select failure_ref from app.node_runs where workflow_run_id=$1 and node_id=$2',
            [first.run.id, 'source'],
          )
        )[0]?.failure_ref;
        expect(evidence).toEqual({
          kind: 'inline',
          value: {
            nodeId: 'source',
            invocationKey: source?.invocationKey,
            attemptNumber: 1,
            errorKind: 'authentication',
            safeErrorCode: 'execution.authentication',
          },
        });
        expect(
          executed.find(
            (n) => n.runId === first.run.id && n.nodeId === 'handler',
          )?.input,
        ).toEqual({ failure: (evidence as { value: unknown }).value });
        const checkpointRow = (
          await fixture.workerQuery<{ scheduler_state: unknown }>(
            'select scheduler_state from app.run_checkpoints where workflow_run_id=$1',
            [first.run.id],
          )
        )[0];
        const restored = parseCheckpoint(checkpointRow?.scheduler_state);
        const corrupted = {
          ...restored,
          branchSelections: restored.branchSelections.map((selection) => ({
            ...selection,
            selectedOutputPort: 'false',
          })),
        };
        await expect(
          advanceWorkflow({
            runId: first.run.id,
            workflowVersionId,
            executable: buildWorkflowExecutable({ graph: graph(), catalog }),
            checkpoint: corrupted,
            occurredAt: new Date().toISOString(),
            maximumAdmissions: 10,
            signal: new AbortController().signal,
          }),
        ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });
        await coordinator.close();
        coordinator = await createCoordinatorRuntime(coordinatorConfig);
        await coordinator.consumer.waitUntilReady(5_000);
        releaseHandler();
        await wait(first.run.id, 'succeeded');
        const finished = await runs.get({
          actorId: fixture.actorId,
          workspaceId: fixture.workspaceId,
          runId: first.run.id,
        });
        expect(finished?.run.handledFailureCount).toBe(1);
        expect(
          finished?.nodes.find((n) => n.nodeId === 'source'),
        ).toMatchObject({
          status: 'failed',
          failureHandling: { disposition: 'handled' },
        });
        expect(
          finished?.nodes.find((n) => n.nodeId === 'normal-stop')?.status,
        ).toBe('skipped');
        expect(
          finished?.nodes.find((n) => n.nodeId === 'off-path')?.status,
        ).toBe('skipped');
        expect(
          finished?.nodes.find((n) => n.nodeId === 'handler')?.invocationKey,
        ).toContain('choice');
        expect(
          executed.filter((n) => n.runId === first.run.id).map((n) => n.nodeId),
        ).toEqual(['manual', 'choice', 'source', 'handler', 'handler-stop']);
        const events = await fixture.workerQuery<{ type: string }>(
          'select type from app.run_events where workflow_run_id=$1 order by sequence',
          [first.run.id],
        );
        expect(
          events.filter((e) => e.type === 'node.failure_routed'),
        ).toHaveLength(1);
        expect(
          events.filter((e) => e.type === 'node.failure_handled'),
        ).toHaveLength(1);
        const health = await runs.stepHealth({
          actorId: fixture.actorId,
          workspaceId: fixture.workspaceId,
          workflowId,
        });
        expect(
          health?.items.find((step) => step.nodeId === 'source'),
        ).toMatchObject({ runs: 1, failed: 1, lastStatus: 'failed' });
        const summaries = await runs.list({
          actorId: fixture.actorId,
          workspaceId: fixture.workspaceId,
          workflowId,
          limit: 10,
        });
        expect(
          summaries.items.find((r) => r.id === first.run.id)
            ?.handledFailureCount,
        ).toBe(1);
        for (const [next, status] of [
          ['handler-failed', 'failed'],
          ['unknown', 'outcome_unknown'],
          ['normal', 'succeeded'],
        ] as const) {
          mode = next;
          const accepted = await start();
          await wait(accepted.run.id, status);
          const result = await runs.get({
            actorId: fixture.actorId,
            workspaceId: fixture.workspaceId,
            runId: accepted.run.id,
          });
          expect(result?.run.handledFailureCount).toBeUndefined();
          if (next === 'handler-failed')
            expect(
              result?.nodes.find((n) => n.nodeId === 'source')?.failureHandling
                ?.disposition,
            ).toBe('pending');
          else
            expect(
              executed.filter(
                (n) =>
                  n.runId === accepted.run.id && n.nodeId.startsWith('handler'),
              ),
            ).toEqual([]);
        }
        mode = 'handler-retry';
        const retried = await start();
        await wait(retried.run.id, 'succeeded');
        const retryHistory = await runs.get({
          actorId: fixture.actorId,
          workspaceId: fixture.workspaceId,
          runId: retried.run.id,
        });
        expect(
          retryHistory?.nodes.find((n) => n.nodeId === 'handler')
            ?.currentAttemptNumber,
        ).toBe(2);
        expect(retryHistory?.run.handledFailureCount).toBe(1);
        const handlerInputs = executed
          .filter((n) => n.runId === retried.run.id && n.nodeId === 'handler')
          .map((n) => n.input);
        expect(handlerInputs).toHaveLength(2);
        expect(handlerInputs[1]).toEqual(handlerInputs[0]);
        // Actual data executors must use the same durable route owner as providers.
        mode = 'normal';
        const dataFailures: readonly Readonly<{
          key: string;
          config: WorkflowNode['config'];
          input: WorkflowNode['config'];
          code: string;
        }>[] = [
          {
            key: 'core.xml',
            config: { operation: 'parse' },
            input: { value: '<root><broken></root>' },
            code: 'utility.xml_malformed',
          },
          {
            key: 'core.create_file',
            config: { format: 'csv', delimiter: ',', columns: [] },
            input: { data: [1] },
            code: 'file.create_data',
          },
        ];
        for (const example of dataFailures) {
          const dataWorkflowId = randomUUID(),
            dataVersionId = randomUUID();
          const dataGraph: WorkflowGraph = {
            ...graph(),
            nodes: graph().nodes.map((node) =>
              node.id !== 'source'
                ? node
                : {
                    ...node,
                    definition: { key: example.key, version: 1 },
                    config: example.config,
                    inputMappings: Object.fromEntries(
                      Object.entries(example.input).map(([name, value]) => [
                        name,
                        { kind: 'literal' as const, value },
                      ]),
                    ),
                  },
            ),
          };
          await insertCompiledWorkflow(fixture.ownerQuery, {
            actorId: fixture.actorId,
            workspaceId: fixture.workspaceId,
            identity: {
              workflowId: dataWorkflowId,
              workflowVersionId: dataVersionId,
            },
            graph: dataGraph,
            name: `Handled ${example.key} input failure`,
            catalog: PLATFORM_NODE_CATALOG,
          });
          await fixture.ownerQuery(
            'update app.workflows set published_version_id=$2 where id=$1',
            [dataWorkflowId, dataVersionId],
          );
          const requestKey = createHash('sha256')
            .update(randomUUID())
            .digest('hex');
          const started = await runs.start({
            actorId: fixture.actorId,
            workspaceId: fixture.workspaceId,
            workflowId: dataWorkflowId,
            idempotencyKeyHash: requestKey,
            requestHash: requestKey,
            scope: `workflow:${dataWorkflowId}:manual`,
            input: {},
            checkpointFactory: initialCheckpointFactory({ catalog }),
          });
          await fixture.waitFor(
            () =>
              fixture.workerQuery<{ status: string }>(
                `select status, (select jsonb_agg(jsonb_build_object('node',node_id,'status',status,'code',safe_error_code)) from app.node_runs where workflow_run_id=$1) nodes from app.workflow_runs where id=$1`,
                [started.run.id],
              ),
            (rows) =>
              rows[0]?.status === 'succeeded' || rows[0]?.status === 'failed',
          );
          const handled = await runs.get({
            actorId: fixture.actorId,
            workspaceId: fixture.workspaceId,
            runId: started.run.id,
          });
          expect.soft(handled?.run.status, example.code).toBe('succeeded');
          expect.soft(handled?.run.handledFailureCount).toBe(1);
          expect
            .soft(handled?.nodes.find((node) => node.nodeId === 'source'))
            .toMatchObject({
              status: 'failed',
              failureHandling: { disposition: 'handled' },
              safeErrorCode: example.code,
            });
          expect
            .soft(
              handled?.nodes.find((node) => node.nodeId === 'normal-stop')
                ?.status,
            )
            .toBe('skipped');
          expect
            .soft(
              executed.find(
                (node) =>
                  node.runId === started.run.id && node.nodeId === 'handler',
              )?.input,
            )
            .toMatchObject({
              failure: {
                errorKind: 'configuration',
                safeErrorCode: example.code,
              },
            });
        }
        mode = 'handled';
        const callableGraph: WorkflowGraph = {
          ...graph(),
          callable: {
            input: { type: 'object', properties: [] },
            resultType: { type: 'object', properties: [] },
            result: { kind: 'node_output', nodeId: 'source', path: '$' },
          },
        };
        const callableWorkflowId = randomUUID(),
          callableVersionId = randomUUID();
        await insertCompiledWorkflow(fixture.ownerQuery, {
          actorId: fixture.actorId,
          workspaceId: fixture.workspaceId,
          identity: {
            workflowId: callableWorkflowId,
            workflowVersionId: callableVersionId,
          },
          graph: callableGraph,
          name: 'No invented callable result',
          catalog: PLATFORM_NODE_CATALOG,
        });
        await fixture.ownerQuery(
          'update app.workflows set published_version_id=$2 where id=$1',
          [callableWorkflowId, callableVersionId],
        );
        const callableKey = createHash('sha256')
          .update(randomUUID())
          .digest('hex');
        const callableRun = await runs.start({
          actorId: fixture.actorId,
          workspaceId: fixture.workspaceId,
          workflowId: callableWorkflowId,
          idempotencyKeyHash: callableKey,
          requestHash: callableKey,
          scope: `workflow:${callableWorkflowId}:manual`,
          input: {},
          checkpointFactory: initialCheckpointFactory({ catalog }),
        });
        await wait(callableRun.run.id, 'failed');
        expect(
          (
            await runs.get({
              actorId: fixture.actorId,
              workspaceId: fixture.workspaceId,
              runId: callableRun.run.id,
            })
          )?.run.handledFailureCount,
        ).toBe(1);
        const callableList = await runs.list({
          actorId: fixture.actorId,
          workspaceId: fixture.workspaceId,
          workflowId: callableWorkflowId,
          limit: 10,
        });
        expect(callableList.items[0]?.failedStep).toBeNull();
        const inbox = await fixture.ownerQuery<{ count: number }>(
          'select count(*)::int count from app.workspace_inbox_events where run_id=$1',
          [first.run.id],
        );
        expect(inbox[0]?.count).toBe(0);
        // Detail retirement removes source evidence; the run still explains its success.
        await fixture.ownerQuery(
          'delete from app.run_events where workflow_run_id=$1',
          [first.run.id],
        );
        await fixture.ownerQuery(
          'delete from app.node_runs where workflow_run_id=$1',
          [first.run.id],
        );
        expect(
          (
            await runs.get({
              actorId: fixture.actorId,
              workspaceId: fixture.workspaceId,
              runId: first.run.id,
            })
          )?.run.handledFailureCount,
        ).toBe(1);
      } catch (error) {
        primary = error;
        throw error;
      } finally {
        releaseHandler();
        const closed = await Promise.allSettled(
          owners.reverse().map((close) => close()),
        );
        const errors = closed.flatMap((r) =>
          r.status === 'rejected' ? [r.reason as unknown] : [],
        );
        assertCleanup(errors, primary);
      }
    }, 90_000);
  },
);
