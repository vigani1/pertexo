import { randomUUID } from 'node:crypto';

import {
  parseDatabaseConfig,
  parseStoredExecutionValueV1,
} from '@pertexo/database/testing';
import {
  platformServingRegistryRelease,
  PLATFORM_REGISTRY_RELEASE_VALIDATE_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_VALIDATE_STAGED,
} from '@pertexo/node-catalog';
import { createPlatformNodeRegistryForRelease } from '@pertexo/node-catalog/server';
import {
  CORE_VALIDATE_CONFIG_SCHEMA,
  evaluateCoreValidate,
} from '@pertexo/nodes-core';
import { JOB_NAME, QUEUE_NAME, createQueueProducer } from '@pertexo/queue';
import { Queue } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { createCoordinatorRuntime } from '../src/execution/coordinator-runtime.js';
import { createNodeAttemptRuntime } from '../src/execution/node-attempt-runtime.js';
import {
  createDatabasePreviewAttemptRunStore,
  createPlatformPreviewNodeInvoker,
} from '../src/execution/preview-attempt-runtime.js';
import {
  acceptDelivery,
  acceptWorkflowDelivery,
  activateArtifactRelease,
  databaseUrl,
  providerEffectCount,
  redisConnectionOptions,
  redisUrl,
  validTraceparent,
  waitFor,
  workerTransportIntegrationEnabled,
  withPublishedPreviewDelivery,
  withTenantScopedWorker,
  workerUrl,
  workflowVersionId,
} from './support/preview-consumer.integration.support.js';

const describeIntegration = workerTransportIntegrationEnabled
  ? describe
  : describe.skip;

const validateConfigInput = {
  rules: [
    {
      id: 'email',
      path: '$.profile.email',
      required: true,
      type: 'string',
      minLength: 8,
    },
    {
      id: 'role',
      path: '$.profile.role',
      type: 'string',
      enum: ['admin'],
    },
  ],
};

async function createValidateRuntime() {
  const releaseCohort = 'validate_activation' as const;
  const previewStore = createDatabasePreviewAttemptRunStore(
    parseDatabaseConfig({ connectionString: databaseUrl(workerUrl) }),
  );
  const registry = createPlatformNodeRegistryForRelease(
    platformServingRegistryRelease(releaseCohort),
  );
  return createNodeAttemptRuntime(
    {
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
      }),
      heartbeatIntervalMillis: 200,
      leaseDurationSeconds: 10,
      preview: {
        invoker: createPlatformPreviewNodeInvoker({
          releaseCohort,
          registry,
        }),
        runStore: previewStore,
      },
      redisUrl,
      releaseCohort,
      workerId: `validate-preview-${randomUUID().slice(0, 8)}`,
    },
    {
      runtimeCapabilities: {
        connections: () => ({
          resolve: () =>
            Promise.reject(
              new Error('Validate preview must not resolve a connection'),
            ),
        }),
        artifacts: () => ({
          write: () =>
            Promise.reject(
              new Error('Validate preview must not write an artifact'),
            ),
        }),
      },
    },
  );
}

