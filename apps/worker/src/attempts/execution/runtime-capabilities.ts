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
  const state: CapabilityAssembly = {
    options,
    dependencies,
    resources: {},
    factories: {},
    lifecycle: { terminal: false },
    retentionMillis,
    codeClient,
  };
  try {
    prepareCallbackCapability(state);
    prepareRunValuesCapability(state);
    prepareDataTablesCapability(state);
    prepareCodeCapability(state);
    prepareWebhookResponseCapability(state);
    if (connectionConfigured) prepareConnectionCapability(state);
    if (artifactConfigured) await prepareArtifactCapability(state);
  } catch (error: unknown) {
    try {
      await closeCapabilityResources(state);
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
    factories: Object.freeze(state.factories),
    checkReadiness: async (): Promise<void> => {
      assertCapabilityRuntimeOpen(state.lifecycle);
      await state.checkArtifactReadiness?.();
      assertCapabilityRuntimeOpen(state.lifecycle);
    },
    close: () => closeCapabilityResources(state),
  });
}

interface OwnedCapabilityResources {
  ownedCallbacks?: CallbackStore | undefined;
  callbackKeys?: CallbackTokenKeys | undefined;
  ownedDataTables?: WorkerDataTablesStore | undefined;
  ownedRunValues?: RunValuesStore | undefined;
  ownedWebhookResponses?: WebhookResponseStore | undefined;
  encryptionRuntime?: ConnectionEnvelopeEncryptionRuntime | undefined;
  ownedConnectionDatabase?: WorkerConnectionResolutionDatabase | undefined;
  ownedArtifactDatabase?: WorkspaceDatabase | undefined;
  ownedArtifactStore?: ArtifactStore | undefined;
  ownedProviderRateLimiter?: RedisRateLimitRuntime | undefined;
}
interface CapabilityAssembly {
  readonly options: WorkerNodeRuntimeCapabilityOptions;
  readonly dependencies: WorkerNodeRuntimeCapabilityDependencies;
  readonly resources: OwnedCapabilityResources;
  readonly factories: {
    callbacks?: NonNullable<NodeExecutionCapabilityFactories['callbacks']>;
    runValues?: NonNullable<NodeExecutionCapabilityFactories['runValues']>;
    dataTables?: NonNullable<NodeExecutionCapabilityFactories['dataTables']>;
    code?: NonNullable<NodeExecutionCapabilityFactories['code']>;
    connections?: NonNullable<NodeExecutionCapabilityFactories['connections']>;
    artifacts?: NonNullable<NodeExecutionCapabilityFactories['artifacts']>;
    webhookResponse?: NonNullable<
      NodeExecutionCapabilityFactories['webhookResponse']
    >;
  };
  readonly lifecycle: { terminal: boolean };
  closePromise?: Promise<void> | undefined;
  checkArtifactReadiness?: (() => Promise<unknown>) | undefined;
  readonly retentionMillis: number;
  readonly codeClient: ReturnType<typeof createCodeRunnerClient> | undefined;
}

