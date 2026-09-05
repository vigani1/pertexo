import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createDualRegionArtifactStore,
  type ArtifactStore,
  type DualRegionArtifactStoreConfig,
} from '@pertexo/artifact-store';
import {
  artifactStorageKey,
  CONNECTION_AUTH_TYPE,
  ConnectionUnavailableError,
  createWorkerConnectionResolutionDatabase,
  createPendingArtifact,
  createPendingPreviewArtifact,
  createWorkspaceDatabase,
  finalizeArtifactUpload,
  generatePersistedId,
  type ConnectionResolutionDatabase,
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
import {
  ProviderExecutionRateLimitError,
  type NodeArtifactRuntime,
  type NodeConnectionRuntime,
} from '@pertexo/node-sdk/server';
import {
  AbuseRateLimitPolicy,
  RedisRateLimitRuntime,
  type DistributedRateLimitResult,
  type RateLimitDecision,
} from '@pertexo/rate-limit';

import type {
  NodeAttemptCapabilityContext,
  NodeAttemptRuntimeCapabilityFactories,
} from './node-attempt-handler.js';

const DEFAULT_ARTIFACT_RETENTION_MILLIS = 30 * 24 * 60 * 60_000;

export type WorkerNodeRuntimeCapabilityOptions = Readonly<{
  database: DatabaseConfig;
  connectionEncryption?: AwsConnectionEnvelopeEncryptionConfig;
  artifactStore?: DualRegionArtifactStoreConfig;
  artifactRetentionMillis?: number;
  redisUrl?: string;
}>;

export type WorkerNodeRuntimeCapabilityDependencies = Readonly<{
  databaseRuntime?: DatabaseRuntime;
  connectionDatabase?: ConnectionResolutionDatabase;
  connectionEncryption?: Pick<ConnectionEnvelopeEncryption, 'open'>;
  artifactPersistence?: WorkerArtifactPersistence;
  artifactStore?: Pick<ArtifactStore, 'put'> &
    Partial<Pick<ArtifactStore, 'checkReadiness'>>;
  artifactId?: () => string;
  now?: () => Date;
  spoolDirectory?: string;
  providerRateLimiter?: Readonly<{
    consume(decision: RateLimitDecision): Promise<DistributedRateLimitResult>;
  }>;
}>;

export type WorkerNodeRuntimeCapabilities = Readonly<{
  factories: NodeAttemptRuntimeCapabilityFactories;
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}>;

type ArtifactDescriptor = Readonly<{
  artifactId: string;
  workspaceId: string;
  byteLength: number;
  mediaType: string;
  sha256: string;
  storageKey: string;
  previewRunId?: string;
}>;

interface WorkerArtifactPersistence {
  createPending(
    input: ArtifactDescriptor &
      Readonly<{ expiresAt: Date; purpose: string; signal: AbortSignal }>,
  ): Promise<void>;
  finalize(
    input: ArtifactDescriptor & Readonly<{ signal: AbortSignal }>,
  ): Promise<void>;
}
function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function connectionFactory(
  database: ConnectionResolutionDatabase,
  encryption: Pick<ConnectionEnvelopeEncryption, 'open'>,
  providerRateLimiter: NonNullable<
    WorkerNodeRuntimeCapabilityDependencies['providerRateLimiter']
  >,
): (context: NodeAttemptCapabilityContext) => NodeConnectionRuntime {
  return (context) =>
    Object.freeze({
      resolve: async (
        input: Parameters<NodeConnectionRuntime['resolve']>[0],
      ) => {
        assertNotAborted(input.signal);
        const admission = await providerRateLimiter.consume(
          new AbuseRateLimitPolicy().evaluate('provider_execution', {
            workspaceId: context.workspaceId,
            connectionId: input.connectionId,
          }),
        );
        if (!admission.allowed)
          throw new ProviderExecutionRateLimitError(
            admission.retryAfterSeconds,
          );
        const resolved = await database.resolveConnectionSecret({
          workspaceId: context.workspaceId,
          connectionId: input.connectionId,
          expectedProviderKey: input.expectedProviderKey,
          workerId: context.workerId,
          purpose: input.purpose,
        });
        if (
          resolved.connection.authType !== input.expectedAuthType ||
          resolved.connection.id !== input.connectionId ||
          resolved.connection.workspaceId !== context.workspaceId
        )
          throw new ConnectionUnavailableError(
            'Connection is not compatible with this executor',
          );
        const secret = await encryption.open(
          resolved.sealed,
          {
            workspaceId: context.workspaceId,
            connectionId: input.connectionId,
            secretVersionId: resolved.secretVersionId,
          },
          input.signal,
        );
        if (input.signal.aborted) {
          secret.fill(0);
          throw abortError();
        }
        return Object.freeze({
          connectionId: resolved.connection.id,
          providerKey: resolved.connection.providerKey,
          authType: resolved.connection.authType,
          secretVersionId: resolved.secretVersionId,
          secret,
        });
      },
      assertCurrent: async (
        input: Parameters<
          NonNullable<NodeConnectionRuntime['assertCurrent']>
        >[0],
      ): Promise<void> => {
        assertNotAborted(input.signal);
        if (
          input.expectedAuthType !== CONNECTION_AUTH_TYPE.httpHeaders &&
          input.expectedAuthType !== CONNECTION_AUTH_TYPE.slackBotToken &&
          input.expectedAuthType !== CONNECTION_AUTH_TYPE.resendApiKey
        )
          throw new ConnectionUnavailableError(
            'Connection auth type is not supported',
          );
        await database.assertConnectionSecretCurrent({
          workspaceId: context.workspaceId,
          connectionId: input.connectionId,
          expectedProviderKey: input.expectedProviderKey,
          expectedAuthType: input.expectedAuthType,
          secretVersionId: input.secretVersionId,
        });
        assertNotAborted(input.signal);
      },
    });
}

async function writeAll(
  file: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await file.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null,
    );
    if (result.bytesWritten <= 0)
      throw new Error('Artifact spool made no write progress');
    offset += result.bytesWritten;
  }
}

