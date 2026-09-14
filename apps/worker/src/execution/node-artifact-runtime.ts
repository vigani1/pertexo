import { createHash } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ArtifactStore } from '@pertexo/artifact-store';
import {
  artifactStorageKey,
  generatePersistedId,
} from '@pertexo/database/execution';
import type { NodeArtifactRuntime } from '@pertexo/node-sdk/server';

import type { NodeExecutionCapabilityContext } from './node-execution-capabilities.js';
import {
  artifactExpiry,
  assertArtifactByteLimit,
  assertUploadedArtifactMatches,
} from './node-artifact-policy.js';

type ArtifactDescriptor = Readonly<{
  artifactId: string;
  workspaceId: string;
  byteLength: number;
  mediaType: string;
  sha256: string;
  storageKey: string;
  previewRunId?: string;
}>;

export interface WorkerArtifactPersistence {
  createPending(
    input: ArtifactDescriptor &
      Readonly<{ expiresAt: Date; purpose: string; signal: AbortSignal }>,
  ): Promise<void>;
  finalize(
    input: ArtifactDescriptor & Readonly<{ signal: AbortSignal }>,
  ): Promise<void>;
}

export type ArtifactSpoolOperations = Readonly<{
  openFile(path: string): ReturnType<typeof open>;
  removeDirectory(path: string): Promise<void>;
}>;

type SpooledArtifact = Readonly<{
  byteLength: number;
  sha256: string;
}>;

type OwnedArtifactIterator = AsyncIterator<Uint8Array>;

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

async function completeWithCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
  combinedFailureMessage: string,
): Promise<T> {
  let result: T | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    if (operationFailed)
      throw new AggregateError(
        [operationError, cleanupError],
        combinedFailureMessage,
      );
    throw cleanupError instanceof Error
      ? cleanupError
      : new Error('Artifact cleanup failed with a non-Error value', {
          cause: cleanupError,
        });
  }
  if (operationFailed)
    throw operationError instanceof Error
      ? operationError
      : new Error('Artifact operation failed with a non-Error value', {
          cause: operationError,
        });
  return result as T;
}

function requestIteratorReturn(
  iterator: OwnedArtifactIterator,
  current: Promise<IteratorResult<Uint8Array>> | undefined,
): Promise<IteratorResult<Uint8Array>> | undefined {
  const returnIterator = iterator.return?.bind(iterator);
  if (current !== undefined || returnIterator === undefined) return current;
  const requested = Promise.resolve().then(() => returnIterator());
  void requested.catch(() => undefined);
  return requested;
}

async function consumeArtifactChunks(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  consume: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  const iterator = body[Symbol.asyncIterator]();
  let iteratorDone = false;
  let iteratorReturn: Promise<IteratorResult<Uint8Array>> | undefined;
  const returnOnAbort = (): void => {
    iteratorReturn = requestIteratorReturn(iterator, iteratorReturn);
  };
  signal.addEventListener('abort', returnOnAbort, { once: true });
  await completeWithCleanup(
    async () => {
      for (;;) {
        const result = await iterator.next();
        if (result.done) {
          iteratorDone = true;
          assertNotAborted(signal);
          return;
        }
        const chunk = result.value;
        try {
          assertNotAborted(signal);
          await consume(chunk);
        } finally {
          chunk.fill(0);
        }
      }
    },
    async () => {
      signal.removeEventListener('abort', returnOnAbort);
      if (!iteratorDone)
        iteratorReturn = requestIteratorReturn(iterator, iteratorReturn);
      await iteratorReturn;
    },
    'Artifact source iteration and cancellation both failed',
  );
}

