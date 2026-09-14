import {
  createDualRegionArtifactStore,
  type ArtifactStore,
  type DualRegionArtifactStoreConfig,
} from '@pertexo/artifact-store';
import {
  createWorkerConnectionResolutionDatabase,
  createPendingArtifact,
  createPendingPreviewArtifact,
  createWorkspaceDatabase,
  finalizeArtifactUpload,
  type WorkerConnectionResolutionDatabase,
  type DatabaseConfig,
  type DatabaseRuntime,
  type WorkspaceDatabase,
} from '@pertexo/database/execution';
import {
  createAwsConnectionEnvelopeEncryption,
  type AwsConnectionEnvelopeEncryptionConfig,
  type AwsConnectionEnvelopeEncryptionRuntime,
  type ConnectionEnvelopeEncryption,
} from '@pertexo/integrations/server';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit';

import type { NodeExecutionCapabilityFactories } from './node-execution-capabilities.js';
import {
  createProviderConnectionRuntimeFactory,
  type ProviderRateLimiter,
} from './provider-connection-runtime.js';
import {
  MAXIMUM_ARTIFACT_RETENTION_MILLIS,
  MINIMUM_ARTIFACT_RETENTION_MILLIS,
} from './node-artifact-policy.js';
import {
  createNodeArtifactRuntimeFactory,
  type ArtifactSpoolOperations,
  type WorkerArtifactPersistence,
} from './node-artifact-runtime.js';

const DEFAULT_ARTIFACT_RETENTION_MILLIS = 30 * 24 * 60 * 60_000;

function assertCapabilityRuntimeOpen(lifecycle: { terminal: boolean }): void {
  if (lifecycle.terminal)
    throw new Error('Worker node runtime capabilities are closed');
}

export type WorkerNodeRuntimeCapabilityOptions = Readonly<{
  database: DatabaseConfig;
  connectionEncryption?: AwsConnectionEnvelopeEncryptionConfig;
  artifactStore?: DualRegionArtifactStoreConfig;
  artifactRetentionMillis?: number;
  redisUrl?: string;
}>;

export type WorkerNodeRuntimeCapabilityDependencies = Readonly<{
  databaseRuntime?: DatabaseRuntime;
  connectionDatabase?: Parameters<
    typeof createProviderConnectionRuntimeFactory
  >[0];
  connectionEncryption?: Pick<ConnectionEnvelopeEncryption, 'open'>;
  artifactPersistence?: WorkerArtifactPersistence;
  artifactStore?: Pick<ArtifactStore, 'put'> &
    Partial<Pick<ArtifactStore, 'checkReadiness'>>;
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
  if (
    !Number.isSafeInteger(retentionMillis) ||
    retentionMillis < MINIMUM_ARTIFACT_RETENTION_MILLIS ||
    retentionMillis > MAXIMUM_ARTIFACT_RETENTION_MILLIS
  )
    throw new TypeError('Node artifact retention is invalid');

  let encryptionRuntime: AwsConnectionEnvelopeEncryptionRuntime | undefined;
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

  const factories: {
    connections?: NonNullable<NodeExecutionCapabilityFactories['connections']>;
    artifacts?: NonNullable<NodeExecutionCapabilityFactories['artifacts']>;
  } = {};
  let closePromise: Promise<void> | undefined;
  const lifecycle = { terminal: false };
  let checkArtifactReadiness: (() => Promise<unknown>) | undefined;
  const closeOwnedResources = (): Promise<void> => {
    if (closePromise === undefined) {
      lifecycle.terminal = true;
      closePromise = (async (): Promise<void> => {
        const closeOperations = [
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
          : (encryptionRuntime = createAwsConnectionEnvelopeEncryption(
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
          : (ownedArtifactStore = createDualRegionArtifactStore(
              options.artifactStore.primary,
              options.artifactStore.recovery,
            )));
      if (store === undefined)
        throw new Error('Worker artifact capability is incomplete');
      const readiness = store;
      const checkReadiness = readiness.checkReadiness;
      if (checkReadiness !== undefined)
        checkArtifactReadiness = () => checkReadiness.call(readiness);
      factories.artifacts = createNodeArtifactRuntimeFactory({
        persistence,
        store,
        retentionMillis,
        ...(dependencies.artifactId === undefined
          ? {}
          : { artifactId: dependencies.artifactId }),
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        ...(dependencies.spoolDirectory === undefined
          ? {}
          : { spoolDirectory: dependencies.spoolDirectory }),
        ...(dependencies.artifactSpoolOperations === undefined
          ? {}
          : { spoolOperations: dependencies.artifactSpoolOperations }),
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