describeIntegration('core.validate persisted preview execution', () => {
  it('persists mismatch and matching results and survives exact redelivery after restart', async () => {
    const releaseCohort = 'validate_activation' as const;
    await activateArtifactRelease(releaseCohort);
    expect(PLATFORM_REGISTRY_RELEASE_VALIDATE_STAGED.epoch).toBe(37);
    expect(PLATFORM_REGISTRY_RELEASE_VALIDATE_ACTIVE.epoch).toBe(38);
    expect(platformServingRegistryRelease(releaseCohort).fingerprint).toBe(
      PLATFORM_REGISTRY_RELEASE_VALIDATE_ACTIVE.fingerprint,
    );

    const config = CORE_VALIDATE_CONFIG_SCHEMA.parse(validateConfigInput);
    const runInput = {
      profile: { email: 'bad', role: 'member' },
      secret: 'must-not-be-echoed',
    };
    const resolvedInput = {
      profile: runInput.profile,
      secret: runInput.secret,
    };
    const expected = evaluateCoreValidate(config, resolvedInput);
    const traceparent = validTraceparent(15);
    const delivery = await acceptDelivery(traceparent, {
      definitionKey: 'core.validate',
      definitionVersion: 1,
      executableNode: {
        config: validateConfigInput,
        configVersion: 1,
        definition: { key: 'core.validate', version: 1 },
        id: 'validate-node',
        inputMappings: {
          profile: { kind: 'run_input', path: '$.profile' },
          secret: { kind: 'run_input', path: '$.secret' },
        },
        connectionRefs: {},
      },
      executorKey: 'core.validate',
      executorVersion: 1,
      input: { kind: 'manual', value: runInput },
      nodeId: 'validate-node',
      scope: 'validate-preview',
    });
    expect(resolvedInput.secret).toBe(runInput.secret);
    const runtime = await createValidateRuntime();
    try {
      const mismatchState = await withPublishedPreviewDelivery(
        runtime,
        delivery,
        async ({ job, queue, state }) => {
          expect(state?.dispatch_marked_at).toBeNull();
          const persisted = parseStoredExecutionValueV1(state?.output_ref);
          expect(persisted).toEqual({
            kind: 'inline',
            schemaVersion: 1,
            value: expected,
          });
          expect(JSON.stringify(persisted)).not.toContain(runInput.secret);
          await expect(providerEffectCount('validate-preview')).resolves.toBe(
            0,
          );
          const completedJob = await waitFor(
            () => queue.getJob(job.jobId),
            (value) => value !== undefined,
          );
          if (completedJob === undefined)
            throw new Error('completed validate preview job missing');
          await waitFor(
            () => completedJob.getState(),
            (value) => value === 'completed',
          );
          await completedJob.remove();
          return state;
        },
      );
      await runtime.close();

      // The next process instance receives the exact same transport envelope;
      // durable claim state must classify it as a duplicate without changing
      // the result or calling a capability factory.
      const restartedRuntime = await createValidateRuntime();
      try {
        await withPublishedPreviewDelivery(
          restartedRuntime,
          delivery,
          ({ state }) => {
            expect(state).toEqual(mismatchState);
            return Promise.resolve();
          },
        );

        const matchingInput = {
          profile: {
            email: 'valid@example.test',
            role: 'admin',
          },
          secret: 'matching-secret-must-not-be-echoed',
        };
        const matchingExpected = evaluateCoreValidate(config, {
          profile: matchingInput.profile,
          secret: matchingInput.secret,
        });
        const matchingDelivery = await acceptDelivery(validTraceparent(16), {
          definitionKey: 'core.validate',
          definitionVersion: 1,
          executableNode: {
            config: validateConfigInput,
            configVersion: 1,
            definition: { key: 'core.validate', version: 1 },
            id: 'validate-node',
            inputMappings: {
              profile: { kind: 'run_input', path: '$.profile' },
              secret: { kind: 'run_input', path: '$.secret' },
            },
            connectionRefs: {},
          },
          executorKey: 'core.validate',
          executorVersion: 1,
          input: { kind: 'manual', value: matchingInput },
          nodeId: 'validate-node',
          scope: 'validate-preview-matching',
        });
        await withPublishedPreviewDelivery(
          restartedRuntime,
          matchingDelivery,
          ({ state }) => {
            const persisted = parseStoredExecutionValueV1(state?.output_ref);
            expect(persisted).toEqual({
              kind: 'inline',
              schemaVersion: 1,
              value: matchingExpected,
            });
            expect(matchingExpected.valid).toBe(true);
            expect(JSON.stringify(persisted)).not.toContain(
              matchingInput.secret,
            );
            return Promise.resolve();
          },
        );
      } finally {
        await restartedRuntime.close();
      }
    } finally {
      await runtime.close();
    }
  });
});

