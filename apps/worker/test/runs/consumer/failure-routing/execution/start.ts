import { createHash, randomUUID } from 'node:crypto';

import { initialCheckpointFactory } from '@pertexo/execution';

import { createOutboxDispatcherDatabase } from '@pertexo/database/testing';

import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';

import { createCoordinatorRuntime } from '../../../../../dist/runs/runtime.js';
import { WorkerDrainState } from '../../../../../dist/runtime/shutdown/drain-state.js';
import { OutboxDispatcher } from '../../../../../dist/transport/outbox/dispatch/runtime.js';
import { coordinatorFixture as fixture } from '../../../../support/coordinator/consumer.js';

import type { RoutingBase } from './contract.js';
import { testNodeAttemptRuntime } from '../../../../support/runtime-factories.js';

export async function startRoutingWorkers(scenario: RoutingBase) {
  const {
    coordinatorConfig,
    owners,
    config,
    registry,
    executed,
    control,
    gate,
    runs,
    workflowId,
    catalog,
  } = scenario;
  const live = {
    coordinator: await createCoordinatorRuntime(coordinatorConfig),
  };
  owners.push(() => live.coordinator.close());
  const attempts = await testNodeAttemptRuntime(
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
          if (runtime.nodeId === 'source' && control.mode !== 'normal')
            throw new NodeExecutorFailure({
              kind: control.mode === 'unknown' ? 'outcome_unknown' : 'failed',
              errorKind: 'authentication',
              possiblyDispatched: false,
            });
          if (runtime.nodeId === 'handler') {
            if (control.mode === 'handler-retry' && !control.handlerRetried) {
              control.handlerRetried = true;
              throw new NodeExecutorFailure({
                kind: 'retry',
                errorKind: 'network',
                possiblyDispatched: false,
              });
            }
            if (control.mode === 'handler-failed')
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
  const dispatcher = new OutboxDispatcher(store, producer, {
    drainState: new WorkerDrainState(),
    options: {
      batchSize: 10,
      jobNames: [JOB_NAME.advanceWorkflowRun, JOB_NAME.executeNodeAttempt],
      leaseDurationMillis: 30_000,
      leaseOwner: `routing-${randomUUID()}`,
      retryDelayMillis: 1_000,
      pollIntervalMillis: 250,
    },
  });
  owners.splice(-2, 2, () => dispatcher.close());

  await Promise.all([
    live.coordinator.consumer.waitUntilReady(5_000),
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

  return { live, start, wait };
}
