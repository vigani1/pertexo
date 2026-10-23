import {
  createCallbackStore,
  type CallbackStore,
} from '@pertexo/database/runs';
import {
  createCallbackTokenKeys,
  type CallbackKeyConfig,
  type CallbackTokenKeys,
} from '@pertexo/integrations/server';
import { createCallbackRuntime } from '../callbacks/runtime.js';
import { ArtifactScratchSpace } from '../artifacts/scratch/space.js';
import { FILE_PAGE_LIMITS } from '@pertexo/node-sdk';
import {
  createRunValuesStore,
  type RunValuesStore,
} from '@pertexo/database/runs';
import { createRunValuesRuntime } from './run-values.js';
import {
  createWorkerDataTablesStore,
  type WorkerDataTablesStore,
} from '@pertexo/database/data-tables';
import { retainCodeOutput } from '../code/output.js';
import {
  createCodeRunnerClient,
  type WorkerCodeRunnerConfig,
} from '../code/client.js';
import { CODE_LIMITS } from '@pertexo/node-sdk';
import {
  createWebhookResponseStore,
  type WebhookResponseStore,
} from '@pertexo/database/triggers';
import {
  createArtifactStore,
  type ArtifactStore,
  type ArtifactStoreConfig,
} from '@pertexo/artifact-store';
import {
  createWorkerConnectionResolutionDatabase,
  type WorkerConnectionResolutionDatabase,
} from '@pertexo/database/connections';
import {
  createPendingArtifact,
  createPendingPreviewArtifact,
  finalizeArtifactUpload,
  requireNodeArtifactReference,
} from '@pertexo/database/runs';
import {
  createWorkspaceDatabase,
  type DatabaseConfig,
  type DatabaseRuntime,
  type WorkspaceDatabase,
} from '@pertexo/database/platform';
import {
  createConnectionEnvelopeEncryption,
  type ConnectionEnvelopeEncryptionConfig,
  type ConnectionEnvelopeEncryptionRuntime,
  type ConnectionEnvelopeEncryption,
} from '@pertexo/integrations/server';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit';

import type { NodeExecutionCapabilityFactories } from './capabilities.js';
import {
  createProviderConnectionRuntimeFactory,
  type ProviderRateLimiter,
} from '../../providers/connections.js';
import {
  createNodeArtifactRuntimeFactory,
  type ArtifactSpoolOperations,
  type WorkerArtifactPersistence,
} from '../artifacts/runtime.js';

const DEFAULT_ARTIFACT_RETENTION_MILLIS = 30 * 24 * 60 * 60_000;

function assertCapabilityRuntimeOpen(lifecycle: { terminal: boolean }): void {
  if (lifecycle.terminal)
    throw new Error('Worker node runtime capabilities are closed');
}

export type WorkerNodeRuntimeCapabilityOptions = Readonly<{
  callbacks?: CallbackKeyConfig;
  database: DatabaseConfig;
  codeRunner?: WorkerCodeRunnerConfig;
  connectionEncryption?: ConnectionEnvelopeEncryptionConfig;
  artifactStore?: ArtifactStoreConfig;
  artifactRetentionMillis?: number;
  artifactScratchDirectory?: string;
  redisUrl?: string;
}>;

export type WorkerNodeRuntimeCapabilityDependencies = Readonly<{
  callbackStore?: CallbackStore;
  databaseRuntime?: DatabaseRuntime;
  webhookResponses?: Pick<WebhookResponseStore, 'respond'>;
  dataTables?: Pick<WorkerDataTablesStore, 'execute'>;
  runValues?: Pick<RunValuesStore, 'save'>;
  connectionDatabase?: Parameters<
    typeof createProviderConnectionRuntimeFactory
  >[0];
  connectionEncryption?: Pick<ConnectionEnvelopeEncryption, 'open'>;
  artifactPersistence?: WorkerArtifactPersistence;
  artifactStore?: Pick<ArtifactStore, 'put'> &
    Partial<Pick<ArtifactStore, 'checkReadiness' | 'getStream'>>;
  artifactId?: () => string;
  now?: () => Date;
  spoolDirectory?: string;
  artifactSpoolOperations?: ArtifactSpoolOperations;
  providerRateLimiter?: ProviderRateLimiter;
}>;