describeIntegration('core.validate persisted workflow execution', () => {
  it('executes a published Validate node through coordinator and attempt workers', async () => {
    const releaseCohort = 'validate_activation' as const;
    await activateArtifactRelease(releaseCohort);
    const runInput = {
      profile: { email: 'bad', role: 'member' },
      secret: 'workflow-secret-must-not-be-echoed',
    };
    const expected = evaluateCoreValidate(
      CORE_VALIDATE_CONFIG_SCHEMA.parse(validateConfigInput),
      runInput,
    );
    const delivery = await acceptWorkflowDelivery(
      validTraceparent(17),
      runInput,
    );
    const database = parseDatabaseConfig({
      connectionString: databaseUrl(workerUrl),
      max: 4,
    });
    const coordinator = await createCoordinatorRuntime({
      database,
      maximumAdmissions: 1,
      redisUrl,
      releaseCohort,
    });
    const attempts = await createNodeAttemptRuntime(
      {
        database,
        heartbeatIntervalMillis: 200,
        leaseDurationSeconds: 10,
        redisUrl,
        releaseCohort,
        workerId: `validate-workflow-${randomUUID().slice(0, 8)}`,
      },
      {
        runtimeCapabilities: {
          connections: () => ({
            resolve: () =>
              Promise.reject(
                new Error('Validate workflow must not resolve a connection'),
              ),
          }),
          artifacts: () => ({
            write: () =>
              Promise.reject(
                new Error('Validate workflow must not write an artifact'),
              ),
          }),
        },
      },
    );
    const producer = createQueueProducer({ redisUrl });
    const connection = redisConnectionOptions();
    const coordinatorQueue = new Queue(QUEUE_NAME.workflowCoordinator, {
      connection,
    });
    const attemptQueue = new Queue(QUEUE_NAME.nodeAttempts, { connection });
    const coordinatorOutboxes = [delivery.accepted.outboxEventId];
    const attemptOutboxes: string[] = [];

    const waitForJob = async (
      queue: Queue,
      published: Awaited<ReturnType<typeof producer.publish>>,
      label: string,
    ): Promise<void> => {
      const persisted = await waitFor(
        () => queue.getJob(published.jobId),
        (value) => value !== undefined,
      );
      if (persisted === undefined) throw new Error(`${label} job missing`);
      const state = await waitFor(
        () => persisted.getState(),
        (value) => value === 'completed' || value === 'failed',
      );
      expect(state, `${label} job failed`).toBe('completed');
    };

    const nextAttempt = async () => {
      const rows = await waitFor(
        () =>
          withTenantScopedWorker((client) =>
            client.query<{
              attempt_id: string;
              id: string;
              node_id: string;
              node_run_id: string;
            }>(
              `select outbox.id,attempt.id attempt_id,node.id node_run_id,
                      node.node_id
               from app.outbox_events outbox
               join app.node_attempts attempt
                 on attempt.workspace_id=outbox.workspace_id
                and attempt.id=outbox.aggregate_id
               join app.node_runs node
                 on node.workspace_id=attempt.workspace_id
                and node.id=attempt.node_run_id
               where outbox.workspace_id=$1 and node.workflow_run_id=$2
                 and outbox.job_name='execute-node-attempt'
                 and not (outbox.id=any($3::uuid[]))
               order by outbox.created_at,outbox.id`,
              [
                delivery.job.data.workspaceId,
                delivery.accepted.runId,
                attemptOutboxes,
              ],
            ),
          ).then((result) => result.rows),
        (value) => value.length > 0,
      );
      const attempt = rows[0];
      if (attempt === undefined) throw new Error('workflow attempt missing');
      attemptOutboxes.push(attempt.id);
      return attempt;
    };

    const nextCoordinatorOutbox = async (): Promise<string> => {
      const rows = await waitFor(
        () =>
          withTenantScopedWorker((client) =>
            client.query<{ id: string }>(
              `select id from app.outbox_events
               where workspace_id=$1 and aggregate_id=$2
                 and job_name='advance-workflow-run'
                 and not (id=any($3::uuid[]))
               order by created_at,id`,
              [
                delivery.job.data.workspaceId,
                delivery.accepted.runId,
                coordinatorOutboxes,
              ],
            ),
          ).then((result) => result.rows),
        (value) => value.length > 0,
      );
      const outbox = rows[0]?.id;
      if (outbox === undefined)
        throw new Error('workflow continuation missing');
      coordinatorOutboxes.push(outbox);
      return outbox;
    };

    const publishCoordinator = async (outboxEventId: string) => {
      const published = await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1 as const,
          workspaceId: delivery.job.data.workspaceId,
          runId: delivery.accepted.runId,
          outboxEventId,
          traceparent: delivery.job.data.traceparent,
        },
      });
      await waitForJob(coordinatorQueue, published, 'coordinator');
    };

    const publishAttempt = async (attempt: {
      attempt_id: string;
      id: string;
      node_run_id: string;
    }) => {
      const published = await producer.publish({
        name: JOB_NAME.executeNodeAttempt,
        data: {
          schemaVersion: 1 as const,
          workspaceId: delivery.job.data.workspaceId,
          runId: delivery.accepted.runId,
          nodeRunId: attempt.node_run_id,
          attemptId: attempt.attempt_id,
          outboxEventId: attempt.id,
          traceparent: delivery.job.data.traceparent,
        },
      });
      await waitForJob(attemptQueue, published, 'attempt');
    };

    try {
      await Promise.all([
        coordinator.consumer.waitUntilReady(5_000),
        attempts.consumer.waitUntilReady(5_000),
        producer.waitUntilReady(5_000),
      ]);
      await publishCoordinator(delivery.accepted.outboxEventId);
      const manual = await nextAttempt();
      expect(manual.node_id).toBe('manual');
      await publishAttempt(manual);

      await publishCoordinator(await nextCoordinatorOutbox());
      const validate = await nextAttempt();
      expect(validate.node_id).toBe('validate');
      await publishAttempt(validate);

      const validateFact = await waitFor(
        () =>
          withTenantScopedWorker((client) =>
            client.query<{
              attempt_status: string;
              node_status: string;
              output_ref: unknown;
            }>(
              `select attempt.status attempt_status,node.status node_status,
                      node.output_ref
               from app.node_runs node
               join app.node_attempts attempt
                 on attempt.workspace_id=node.workspace_id
                and attempt.id=node.current_attempt_id
               where node.workspace_id=$1 and node.id=$2`,
              [delivery.job.data.workspaceId, validate.node_run_id],
            ),
          ).then((result) => result.rows[0]),
        (value) => value?.attempt_status === 'succeeded',
      );
      expect(validateFact).toMatchObject({
        attempt_status: 'succeeded',
        node_status: 'succeeded',
        output_ref: {
          schemaVersion: 1,
          kind: 'inline',
          value: expected,
        },
      });
      expect(JSON.stringify(validateFact?.output_ref)).not.toContain(
        runInput.secret,
      );
      await publishCoordinator(await nextCoordinatorOutbox());
      await waitFor(
        () =>
          withTenantScopedWorker((client) =>
            client.query<{ status: string; workflow_version_id: string }>(
              `select status,workflow_version_id from app.workflow_runs
               where workspace_id=$1 and id=$2`,
              [delivery.job.data.workspaceId, delivery.accepted.runId],
            ),
          ).then((result) => result.rows[0]),
        (value) =>
          value?.status === 'succeeded' &&
          value.workflow_version_id === workflowVersionId,
      );
    } finally {
      await Promise.allSettled([
        producer.close(),
        attemptQueue.close(),
        coordinatorQueue.close(),
        attempts.close(),
        coordinator.close(),
      ]);
    }
  });
});