function artifactFactory(
  persistence: WorkerArtifactPersistence,
  store: Pick<ArtifactStore, 'put'>,
  retentionMillis: number,
  artifactId: () => string,
  now: () => Date,
  spoolDirectory: string,
): (context: NodeAttemptCapabilityContext) => NodeArtifactRuntime {
  return (context) =>
    Object.freeze({
      write: async (input: Parameters<NodeArtifactRuntime['write']>[0]) => {
        if (
          !Number.isSafeInteger(input.maxBytes) ||
          input.maxBytes < 1 ||
          input.maxBytes > 10_485_760
        )
          throw new TypeError('Node artifact byte limit is invalid');
        assertNotAborted(input.signal);
        const directory = await mkdtemp(
          path.join(spoolDirectory, 'pertexo-node-artifact-'),
        );
        const spoolPath = path.join(directory, 'body');
        const digest = createHash('sha256');
        let byteLength = 0;
        try {
          const file = await open(spoolPath, 'wx', 0o600);
          try {
            for await (const chunk of input.body) {
              assertNotAborted(input.signal);
              byteLength += chunk.byteLength;
              if (byteLength > input.maxBytes)
                throw new RangeError('Node artifact exceeds its byte limit');
              try {
                digest.update(chunk);
                await writeAll(file, chunk);
              } finally {
                chunk.fill(0);
              }
            }
            await file.sync();
          } finally {
            await file.close();
          }
          assertNotAborted(input.signal);
          const id = artifactId();
          const sha256 = digest.digest('hex');
          const storageKey = artifactStorageKey(context.workspaceId, id);
          const createdAt = now();
          const defaultExpiry = new Date(createdAt.getTime() + retentionMillis);
          const retentionDeadline = context.artifactRetentionDeadline;
          if (
            retentionDeadline !== undefined &&
            !Number.isFinite(retentionDeadline.getTime())
          )
            throw new TypeError('Artifact retention deadline is invalid');
          const expiresAt =
            retentionDeadline !== undefined &&
            retentionDeadline.getTime() < defaultExpiry.getTime()
              ? new Date(retentionDeadline.getTime())
              : defaultExpiry;
          if (expiresAt.getTime() <= createdAt.getTime())
            throw new RangeError('Artifact retention deadline has expired');
          await persistence.createPending({
            artifactId: id,
            workspaceId: context.workspaceId,
            byteLength,
            mediaType: input.mediaType,
            sha256,
            storageKey,
            expiresAt,
            purpose: input.purpose,
            ...(context.previewRunId === undefined
              ? {}
              : { previewRunId: context.previewRunId }),
            signal: input.signal,
          });
          const uploaded = await store.put({
            artifactId: id,
            workspaceId: context.workspaceId,
            byteLength,
            mediaType: input.mediaType,
            sha256,
            body: createReadStream(spoolPath),
            signal: input.signal,
          });
          if (
            uploaded.artifactId !== id ||
            uploaded.workspaceId !== context.workspaceId ||
            uploaded.byteLength !== byteLength ||
            uploaded.mediaType !== input.mediaType ||
            uploaded.sha256 !== sha256
          )
            throw new Error('Artifact store returned incompatible metadata');
          await persistence.finalize({
            artifactId: id,
            workspaceId: context.workspaceId,
            byteLength,
            mediaType: input.mediaType,
            sha256,
            storageKey,
            signal: input.signal,
          });
          return Object.freeze({
            artifactId: id,
            byteLength,
            mediaType: input.mediaType,
            sha256,
          });
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    });
}

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
    retentionMillis < 60_000 ||
    retentionMillis > 365 * 24 * 60 * 60_000
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
    connections?: NonNullable<
      NodeAttemptRuntimeCapabilityFactories['connections']
    >;
    artifacts?: NonNullable<NodeAttemptRuntimeCapabilityFactories['artifacts']>;
  } = {};
  let closePromise: Promise<void> | undefined;
  let checkArtifactReadiness: (() => Promise<unknown>) | undefined;
  const closeOwnedResources = (): Promise<void> => {
    closePromise ??= (async (): Promise<void> => {
      const results = await Promise.allSettled([
        ownedConnectionDatabase?.close(),
        ownedArtifactDatabase?.close(),
        Promise.resolve(encryptionRuntime?.close()),
        Promise.resolve(ownedArtifactStore?.close()),
        ownedProviderRateLimiter?.close(),
      ]);
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      );
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          'Worker node runtime capability shutdown failed',
        );
    })();
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
      factories.connections = connectionFactory(
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
      factories.artifacts = artifactFactory(
        persistence,
        store,
        retentionMillis,
        dependencies.artifactId ?? generatePersistedId,
        dependencies.now ?? (() => new Date()),
        dependencies.spoolDirectory ?? tmpdir(),
      );
    }
  } catch (error: unknown) {
    await closeOwnedResources().catch(() => undefined);
    throw error;
  }

  return Object.freeze({
    factories: Object.freeze(factories),
    checkReadiness: async (): Promise<void> => {
      await checkArtifactReadiness?.();
    },
    close: closeOwnedResources,
  });
}