export type WorkerNodeRuntimeCapabilities = Readonly<{
  factories: NodeExecutionCapabilityFactories;
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}>;

function artifactPersistence(
  database: WorkspaceDatabase,
): WorkerArtifactPersistence {
  return Object.freeze({
    requireReadable: async (
      input: Parameters<
        NonNullable<WorkerArtifactPersistence['requireReadable']>
      >[0],
    ) => {
      await database.withWorkspace(
        input.workspaceId,
        (transaction) =>
          requireNodeArtifactReference(
            transaction,
            input.reference,
            input.previewRunId,
          ),
        { signal: input.signal },
      );
    },
    createPending: async (
      input: Parameters<WorkerArtifactPersistence['createPending']>[0],
    ): Promise<void> => {
      await database.withWorkspace(
        input.workspaceId,
        (transaction) =>
          input.previewRunId === undefined
            ? createPendingArtifact(transaction, {
                artifactId: input.artifactId,
                byteLength: input.byteLength,
                mediaType: input.mediaType,
                sha256: input.sha256,
                storageKey: input.storageKey,
                expiresAt: input.expiresAt,
                purpose: input.purpose,
              })
            : createPendingPreviewArtifact(transaction, {
                artifactId: input.artifactId,
                byteLength: input.byteLength,
                mediaType: input.mediaType,
                sha256: input.sha256,
                storageKey: input.storageKey,
                expiresAt: input.expiresAt,
                purpose: input.purpose,
                previewRunId: input.previewRunId,
              }),
        { signal: input.signal },
      );
    },
    finalize: async (
      input: Parameters<WorkerArtifactPersistence['finalize']>[0],
    ): Promise<void> => {
      await database.withWorkspace(
        input.workspaceId,
        (transaction) =>
          finalizeArtifactUpload(transaction, {
            artifactId: input.artifactId,
            workspaceId: input.workspaceId,
            byteLength: input.byteLength,
            mediaType: input.mediaType,
            sha256: input.sha256,
            storageKey: input.storageKey,
          }),
        { signal: input.signal },
      );
    },
  });
}

