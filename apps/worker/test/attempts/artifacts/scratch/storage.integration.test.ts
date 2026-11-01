import { createHash } from 'node:crypto';
import { createHttpRequestExecutorRegistration } from '@pertexo/integrations/server';
import {
  artifactDestinationUrl,
  createArtifactDestination,
} from '../http-destination.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq, getTableName, sql } from 'drizzle-orm';
import {
  createArtifactStore,
  parseArtifactStoreConfig,
} from '@pertexo/artifact-store';
import {
  artifacts as artifactsTable,
  createWorkspaceDatabase,
} from '@pertexo/database/testing';
import type { NodeArtifactReference } from '@pertexo/node-sdk/server';
import { createWorkerNodeRuntimeCapabilities } from '../../../../src/attempts/execution/runtime-capabilities.js';
import { createArtifactDatabaseEnvironment } from '../database.js';
import { runWithCleanup } from '../../../support/infrastructure/test-operation.js';
import { headerConnection } from '../../../support/attempts/header-connection.js';

const integration =
  process.env.ARTIFACT_STORE_INTEGRATION === 'true' &&
  process.env.WORKER_TRANSPORT_INTEGRATION === 'true';

async function* document(size: number, rows: number) {
  let pending = '[';
  let supplied = 1;
  for (let index = 0; index < rows; index++) {
    const row =
      (index ? ',' : '') + JSON.stringify({ id: index, text: 'a'.repeat(75) });
    if (pending.length + row.length > 65_536) {
      yield await Promise.resolve(Buffer.from(pending));
      pending = '';
    }
    pending += row;
    supplied += row.length;
  }
  yield Buffer.from(pending);
  while (supplied < size - 1) {
    const count = Math.min(65_536, size - 1 - supplied);
    yield Buffer.alloc(count, 0x20);
    supplied += count;
  }
  yield Buffer.from(']');
}

