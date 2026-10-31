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
import type { WorkflowGraph, WorkflowNode } from '@pertexo/workflow-model';
import { createCoordinatorRuntime } from '../../../dist/runs/runtime.js';
import { WorkerDrainState } from '../../../dist/runtime/shutdown/drain-state.js';
import { OutboxDispatcher } from '../../../dist/transport/outbox/dispatch/runtime.js';
import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';
import { insertCompiledWorkflow } from '../../support/coordinator/workflows.js';
import { runWithCleanup } from '../../support/infrastructure/test-operation.js';
import { testNodeAttemptRuntime } from '../../support/runtime-factories.js';

function graph(
  maximumAttempts: number,
  handled: boolean,
  delayMillis = 1_000,
): WorkflowGraph {
  const node = (id: string, key: string): WorkflowNode => ({
    id,
    definition: { key, version: 1 },
    configVersion: 1,
    position: { x: 0, y: 0 },
    config: {},
    inputMappings: {},
    connectionRefs: {},
  });
  const links: readonly (readonly [string, string, string])[] = [
    ['manual', 'action', 'out'],
    ['action', 'stop', 'out'],
    ...(handled
      ? ([
          ['action', 'handler', '__failure'],
          ['handler', 'handler-stop', 'out'],
        ] as const)
      : []),
  ];
  return {
    settings: { maxRunDurationMs: 600_000 },
    nodes: [
      node('manual', 'core.manual'),
      {
        ...node('action', 'core.set'),
        retry: { maximumAttempts, delayMillis },
      },
      node('stop', 'core.terminate'),
      ...(handled
        ? [node('handler', 'core.set'), node('handler-stop', 'core.terminate')]
        : []),
    ],
    edges: links.map(([from, to, port], i) => ({
      id: `link-${String(i)}`,
      source: { nodeId: from, port },
      target: { nodeId: to, port: 'in' },
    })),
  };
}

