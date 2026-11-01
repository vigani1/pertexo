import { createTestArtifactScratch } from '../infrastructure/artifact-scratch.js';
import { randomUUID } from 'node:crypto';
import {
  createArtifactStore,
  parseArtifactStoreConfig,
} from '@pertexo/artifact-store';
import {
  createNodeAttemptRunStore,
  type NodeAttemptRunStore,
} from '@pertexo/core/attempts';
import {
  createWorkerConnectionResolutionDatabase,
  type WorkerConnectionResolutionDatabase,
} from '@pertexo/core/connections';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import type { ConnectionEnvelopeEncryption } from '@pertexo/integrations/server';

import { createQueueProducer, QUEUE_NAME } from '@pertexo/queue';

import { Queue } from 'bullmq';

import { createCoordinatorRuntime } from '../../../src/runs/runtime.js';

import { createWorkerNodeRuntimeCapabilities } from '../../../src/attempts/execution/runtime-capabilities.js';
import {
  databaseUrl,
  operatorUrl,
  redisConnection,
  redisUrl,
  workerUrl,
} from './http-node-attempt.js';
import type { HttpNodeAttemptProofRuntimeOptions } from './http-node-attempt/runtime/contract.js';
import { createHttpProofProviders } from './http-node-attempt/runtime/providers.js';
import { createHttpProofResourceOwners } from './http-node-attempt/runtime/ownership.js';
import { testNodeAttemptRuntime } from '../runtime-factories.js';