function closeCapabilityResources(state: CapabilityAssembly): Promise<void> {
  if (state.closePromise === undefined) {
    state.lifecycle.terminal = true;
    state.closePromise = (async (): Promise<void> => {
      state.codeClient?.close();
      state.resources.callbackKeys?.close();
      const closeOperations = [
        state.resources.ownedDataTables?.close.bind(
          state.resources.ownedDataTables,
        ),
        state.resources.ownedCallbacks?.close.bind(
          state.resources.ownedCallbacks,
        ),
        state.resources.ownedRunValues?.close.bind(
          state.resources.ownedRunValues,
        ),
        state.resources.ownedWebhookResponses?.close.bind(
          state.resources.ownedWebhookResponses,
        ),
        state.resources.ownedConnectionDatabase?.close.bind(
          state.resources.ownedConnectionDatabase,
        ),
        state.resources.ownedArtifactDatabase?.close.bind(
          state.resources.ownedArtifactDatabase,
        ),
        state.resources.encryptionRuntime?.close.bind(
          state.resources.encryptionRuntime,
        ),
        state.resources.ownedArtifactStore?.close.bind(
          state.resources.ownedArtifactStore,
        ),
        state.resources.ownedProviderRateLimiter?.close.bind(
          state.resources.ownedProviderRateLimiter,
        ),
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
  return state.closePromise;
}

function prepareCallbackCapability(state: CapabilityAssembly): void {
  if (state.options.callbacks !== undefined) {
    const callbackStore =
      state.dependencies.callbackStore ??
      (state.resources.ownedCallbacks = createCallbackStore(
        state.options.database,
        state.dependencies.databaseRuntime,
      ));
    const keys = (state.resources.callbackKeys = createCallbackTokenKeys(
      state.options.callbacks,
    ));
    state.factories.callbacks = (context) =>
      createCallbackRuntime(callbackStore, keys, context, () => {
        assertCapabilityRuntimeOpen(state.lifecycle);
      });
  }
}

function prepareRunValuesCapability(state: CapabilityAssembly): void {
  const runValues =
    state.dependencies.runValues ??
    (state.resources.ownedRunValues = createRunValuesStore(
      state.options.database,
      state.dependencies.databaseRuntime,
    ));
  state.factories.runValues = (context) =>
    createRunValuesRuntime(runValues, context, () => {
      assertCapabilityRuntimeOpen(state.lifecycle);
    });
}

function prepareDataTablesCapability(state: CapabilityAssembly): void {
  const dataTables =
    state.dependencies.dataTables ??
    (state.resources.ownedDataTables = createWorkerDataTablesStore(
      state.options.database,
      state.dependencies.databaseRuntime,
    ));
  state.factories.dataTables = (context) => ({
    execute: ({ command, columnBindings, signal }) => {
      assertCapabilityRuntimeOpen(state.lifecycle);
      return dataTables.execute({
        ...context,
        command,
        ...(columnBindings === undefined ? {} : { columnBindings }),
        signal,
      });
    },
  });
}

function prepareCodeCapability(state: CapabilityAssembly): void {
  const codeClient = state.codeClient;
  if (codeClient !== undefined && state.options.codeRunner !== undefined) {
    const settings = state.options.codeRunner.settings;
    state.factories.code = (context) => ({
      execute: async ({ code, language, timeoutSeconds, input, signal }) => {
        assertCapabilityRuntimeOpen(state.lifecycle);
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
}

function prepareWebhookResponseCapability(state: CapabilityAssembly): void {
  const webhookResponses =
    state.dependencies.webhookResponses ??
    (state.resources.ownedWebhookResponses = createWebhookResponseStore(
      state.options.database,
      state.dependencies.databaseRuntime,
    ));
  state.factories.webhookResponse = (context) => ({
    respond: async ({ response, signal }) => {
      assertCapabilityRuntimeOpen(state.lifecycle);
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
}

function prepareConnectionCapability(state: CapabilityAssembly): void {
  const providerRateLimiter =
    state.dependencies.providerRateLimiter ??
    (state.options.redisUrl === undefined
      ? undefined
      : (state.resources.ownedProviderRateLimiter = new RedisRateLimitRuntime(
          state.options.redisUrl,
        )));
  if (providerRateLimiter === undefined)
    throw new Error('Worker provider rate limiter is incomplete');
  const connectionDatabase =
    state.dependencies.connectionDatabase ??
    (state.resources.ownedConnectionDatabase =
      createWorkerConnectionResolutionDatabase(
        state.options.database,
        state.dependencies.databaseRuntime,
      ));
  const encryption =
    state.dependencies.connectionEncryption ??
    (state.options.connectionEncryption === undefined
      ? undefined
      : (state.resources.encryptionRuntime = createConnectionEnvelopeEncryption(
          state.options.connectionEncryption,
        )).encryption);
  if (encryption === undefined)
    throw new Error('Worker connection capability is incomplete');
  state.factories.connections = createProviderConnectionRuntimeFactory(
    connectionDatabase,
    encryption,
    providerRateLimiter,
  );
}

async function prepareArtifactCapability(
  state: CapabilityAssembly,
): Promise<void> {
  const persistence =
    state.dependencies.artifactPersistence ??
    artifactPersistence(
      (state.resources.ownedArtifactDatabase = createWorkspaceDatabase(
        state.options.database,
        state.dependencies.databaseRuntime === undefined
          ? {}
          : { runtime: state.dependencies.databaseRuntime },
      )),
    );
  const store =
    state.dependencies.artifactStore ??
    (state.options.artifactStore === undefined
      ? undefined
      : (state.resources.ownedArtifactStore = createArtifactStore(
          state.options.artifactStore,
        )));
  if (store === undefined)
    throw new Error('Worker artifact capability is incomplete');
  const readiness = store;
  const checkReadiness = readiness.checkReadiness;
  if (checkReadiness !== undefined)
    state.checkArtifactReadiness = () => checkReadiness.call(readiness);
  const directory =
    state.dependencies.spoolDirectory ?? state.options.artifactScratchDirectory;
  if (directory === undefined)
    throw new Error(
      'Configure ARTIFACT_SCRATCH_DIRECTORY as a private disk-backed directory for this worker.',
    );
  const scratch = await ArtifactScratchSpace.create(
    directory,
    state.dependencies.artifactSpoolOperations,
  );
  const checkStoreReadiness = state.checkArtifactReadiness;
  state.checkArtifactReadiness = async () => {
    scratch.checkReadiness();
    await checkStoreReadiness?.();
  };
  state.factories.artifacts = createNodeArtifactRuntimeFactory({
    assertOpen: () => {
      assertCapabilityRuntimeOpen(state.lifecycle);
    },
    scratch,
    maximumBytes: Math.min(
      FILE_PAGE_LIMITS.fileBytes,
      state.options.artifactStore?.maxObjectBytes ?? FILE_PAGE_LIMITS.fileBytes,
    ),
    persistence,
    store,
    retentionMillis: state.retentionMillis,
    ...(state.dependencies.artifactId === undefined
      ? {}
      : { artifactId: state.dependencies.artifactId }),
    ...(state.dependencies.now === undefined
      ? {}
      : { now: state.dependencies.now }),
  });
}