(fixture.enabled ? describe : describe.skip)(
  'published step retry settings through durable workers',
  () => {
    beforeAll(fixture.setup, 60_000);
    afterAll(fixture.restoreServicesAndClose);
    it('honours pinned retry budgets, terminal failures and controls through durable workers', async () => {
      const config = (url: string, max = 2) =>
        parseDatabaseConfig({
          connectionString: fixture.databaseUrl(url),
          max,
        });
      const runs = createWorkflowRunDatabase(config(fixture.apiUrl));
      const owners: (() => Promise<unknown>)[] = [() => runs.close()];
      const registry = createPlatformNodeRegistry();
      const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
      let mode: 'retry' | 'permanent' | 'unknown' = 'retry';
      let failures = 3;
      const calls = new Map<string, number>();
      await runWithCleanup(
        async () => {
          const coordinator = await createCoordinatorRuntime({
            database: config(fixture.workerUrl, 4),
            maintenanceDatabase: config(fixture.dispatcherUrl),
            maximumAdmissions: 10,
            redisUrl: fixture.redisUrl,
          });
          owners.push(() => coordinator.close());
          const attempts = await testNodeAttemptRuntime(
            {
              database: config(fixture.workerUrl, 4),
              heartbeatIntervalMillis: 1_000,
              leaseDurationSeconds: 10,
              redisUrl: fixture.redisUrl,
              workerId: `step-retries-${randomUUID()}`,
            },
            {
              registry: {
                dispatchMode: registry.dispatchMode,
                execute: async (request) => {
                  const runtime = request.runtime;
                  if (runtime?.nodeId === 'action') {
                    const count = (calls.get(runtime.runId) ?? 0) + 1;
                    calls.set(runtime.runId, count);
                    if (count <= failures)
                      throw new NodeExecutorFailure({
                        kind: failureKind(mode),
                        errorKind:
                          mode === 'permanent' ? 'authentication' : 'network',
                        possiblyDispatched: false,
                      });
                  }
                  return registry.execute(request);
                },
              },
            },
          );
          owners.push(() => attempts.close());
          const store = createOutboxDispatcherDatabase(
            config(fixture.dispatcherUrl),
          );
          owners.push(() => store.close());
          const producer = createQueueProducer({ redisUrl: fixture.redisUrl });
          owners.push(() => producer.close());
          const dispatcher = new OutboxDispatcher(store, producer, {
            drainState: new WorkerDrainState(),
            options: {
              batchSize: 10,
              jobNames: [
                JOB_NAME.advanceWorkflowRun,
                JOB_NAME.executeNodeAttempt,
              ],
              leaseDurationMillis: 30_000,
              leaseOwner: `retries-${randomUUID()}`,
              retryDelayMillis: 1_000,
              pollIntervalMillis: 50,
            },
          });
          owners.splice(-2, 2, () => dispatcher.close());
          await Promise.all([
            coordinator.consumer.waitUntilReady(5_000),
            attempts.consumer.waitUntilReady(5_000),
            producer.waitUntilReady(5_000),
          ]);
          dispatcher.start();
          for (const scenario of [
            {
              tries: 5,
              failures: 4,
              mode: 'retry',
              handled: false,
              status: 'succeeded',
              attempts: 5,
            },
            {
              tries: 1,
              failures: 1,
              mode: 'retry',
              handled: false,
              status: 'failed',
              attempts: 1,
            },
            {
              tries: 2,
              failures: 5,
              mode: 'retry',
              handled: true,
              status: 'succeeded',
              attempts: 2,
            },
            {
              tries: 5,
              failures: 5,
              mode: 'permanent',
              handled: false,
              status: 'failed',
              attempts: 1,
            },
            {
              tries: 5,
              failures: 5,
              mode: 'unknown',
              handled: false,
              status: 'outcome_unknown',
              attempts: 1,
            },
            {
              tries: 5,
              failures: 5,
              mode: 'retry',
              handled: false,
              status: 'canceled',
              attempts: 1,
              control: 'cancel',
              delayMillis: 60_000,
            },
            {
              tries: 5,
              failures: 5,
              mode: 'retry',
              handled: false,
              status: 'timed_out',
              attempts: 1,
              control: 'deadline',
              delayMillis: 60_000,
            },
          ] as const) {
            mode = scenario.mode;
            failures = scenario.failures;
            const workflowId = randomUUID(),
              workflowVersionId = randomUUID();
            await insertCompiledWorkflow(fixture.ownerQuery, {
              actorId: fixture.actorId,
              workspaceId: fixture.workspaceId,
              identity: { workflowId, workflowVersionId },
              graph: graph(
                scenario.tries,
                scenario.handled,
                'delayMillis' in scenario ? scenario.delayMillis : 1_000,
              ),
              name: 'Step retry proof',
              catalog: PLATFORM_NODE_CATALOG,
            });
            await fixture.ownerQuery(
              'update app.workflows set published_version_id=$2 where id=$1',
              [workflowId, workflowVersionId],
            );
            const hash = createHash('sha256')
              .update(randomUUID())
              .digest('hex');
            const accepted = await runs.start({
              actorId: fixture.actorId,
              workspaceId: fixture.workspaceId,
              workflowId,
              idempotencyKeyHash: hash,
              requestHash: hash,
              scope: `workflow:${workflowId}:manual`,
              input: {},
              checkpointFactory: initialCheckpointFactory({ catalog }),
            });
            const runId = accepted.run.id;
            if ('control' in scenario) {
              await fixture.waitFor(
                () =>
                  fixture.workerQuery<{ status: string }>(
                    "select status from app.node_runs where workflow_run_id=$1 and node_id='action'",
                    [runId],
                  ),
                (rows) => rows[0]?.status === 'waiting',
                30_000,
              );
              if (scenario.control === 'cancel')
                await runs.cancel({
                  actorId: fixture.actorId,
                  workspaceId: fixture.workspaceId,
                  runId,
                });
              else
                // Observe the durable wait before expiring its long run budget.
                await fixture.ownerQuery(
                  'update app.workflow_runs set deadline_at=statement_timestamp(),deadline_wakeup_at=null where workspace_id=$1 and id=$2',
                  [fixture.workspaceId, runId],
                );
            }
            await fixture.waitFor(
              () =>
                fixture.workerQuery<{ status: string }>(
                  'select status from app.workflow_runs where id=$1',
                  [runId],
                ),
              (rows) => rows[0]?.status === scenario.status,
              30_000,
            );
            const history = await runs.get({
              actorId: fixture.actorId,
              workspaceId: fixture.workspaceId,
              runId,
            });
            expect(
              history?.nodes.find((node) => node.nodeId === 'action')
                ?.currentAttemptNumber,
            ).toBe(scenario.attempts);
            expect(calls.get(runId)).toBe(scenario.attempts);
            const evidence = await fixture.workerQuery<{ completed_at: Date }>(
              `select a.completed_at from app.node_attempts a join app.node_runs n on n.id=a.node_run_id
           where n.workflow_run_id=$1 and n.node_id='action' order by a.attempt_number`,
              [runId],
            );
            const events = await fixture.workerQuery<{
              type: string;
              payload: { nodeId?: string; dueAt?: string };
            }>(
              'select type,payload from app.run_events where workflow_run_id=$1 order by sequence',
              [runId],
            );
            const retries = events.filter(
              (event) =>
                event.type === 'node.retry_scheduled' &&
                event.payload.nodeId === 'action',
            );
            expect(retries).toHaveLength(
              'control' in scenario ? 1 : scenario.attempts - 1,
            );
            expect(evidence).toHaveLength(scenario.attempts);
            for (const [index, retry] of retries.entries()) {
              const completedAt = evidence[index]?.completed_at;
              const dueAt = retry.payload.dueAt;
              if (completedAt === undefined || dueAt === undefined)
                throw new Error('Persisted retry timing evidence is missing');
              expect(Date.parse(dueAt) - new Date(completedAt).getTime()).toBe(
                'delayMillis' in scenario ? scenario.delayMillis : 1_000,
              );
            }
            expect(
              events.filter((event) => event.type === 'node.failure_routed'),
            ).toHaveLength(scenario.handled ? 1 : 0);
          }
        },
        async () => {
          const errors: unknown[] = [];
          for (const close of owners.reverse()) {
            try {
              await close();
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length > 0)
            throw new AggregateError(
              errors,
              'Step retry qualification cleanup failed',
            );
        },
        'Step retry qualification',
      );
    }, 90_000);
  },
);

function failureKind(
  mode: 'unknown' | 'permanent' | 'retry',
): 'outcome_unknown' | 'failed' | 'retry' {
  switch (mode) {
    case 'unknown':
      return 'outcome_unknown';
    case 'permanent':
      return 'failed';
    case 'retry':
      return 'retry';
  }
}
