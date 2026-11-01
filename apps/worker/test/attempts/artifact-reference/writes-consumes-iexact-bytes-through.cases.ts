import { createArtifactDatabaseEnvironment } from '../artifacts/database.js';
import { createHttpRequestExecutorRegistration } from '@pertexo/integrations/server';
import {
  artifactDestinationUrl,
  createArtifactDestination,
} from '../artifacts/http-destination.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  createArtifactStore,
  parseArtifactStoreConfig,
} from '@pertexo/artifact-store';
import {
  artifacts as artifactsTable,
  createWorkspaceDatabase,
} from '@pertexo/database/testing';

import type { NodeArtifactReference } from '@pertexo/node-sdk/server';
import { eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';

import { createWorkerNodeRuntimeCapabilities } from '../../../src/attempts/execution/runtime-capabilities.js';
import { runWithCleanup } from '../../support/infrastructure/test-operation.js';
import { headerConnection } from '../../support/attempts/header-connection.js';

export function registerWritesConsumesIExactBytesThrough(): void {
  it.each([70_000, 1_048_576])(
    'writes and consumes %i exact bytes through real worker, metadata and storage adapters',
    async (size) => {
      const databaseEnvironment = createArtifactDatabaseEnvironment();
      const artifactConfig = parseArtifactStoreConfig(process.env);
      const workspaceId = randomUUID();
      const context = {
        workspaceId,
        runId: randomUUID(),
        nodeRunId: randomUUID(),
        attemptId: randomUUID(),
        attemptNumber: 1,
        nodeId: 'http-node',
        invocationKey: 'http-invocation',
        workerId: 'worker-artifact-integration',
      } as const;
      const firstSize = Math.floor((size * 4) / 7);
      const secondSize = size - firstSize;
      const first = Buffer.alloc(firstSize, 7);
      const second = Buffer.alloc(secondSize, 9);
      let runtime:
        | Awaited<ReturnType<typeof createWorkerNodeRuntimeCapabilities>>
        | undefined;
      let verifier: ReturnType<typeof createArtifactStore> | undefined;
      let database: ReturnType<typeof createWorkspaceDatabase> | undefined;
      let reference: NodeArtifactReference | undefined;
      await runWithCleanup(
        async () => {
          await databaseEnvironment.initialize();
          runtime = await createWorkerNodeRuntimeCapabilities({
            database: databaseEnvironment.workerConfig,
            artifactScratchDirectory:
              databaseEnvironment.artifactScratchDirectory,
            artifactStore: artifactConfig,
          });
          verifier = createArtifactStore(artifactConfig);
          database = createWorkspaceDatabase(databaseEnvironment.apiConfig);
          const artifacts = runtime.factories.artifacts?.(context);
          if (artifacts === undefined)
            throw new Error('artifact capability missing');
          const writtenReference = await artifacts.write({
            body: (async function* (): AsyncGenerator<Uint8Array> {
              await Promise.resolve();
              yield first;
              yield second;
            })(),
            maxBytes: size,
            mediaType: 'application/octet-stream',
            purpose: 'node-output',
            signal: new AbortController().signal,
          });
          reference = writtenReference;
          expect(writtenReference.byteLength).toBe(size);
          expect(writtenReference.sha256).toBe(
            createHash('sha256')
              .update(Buffer.alloc(firstSize, 7))
              .update(Buffer.alloc(secondSize, 9))
              .digest('hex'),
          );
          const rows = await database.withWorkspace(workspaceId, ({ db }) =>
            db
              .select({ status: artifactsTable.status })
              .from(artifactsTable)
              .where(eq(artifactsTable.id, writtenReference.artifactId)),
          );
          expect(rows).toEqual([{ status: 'available' }]);
          const download = await verifier.getStream({
            artifactId: writtenReference.artifactId,
            workspaceId,
          });
          const downloaded: Buffer[] = [];
          for await (const chunk of download.body) {
            const value: unknown = chunk;
            if (!(value instanceof Uint8Array))
              throw new TypeError('artifact download chunk is not bytes');
            downloaded.push(Buffer.from(value));
          }
          expect(
            Buffer.concat(downloaded).equals(
              Buffer.concat([
                Buffer.alloc(firstSize, 7),
                Buffer.alloc(secondSize, 9),
              ]),
            ),
          ).toBe(true);
          if (artifacts.read === undefined)
            throw new Error('Artifact read capability missing');
          const readStarted = performance.now();
          const memoryBeforeRead = process.memoryUsage();
          const readBytes = await artifacts.read({
            reference: writtenReference,
            maxBytes: 1048576,
            signal: new AbortController().signal,
          });
          expect(
            Buffer.from(readBytes).equals(
              Buffer.concat([
                Buffer.alloc(firstSize, 7),
                Buffer.alloc(secondSize, 9),
              ]),
            ),
          ).toBe(true);
          process.stdout.write(
            JSON.stringify({
              artifactReadBytes: size,
              readMillis: performance.now() - readStarted,
              retainedArrayBufferDelta:
                process.memoryUsage().arrayBuffers -
                memoryBeforeRead.arrayBuffers,
              processMaximumRssKiB: process.resourceUsage().maxRSS,
            }) + '\n',
          );
          await expect(
            artifacts.read({
              reference: { ...writtenReference, sha256: 'b'.repeat(64) },
              maxBytes: 1048576,
              signal: new AbortController().signal,
            }),
          ).rejects.toMatchObject({
            kind: 'failed',
            possiblyDispatched: false,
          });
          const foreign = runtime.factories.artifacts?.({
            ...context,
            workspaceId: randomUUID(),
          });
          if (foreign?.read === undefined)
            throw new Error('Foreign-context capability missing');
          await expect(
            foreign.read({
              reference: writtenReference,
              maxBytes: 1048576,
              signal: new AbortController().signal,
            }),
          ).rejects.toMatchObject({
            kind: 'failed',
            possiblyDispatched: false,
          });
          const destination = await createArtifactDestination();
          try {
            const connectionId = randomUUID();
            const beforeDispatch = vi.fn().mockResolvedValue(undefined);
            const result = await createHttpRequestExecutorRegistration({
              httpClient: destination.httpClient,
            }).execute({
              config: {
                method: 'POST',
                url: artifactDestinationUrl,
                headers: {},
                timeoutMillis: 5000,
                maxRedirects: 0,
                maxResponseBytes: 1024,
                inlineResponseBytes: 1024,
              },
              input: { body: { kind: 'artifact', ...writtenReference } },
              connectionRefs: { http_headers: connectionId },
              signal: new AbortController().signal,
              runtime: {
                ...context,
                sideEffectClass: 'unsafe',
                artifacts,
                beforeDispatch,
                connections: headerConnection(connectionId, randomUUID(), {
                  authorization: destination.authorization,
                }),
              },
            });
            expect(result).toMatchObject({ status: 200 });
            expect(destination.observe()).toEqual([
              {
                byteLength: size,
                sha256: writtenReference.sha256,
                mediaType: writtenReference.mediaType,
              },
            ]);
            expect(beforeDispatch).toHaveBeenCalledOnce();
          } finally {
            await destination.close();
          }
          readBytes.fill(0);
          expect(first.every((byte) => byte === 0)).toBe(true);
          expect(second.every((byte) => byte === 0)).toBe(true);
        },
        async () => {
          const errors: unknown[] = [];
          const attempt = async (operation: () => unknown): Promise<void> => {
            await Promise.resolve()
              .then(operation)
              .catch((error: unknown) => errors.push(error));
          };
          const ownedReference = reference;
          if (ownedReference !== undefined)
            await attempt(() =>
              verifier?.delete({
                artifactId: ownedReference.artifactId,
                workspaceId,
              }),
            );
          await attempt(() => verifier?.close());
          await attempt(() => runtime?.close());
          await attempt(() => database?.close());
          await attempt(() => databaseEnvironment.close());
          if (errors.length > 0)
            throw new AggregateError(
              errors,
              'Worker artifact output cleanup failed',
            );
        },
        'Worker artifact output',
      );
    },
    30_000,
  );
}