function ownArtifactUploadStream(stream: ReadStream): Readonly<{
  close(): Promise<void>;
  stream: ReadStream;
}> {
  let failed = false;
  let failure: unknown;
  const closed = new Promise<void>((resolve) => {
    stream.once('close', resolve);
  });
  stream.on('error', (error: unknown) => {
    if (!failed) {
      failed = true;
      failure = error;
    }
  });
  return Object.freeze({
    stream,
    close: async (): Promise<void> => {
      if (!stream.destroyed) stream.destroy();
      if (!stream.closed) await closed;
      if (failed) throw failure;
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

async function spoolArtifactBody(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
  spoolPath: string,
  openFile: ArtifactSpoolOperations['openFile'],
): Promise<SpooledArtifact> {
  const digest = createHash('sha256');
  let byteLength = 0;
  const file = await openFile(spoolPath);
  await completeWithCleanup(
    async () => {
      await consumeArtifactChunks(body, signal, async (chunk) => {
        const nextByteLength = byteLength + chunk.byteLength;
        if (nextByteLength > maxBytes)
          throw new RangeError('Node artifact exceeds its byte limit');
        byteLength = nextByteLength;
        digest.update(chunk);
        await writeAll(file, chunk);
      });
      assertNotAborted(signal);
      await file.sync();
    },
    () => file.close(),
    'Artifact spool write and file close both failed',
  );
  return Object.freeze({ byteLength, sha256: digest.digest('hex') });
}

export function createNodeArtifactRuntimeFactory(
  input: Readonly<{
    persistence: WorkerArtifactPersistence;
    store: Pick<ArtifactStore, 'put'>;
    retentionMillis: number;
    artifactId?: () => string;
    now?: () => Date;
    spoolDirectory?: string;
    spoolOperations?: ArtifactSpoolOperations;
  }>,
): (context: NodeExecutionCapabilityContext) => NodeArtifactRuntime {
  const artifactId = input.artifactId ?? generatePersistedId;
  const now = input.now ?? (() => new Date());
  const spoolDirectory = input.spoolDirectory ?? tmpdir();
  const spoolOperations = input.spoolOperations ?? {
    openFile: (filePath: string) => open(filePath, 'wx', 0o600),
    removeDirectory: (directory: string) =>
      rm(directory, { recursive: true, force: true }),
  };
  return (context) =>
    Object.freeze({
      write: async (
        writeInput: Parameters<NodeArtifactRuntime['write']>[0],
      ) => {
        assertArtifactByteLimit(writeInput.maxBytes);
        assertNotAborted(writeInput.signal);
        const directory = await mkdtemp(
          path.join(spoolDirectory, 'pertexo-node-artifact-'),
        );
        const spoolPath = path.join(directory, 'body');
        return completeWithCleanup(
          async () => {
            const spooled = await spoolArtifactBody(
              writeInput.body,
              writeInput.maxBytes,
              writeInput.signal,
              spoolPath,
              spoolOperations.openFile,
            );
            assertNotAborted(writeInput.signal);
            const id = artifactId();
            const storageKey = artifactStorageKey(context.workspaceId, id);
            const createdAt = now();
            const descriptor: ArtifactDescriptor = Object.freeze({
              artifactId: id,
              workspaceId: context.workspaceId,
              byteLength: spooled.byteLength,
              mediaType: writeInput.mediaType,
              sha256: spooled.sha256,
              storageKey,
              ...(context.previewRunId === undefined
                ? {}
                : { previewRunId: context.previewRunId }),
            });
            await input.persistence.createPending({
              ...descriptor,
              expiresAt: artifactExpiry(
                createdAt,
                input.retentionMillis,
                context.artifactRetentionDeadline,
              ),
              purpose: writeInput.purpose,
              signal: writeInput.signal,
            });
            assertNotAborted(writeInput.signal);
            const upload = ownArtifactUploadStream(createReadStream(spoolPath));
            const uploaded = await completeWithCleanup(
              () =>
                input.store.put({
                  artifactId: descriptor.artifactId,
                  workspaceId: descriptor.workspaceId,
                  byteLength: descriptor.byteLength,
                  mediaType: descriptor.mediaType,
                  sha256: descriptor.sha256,
                  body: upload.stream,
                  signal: writeInput.signal,
                }),
              upload.close,
              'Artifact upload and source stream cleanup both failed',
            );
            assertNotAborted(writeInput.signal);
            assertUploadedArtifactMatches(uploaded, descriptor);
            await input.persistence.finalize({
              artifactId: descriptor.artifactId,
              workspaceId: descriptor.workspaceId,
              byteLength: descriptor.byteLength,
              mediaType: descriptor.mediaType,
              sha256: descriptor.sha256,
              storageKey: descriptor.storageKey,
              signal: writeInput.signal,
            });
            return Object.freeze({
              artifactId: id,
              byteLength: spooled.byteLength,
              mediaType: writeInput.mediaType,
              sha256: spooled.sha256,
            });
          },
          () => spoolOperations.removeDirectory(directory),
          'Artifact write failed and spool cleanup was incomplete',
        );
      },
    });
}