export async function createWorkerNodeRuntimeCapabilities(
  options: WorkerNodeRuntimeCapabilityOptions,
  dependencies: WorkerNodeRuntimeCapabilityDependencies = {},
): Promise<WorkerNodeRuntimeCapabilities> {
  const retentionMillis =
    options.artifactRetentionMillis ?? DEFAULT_ARTIFACT_RETENTION_MILLIS;

  let ownedCallbacks: CallbackStore | undefined;
  let callbackKeys: CallbackTokenKeys | undefined;
  let ownedDataTables: WorkerDataTablesStore | undefined;
  let ownedRunValues: RunValuesStore | undefined;
  let ownedWebhookResponses: WebhookResponseStore | undefined;
  let encryptionRuntime: ConnectionEnvelopeEncryptionRuntime | undefined;
  let ownedConnectionDatabase: WorkerConnectionResolutionDatabase | undefined;
  let ownedArtifactDatabase: WorkspaceDatabase | undefined;
  let ownedArtifactStore: ArtifactStore | undefined;
  let ownedProviderRateLimiter: RedisRateLimitRuntime | undefined;

  const connectionConfigured =
    options.connectionEncryption !== undefined ||
    dependencies.connectionDatabase !== undefined ||
    dependencies.connectionEncryption !== undefined;
  const artifactConfigured =
    options.artifactStore !== undefined ||
    dependencies.artifactPersistence !== undefined ||
    dependencies.artifactStore !== undefined;

  const codeClient =
    options.codeRunner === undefined
      ? undefined
      : createCodeRunnerClient(options.codeRunner);
  const factories: {
    callbacks?: NonNullable<NodeExecutionCapabilityFactories['callbacks']>;
    runValues?: NonNullable<NodeExecutionCapabilityFactories['runValues']>;
    dataTables?: NonNullable<NodeExecutionCapabilityFactories['dataTables']>;
    code?: NonNullable<NodeExecutionCapabilityFactories['code']>;
    connections?: NonNullable<NodeExecutionCapabilityFactories['connections']>;
    artifacts?: NonNullable<NodeExecutionCapabilityFactories['artifacts']>;
    webhookResponse?: NonNullable<
      NodeExecutionCapabilityFactories['webhookResponse']
    >;
  } = {};
  let closePromise: Promise<void> | undefined;
  const lifecycle = { terminal: false };
  let checkArtifactReadiness: (() => Promise<unknown>) | undefined;
  const closeOwnedResources = (): Promise<void> => {
    if (closePromise === undefined) {
      lifecycle.terminal = true;
      closePromise = (async (): Promise<void> => {
        codeClient?.close();
        callbackKeys?.close();
        const closeOperations = [
          ownedDataTables?.close.bind(ownedDataTables),
          ownedCallbacks?.close.bind(ownedCallbacks),
          ownedRunValues?.close.bind(ownedRunValues),
          ownedWebhookResponses?.close.bind(ownedWebhookResponses),
          ownedConnectionDatabase?.close.bind(ownedConnectionDatabase),
          ownedArtifactDatabase?.close.bind(ownedArtifactDatabase),
          encryptionRuntime?.close.bind(encryptionRuntime),
          ownedArtifactStore?.close.bind(ownedArtifactStore),
          ownedProviderRateLimiter?.close.bind(ownedProviderRateLimiter),
        ].filter((close): close is () => unknown => Boolean(close));
        const results = await Promise.allSettled(
          closeOperations.map((close) => Promise.resolve().then(close)),
        );
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason as unknown] : [],
        );
        if (failures.length > 0)
          throw new AggregateError(
            failures,
            'Worker node runtime capability shutdown failed',
          );
      })();
    }
    return closePromise;
  };
  try {
    if (options.callbacks !== undefined) {
      const callbackStore =
        dependencies.callbackStore ??
        (ownedCallbacks = createCallbackStore(
          options.database,
          dependencies.databaseRuntime,
        ));
      const keys = (callbackKeys = createCallbackTokenKeys(options.callbacks));
      factories.callbacks = (context) =>
        createCallbackRuntime(callbackStore, keys, context, () => {
          assertCapabilityRuntimeOpen(lifecycle);
        });
    }
    const runValues =
      dependencies.runValues ??
      (ownedRunValues = createRunValuesStore(
        options.database,
        dependencies.databaseRuntime,
      ));
    factories.runValues = (context) =>
      createRunValuesRuntime(runValues, context, () => {
        assertCapabilityRuntimeOpen(lifecycle);
      });
    const dataTables =
      dependencies.dataTables ??
      (ownedDataTables = createWorkerDataTablesStore(
        options.database,
        dependencies.databaseRuntime,
      ));
    factories.dataTables = (context) => ({
      execute: ({ command, columnBindings, signal }) => {
        assertCapabilityRuntimeOpen(lifecycle);
        return dataTables.execute({
          ...context,
          command,
          ...(columnBindings === undefined ? {} : { columnBindings }),
          signal,
        });
      },
    });
    if (codeClient !== undefined && options.codeRunner !== undefined) {
      const settings = options.codeRunner.settings;
      factories.code = (context) => ({
        execute: async ({ code, language, timeoutSeconds, input, signal }) => {
          assertCapabilityRuntimeOpen(lifecycle);
          return retainCodeOutput(
            await codeClient.execute(
              {
                code,
                ...(language === undefined ? {} : { language }),
                timeoutSeconds:
                  timeoutSeconds ??
                  Math.min(
                    CODE_LIMITS.defaultTimeoutSeconds,
                    settings.maximumSeconds,
                  ),
                input,
                variables: context.variables,
              },
              signal,
            ),
          );
        },
      });
    }
    const webhookResponses =
      dependencies.webhookResponses ??
      (ownedWebhookResponses = createWebhookResponseStore(
        options.database,
        dependencies.databaseRuntime,
      ));
    factories.webhookResponse = (context) => ({
      respond: async ({ response, signal }) => {
        assertCapabilityRuntimeOpen(lifecycle);
        signal.throwIfAborted();
        if (context.previewRunId !== undefined || (context.testRun ?? false))
          return { outcome: 'preview', statusCode: response.statusCode };
        return webhookResponses.respond({
          workspaceId: context.workspaceId,
          runId: context.runId,
          nodeRunId: context.nodeRunId,
          attemptId: context.attemptId,
          attemptNumber: context.attemptNumber,
          nodeId: context.nodeId,
          invocationKey: context.invocationKey,
          workerId: context.workerId,
          fenceToken: context.fenceToken,
          response,
          signal,
        });
      },
    });
    if (connectionConfigured) {
      const providerRateLimiter =
        dependencies.providerRateLimiter ??
        (options.redisUrl === undefined
          ? undefined
          : (ownedProviderRateLimiter = new RedisRateLimitRuntime(
              options.redisUrl,
            )));
      if (providerRateLimiter === undefined)
        throw new Error('Worker provider rate limiter is incomplete');
      const connectionDatabase =
        dependencies.connectionDatabase ??
        (ownedConnectionDatabase = createWorkerConnectionResolutionDatabase(
          options.database,
          dependencies.databaseRuntime,
        ));
      const encryption =
        dependencies.connectionEncryption ??
        (options.connectionEncryption === undefined
          ? undefined
          : (encryptionRuntime = createConnectionEnvelopeEncryption(
              options.connectionEncryption,
            )).encryption);
      if (encryption === undefined)
        throw new Error('Worker connection capability is incomplete');
      factories.connections = createProviderConnectionRuntimeFactory(
        connectionDatabase,
        encryption,
        providerRateLimiter,
      );
    }
    if (artifactConfigured) {
      const persistence =
        dependencies.artifactPersistence ??
        artifactPersistence(
          (ownedArtifactDatabase = createWorkspaceDatabase(
            options.database,
            dependencies.databaseRuntime === undefined
              ? {}
              : { runtime: dependencies.databaseRuntime },
          )),
        );
      const store =
        dependencies.artifactStore ??
        (options.artifactStore === undefined
          ? undefined
          : (ownedArtifactStore = createArtifactStore(options.artifactStore)));
      if (store === undefined)
        throw new Error('Worker artifact capability is incomplete');
      const readiness = store;
      const checkReadiness = readiness.checkReadiness;
      if (checkReadiness !== undefined)
        checkArtifactReadiness = () => checkReadiness.call(readiness);
      const directory =
        dependencies.spoolDirectory ?? options.artifactScratchDirectory;
      if (directory === undefined)
        throw new Error(
          'Configure ARTIFACT_SCRATCH_DIRECTORY as a private disk-backed directory for this worker.',
        );
      const scratch = await ArtifactScratchSpace.create(
        directory,
        dependencies.artifactSpoolOperations,
      );
      const checkStoreReadiness = checkArtifactReadiness;
      checkArtifactReadiness = async () => {
        scratch.checkReadiness();
        await checkStoreReadiness?.();
      };
      factories.artifacts = createNodeArtifactRuntimeFactory({
        assertOpen: () => {
          assertCapabilityRuntimeOpen(lifecycle);
        },
        scratch,
        maximumBytes: Math.min(
          FILE_PAGE_LIMITS.fileBytes,
          options.artifactStore?.maxObjectBytes ?? FILE_PAGE_LIMITS.fileBytes,
        ),
        persistence,
        store,
        retentionMillis,
        ...(dependencies.artifactId === undefined
          ? {}
          : { artifactId: dependencies.artifactId }),
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      });
    }
  } catch (error: unknown) {
    try {
      await closeOwnedResources();
    } catch (cleanupError: unknown) {
      const cleanupFailures =
        cleanupError instanceof AggregateError
          ? (cleanupError.errors as unknown[])
          : [cleanupError];
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Worker node runtime capability construction failed and cleanup was incomplete',
      );
    }
    throw error;
  }

  return Object.freeze({
    factories: Object.freeze(factories),
    checkReadiness: async (): Promise<void> => {
      assertCapabilityRuntimeOpen(lifecycle);
      await checkArtifactReadiness?.();
      assertCapabilityRuntimeOpen(lifecycle);
    },
    close: closeOwnedResources,
  });
}