export { type HttpNodeAttemptProofRuntimeOptions } from './http-node-attempt/runtime/contract.js';
export async function createHttpNodeAttemptProofRuntime(
  encryption: ConnectionEnvelopeEncryption,
  options: HttpNodeAttemptProofRuntimeOptions = {},
) {
  const { owners, own, transfer } = createHttpProofResourceOwners();
  try {
    const scratch = own(
      'artifact scratch',
      await createTestArtifactScratch(),
      (value) => value.close(),
    );
    const artifactConfig = parseArtifactStoreConfig(process.env);
    const artifactVerifier = own(
      'artifact verifier',
      createArtifactStore(artifactConfig),
      (verifier) => {
        verifier.close();
      },
    );
    const {
      transportRequests,
      slackRequests,
      emailRequests,
      telemetry,
      executionRegistry,
    } = createHttpProofProviders(options);
    let injectedConnectionDatabase:
      WorkerConnectionResolutionDatabase | undefined;
    if (
      options.afterConnectionAssertCurrent !== undefined ||
      options.beforeConnectionResolve !== undefined
    ) {
      const baseConnectionDatabase = own(
        'connection database',
        createWorkerConnectionResolutionDatabase(
          parseDatabaseConfig({
            connectionString: databaseUrl(workerUrl),
            max: 3,
          }),
        ),
        (database) => database.close(),
      );
      injectedConnectionDatabase = Object.freeze({
        ...baseConnectionDatabase,
        assertConnectionSecretCurrent: async (
          input: Parameters<
            WorkerConnectionResolutionDatabase['assertConnectionSecretCurrent']
          >[0],
        ): Promise<void> => {
          await baseConnectionDatabase.assertConnectionSecretCurrent(input);
          await options.afterConnectionAssertCurrent?.(input);
        },
        resolveConnectionSecret: async (input) => {
          await options.beforeConnectionResolve?.(input);
          return baseConnectionDatabase.resolveConnectionSecret(input);
        },
        close: baseConnectionDatabase.close,
      });
      transfer(baseConnectionDatabase);
      own('connection database', injectedConnectionDatabase, (database) =>
        database.close(),
      );
    }
    let capabilities = own(
      'node runtime capabilities',
      await createWorkerNodeRuntimeCapabilities(
        {
          artifactStore: artifactConfig,
          artifactScratchDirectory: scratch.directory,
          database: parseDatabaseConfig({
            connectionString: databaseUrl(workerUrl),
            max: 3,
          }),
          redisUrl,
        },
        {
          connectionEncryption: encryption,
          ...(injectedConnectionDatabase === undefined
            ? {}
            : { connectionDatabase: injectedConnectionDatabase }),
        },
      ),
      (runtime) => runtime.close(),
    );
    if (injectedConnectionDatabase !== undefined) {
      const ownedConnectionDatabase = injectedConnectionDatabase;
      const unwrappedCapabilities = capabilities;
      const closeCapabilities = capabilities.close;
      transfer(unwrappedCapabilities);
      transfer(ownedConnectionDatabase);
      let closePromise: Promise<void> | undefined;
      capabilities = Object.freeze({
        ...capabilities,
        close: (): Promise<void> => {
          closePromise ??= (async () => {
            const errors: unknown[] = [];
            await closeCapabilities().catch((error: unknown) =>
              errors.push(error),
            );
            await ownedConnectionDatabase
              .close()
              .catch((error: unknown) => errors.push(error));
            if (errors.length > 0)
              throw new AggregateError(
                errors,
                'HTTP attempt capabilities cleanup failed',
              );
          })();
          return closePromise;
        },
      });
      own('node runtime capabilities', capabilities, (runtime) =>
        runtime.close(),
      );
    }
    const attemptQueue = own(
      'node attempt queue',
      new Queue(QUEUE_NAME.nodeAttempts, {
        connection: redisConnection(),
      }),
      (queue) => queue.close(),
    );
    const coordinatorQueue = own(
      'workflow coordinator queue',
      new Queue(QUEUE_NAME.workflowCoordinator, {
        connection: redisConnection(),
      }),
      (queue) => queue.close(),
    );
    await Promise.all([
      attemptQueue.obliterate({ force: true }),
      coordinatorQueue.obliterate({ force: true }),
    ]);
    const coordinator = own(
      'coordinator runtime',
      await createCoordinatorRuntime({
        maintenanceDatabase: parseDatabaseConfig({
          connectionString: databaseUrl(operatorUrl),
          max: 2,
        }),
        database: parseDatabaseConfig({
          connectionString: databaseUrl(workerUrl),
          max: 3,
        }),
        maximumAdmissions: 1,
        redisUrl,
      }),
      (runtime) => runtime.close(),
    );
    let injectedRunStore: NodeAttemptRunStore | undefined;
    if (
      options.afterAttemptClaimed !== undefined ||
      options.afterHeartbeat !== undefined ||
      options.beforeHeartbeat !== undefined ||
      options.beforeMarkDispatched !== undefined
    ) {
      const baseRunStore = own(
        'node attempt run store',
        createNodeAttemptRunStore(
          parseDatabaseConfig({
            connectionString: databaseUrl(workerUrl),
            max: 4,
          }),
        ),
        (store) => store.close(),
      );
      injectedRunStore = Object.freeze({
        claimDelivery: async (
          input: Parameters<NodeAttemptRunStore['claimDelivery']>[0],
        ) => {
          const result = await baseRunStore.claimDelivery(input);
          await options.afterAttemptClaimed?.(result);
          return result;
        },
        loadInputs: (input: Parameters<NodeAttemptRunStore['loadInputs']>[0]) =>
          baseRunStore.loadInputs(input),
        readLoopDeclaration: (
          input: Parameters<NodeAttemptRunStore['readLoopDeclaration']>[0],
        ) => baseRunStore.readLoopDeclaration(input),
        readAttemptOutputs: (
          input: Parameters<NodeAttemptRunStore['readAttemptOutputs']>[0],
        ) => baseRunStore.readAttemptOutputs(input),
        listNodeOutcomes: (
          input: Parameters<NodeAttemptRunStore['listNodeOutcomes']>[0],
        ) => baseRunStore.listNodeOutcomes(input),
        readNodeOutputs: (
          input: Parameters<NodeAttemptRunStore['readNodeOutputs']>[0],
        ) => baseRunStore.readNodeOutputs(input),
        markDispatched: async (
          input: Parameters<NodeAttemptRunStore['markDispatched']>[0],
        ) => {
          await options.beforeMarkDispatched?.(input);
          return baseRunStore.markDispatched(input);
        },
        heartbeat: async (
          input: Parameters<NodeAttemptRunStore['heartbeat']>[0],
        ) => {
          await options.beforeHeartbeat?.(input);
          const result = await baseRunStore.heartbeat(input);
          await options.afterHeartbeat?.(result);
          return result;
        },
        complete: (input: Parameters<NodeAttemptRunStore['complete']>[0]) =>
          baseRunStore.complete(input),
        close: () => baseRunStore.close(),
      });
      transfer(baseRunStore);
      own('node attempt run store', injectedRunStore, (store) => store.close());
    }
    const attemptsPromise = testNodeAttemptRuntime(
      {
        database: parseDatabaseConfig({
          connectionString: databaseUrl(workerUrl),
          max: 4,
        }),
        heartbeatIntervalMillis: options.heartbeatIntervalMillis ?? 200,
        leaseDurationSeconds: options.leaseDurationSeconds ?? 10,
        redisUrl,
        workerId: `http-attempt-${randomUUID().slice(0, 8)}`,
      },
      {
        registry: executionRegistry,
        runtimeCapabilities: capabilities.factories,
        ...(injectedRunStore === undefined
          ? {}
          : { runStore: injectedRunStore }),
      },
    );
    if (injectedRunStore !== undefined) transfer(injectedRunStore);
    const attempts = own(
      'node attempt runtime',
      await attemptsPromise,
      (runtime) => runtime.close(),
    );
    const producer = own(
      'queue producer',
      createQueueProducer({ redisUrl }),
      (queueProducer) => queueProducer.close(),
    );

    return {
      artifactVerifier,
      attemptQueue,
      attempts,
      capabilities,
      coordinator,
      coordinatorQueue,
      emailRequests,
      producer,
      slackRequests,
      telemetry,
      transportRequests,
    };
  } catch (startupError: unknown) {
    const errors: unknown[] = [startupError];
    for (const owner of owners.reverse())
      await Promise.resolve()
        .then(owner.close)
        .catch((error: unknown) => errors.push(error));
    if (errors.length === 1) throw startupError;
    throw new AggregateError(
      errors,
      'HTTP attempt proof runtime startup failed',
    );
  }
}