(integration ? describe : describe.skip)(
  'F45 real object storage qualification',
  () => {
    it('compares original 1 MiB and proposed 10 MiB files without storing bytes in PostgreSQL', async () => {
      const environment = createArtifactDatabaseEnvironment();
      const config = parseArtifactStoreConfig(process.env);
      const workspaceId = randomUUID();
      const context = {
        workspaceId,
        runId: randomUUID(),
        nodeRunId: randomUUID(),
        attemptId: randomUUID(),
        attemptNumber: 1,
        nodeId: 'qualification',
        invocationKey: 'root:qualification',
        workerId: 'file-qualification',
      };
      let directory: string | undefined;
      let capabilities:
        | Awaited<ReturnType<typeof createWorkerNodeRuntimeCapabilities>>
        | undefined;
      let store: ReturnType<typeof createArtifactStore> | undefined;
      let database: ReturnType<typeof createWorkspaceDatabase> | undefined;
      const references: NodeArtifactReference[] = [];
      let destination:
        Awaited<ReturnType<typeof createArtifactDestination>> | undefined;
      await runWithCleanup(
        async () => {
          await environment.initialize();
          directory = await mkdtemp(
            path.join(tmpdir(), 'pertexo-file-storage-'),
          );
          destination = await createArtifactDestination();
          capabilities = await createWorkerNodeRuntimeCapabilities(
            { database: environment.workerConfig, artifactStore: config },
            { spoolDirectory: directory },
          );
          store = createArtifactStore(config);
          database = createWorkspaceDatabase(environment.apiConfig);
          const artifacts = capabilities.factories.artifacts?.(context);
          if (
            artifacts?.read === undefined ||
            artifacts.openVerified === undefined
          )
            throw new Error('Missing artifact capability');
          const measurements: { bytes: number; recordBytes: number }[] = [];
          for (const [size, rows] of [
            [1_048_576, 10_000],
            [10_485_760, 100_000],
            [10_484_736, 100_000],
          ] as const) {
            const signal = new AbortController().signal;
            const reference = await artifacts.write({
              body: document(size, rows),
              maxBytes: size,
              mediaType: 'application/json',
              purpose: 'node-output',
              signal,
            });
            references.push(reference);
            expect(reference.byteLength).toBe(size);
            const metadata = await database.withWorkspace(
              workspaceId,
              ({ db }) =>
                db
                  .select({
                    recordBytes: sql<number>`pg_column_size(${sql.identifier(getTableName(artifactsTable))}.*)`,
                  })
                  .from(artifactsTable)
                  .where(eq(artifactsTable.id, reference.artifactId)),
            );
            expect(metadata).toHaveLength(1);
            const recordBytes = metadata[0]?.recordBytes;
            if (recordBytes === undefined)
              throw new Error('Missing artifact metadata');
            measurements.push({ bytes: size, recordBytes });
            const download = await store.getStream({
              workspaceId,
              artifactId: reference.artifactId,
              signal,
            });
            expect(download.metadata).toMatchObject({
              workspaceId,
              ...reference,
            });
            download.body.destroy();
            const spool = await artifacts.openVerified({
              reference,
              maxBytes: size,
              signal,
            });
            try {
              expect(spool.byteLength).toBe(size);
              expect(spool.sha256).toBe(reference.sha256);
              const digest = createHash('sha256');
              for await (const value of spool.open(signal)) {
                const chunk: unknown = value;
                if (!(chunk instanceof Uint8Array))
                  throw new Error('Expected file bytes');
                digest.update(chunk);
              }
              expect(digest.digest('hex')).toBe(reference.sha256);
              if (size === 1_048_576) {
                const original = await artifacts.read({
                  reference,
                  maxBytes: size,
                  signal,
                });
                try {
                  expect(original.byteLength).toBe(size);
                } finally {
                  original.fill(0);
                }
              } else {
                await expect(
                  artifacts.read({ reference, maxBytes: 1_048_576, signal }),
                ).rejects.toMatchObject({
                  kind: 'failed',
                  possiblyDispatched: false,
                });
              }
            } finally {
              await spool.release();
            }
            const receiver = destination;
            const executor = createHttpRequestExecutorRegistration({
              httpClient: receiver.httpClient,
            });
            const before = destination.observe().length;
            let dispatched = 0;
            const execute = (multipart: boolean) =>
              executor.execute({
                config: {
                  method: 'POST',
                  url: artifactDestinationUrl,
                  headers: {},
                  timeoutMillis: 10000,
                  maxRedirects: 0,
                  maxResponseBytes: 8192,
                  inlineResponseBytes: 8192,
                  ...(multipart
                    ? {
                        multipart: {
                          parts: [
                            {
                              inputKey:
                                'part_11111111-1111-4111-8111-111111111111',
                              name: 'file',
                              kind: 'file',
                            },
                          ],
                        },
                      }
                    : {}),
                },
                input: multipart
                  ? {
                      'part_11111111-1111-4111-8111-111111111111': {
                        kind: 'artifact',
                        ...reference,
                      },
                    }
                  : { body: { kind: 'artifact', ...reference } },
                connectionRefs: {
                  http_headers: '55555555-5555-4555-8555-555555555555',
                },
                signal,
                runtime: {
                  ...context,
                  artifacts,
                  connections: headerConnection(
                    '55555555-5555-4555-8555-555555555555',
                    '66666666-6666-4666-8666-666666666666',
                    { authorization: receiver.authorization },
                  ),
                  sideEffectClass: 'unsafe',
                  beforeDispatch: () => {
                    dispatched++;
                    return Promise.resolve();
                  },
                },
              });
            await execute(false);
            expect(destination.observe()[before]).toMatchObject({
              byteLength: size,
              sha256: reference.sha256,
              mediaType: 'application/json',
            });
            if (size === 10485760) {
              await expect(execute(true)).rejects.toMatchObject({
                diagnostic: { reason: 'multipart_size' },
              });
              expect(dispatched).toBe(1);
              expect(destination.observe()).toHaveLength(before + 1);
            } else {
              const sent = await execute(true);
              expect(dispatched).toBe(2);
              expect(sent).toMatchObject({
                body: {
                  kind: 'inline',
                  json: {
                    parts: [
                      {
                        name: 'file',
                        byteLength: size,
                        sha256: reference.sha256,
                        contentType: 'application/json',
                      },
                    ],
                  },
                },
              });
            }
          }
          expect(measurements[0]?.recordBytes).toBe(
            measurements[1]?.recordBytes,
          );
          expect(measurements[1]?.recordBytes).toBeLessThan(1024);
          console.info(
            'F45 object sizes and PostgreSQL metadata row sizes',
            measurements,
          );
        },
        async () => {
          const failures: unknown[] = [];
          const clean = async (operation: () => Promise<unknown>) => {
            try {
              await operation();
            } catch (error) {
              failures.push(error);
            }
          };
          for (const reference of references)
            await clean(
              () =>
                store?.delete({
                  workspaceId,
                  artifactId: reference.artifactId,
                }) ?? Promise.resolve(),
            );
          await clean(() => destination?.close() ?? Promise.resolve());
          await clean(() => store?.close() ?? Promise.resolve());
          await clean(() => capabilities?.close() ?? Promise.resolve());
          await clean(() => database?.close() ?? Promise.resolve());
          if (directory !== undefined) {
            const owned = directory;
            await clean(() => rm(owned, { recursive: true, force: true }));
          }
          await clean(() => environment.close());
          if (failures.length > 0)
            throw new AggregateError(
              failures,
              'File storage qualification cleanup failed',
            );
        },
        'File storage qualification',
      );
    });
  },
);
