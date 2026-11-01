import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createArtifactStore,
  parseArtifactStoreConfig,
} from '@pertexo/artifact-store';
import {
  artifacts as artifactsTable,
  createWorkspaceDatabase,
} from '@pertexo/database/testing';
import { createHttpRequestExecutorRegistration } from '@pertexo/integrations/server';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import type {
  NodeArtifactReference,
  NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import { eq } from 'drizzle-orm';
import { createWorkerNodeRuntimeCapabilities } from '../../../src/attempts/execution/runtime-capabilities.js';
import { runWithCleanup } from '../../support/infrastructure/test-operation.js';
import { createArtifactDatabaseEnvironment } from './database.js';
import {
  artifactDestinationUrl,
  createArtifactDestination,
} from './http-destination.js';
import { headerConnection } from '../../support/attempts/header-connection.js';

const integration =
  process.env.ARTIFACT_STORE_INTEGRATION === 'true' &&
  process.env.WORKER_TRANSPORT_INTEGRATION === 'true';
(integration ? describe : describe.skip)(
  'Create file with real worker storage and a local destination',
  () => {
    it('creates retained CSV, reads and summarizes it, then sends the exact file in multipart', async () => {
      const environment = createArtifactDatabaseEnvironment();
      const config = parseArtifactStoreConfig(process.env);
      const artifactId = randomUUID(),
        workspaceId = randomUUID();
      const deadline = new Date(Date.now() + 600_000);
      const context = {
        workspaceId,
        runId: randomUUID(),
        nodeRunId: randomUUID(),
        attemptId: randomUUID(),
        attemptNumber: 1,
        nodeId: 'create',
        invocationKey: 'root:create',
        workerId: 'create-file-qualification',
        artifactRetentionDeadline: deadline,
      };
      let capabilities:
        | Awaited<ReturnType<typeof createWorkerNodeRuntimeCapabilities>>
        | undefined;
      let store: ReturnType<typeof createArtifactStore> | undefined;
      let database: ReturnType<typeof createWorkspaceDatabase> | undefined;
      let destination:
        Awaited<ReturnType<typeof createArtifactDestination>> | undefined;
      await runWithCleanup(
        async () => {
          await environment.initialize();
          capabilities = await createWorkerNodeRuntimeCapabilities(
            {
              database: environment.workerConfig,
              artifactScratchDirectory: environment.artifactScratchDirectory,
              artifactStore: config,
            },
            { artifactId: () => artifactId },
          );
          store = createArtifactStore(config);
          database = createWorkspaceDatabase(environment.apiConfig);
          const artifacts = capabilities.factories.artifacts?.(context);
          if (artifacts?.read === undefined)
            throw new Error('Missing file capabilities');
          const beforeDispatch = vi.fn().mockResolvedValue(undefined);
          const runtime: NodeExecutionRuntime = {
            ...context,
            artifacts,
            sideEffectClass: 'safe',
            beforeDispatch,
          };
          const registry = createPlatformNodeRegistry();
          const signal = new AbortController().signal;
          const identity = (key: string) => ({ key, version: 1 });
          const data = [
            { currency: 'EUR', amount: 12.5, paid: true },
            { currency: 'EUR', amount: 7.5, paid: true },
            { currency: 'USD', amount: 9, paid: false },
          ];
          const created = await registry.execute({
            definition: identity('core.create_file'),
            executor: identity('core.create_file'),
            config: {
              format: 'csv',
              delimiter: ',',
              columns: ['currency', 'amount', 'paid'],
            },
            input: { data },
            runtime,
            signal,
          });
          if (created.kind !== 'succeeded')
            throw new Error('Create file did not succeed');
          const file = (
            created.output as {
              file: NodeArtifactReference & { kind: 'artifact' };
            }
          ).file;
          const expected = Buffer.from(
            '"currency","amount","paid"\r\n"EUR","12.5","true"\r\n"EUR","7.5","true"\r\n"USD","9","false"\r\n',
          );
          expect(file).toMatchObject({
            artifactId,
            byteLength: expected.length,
            mediaType: 'text/csv; charset=utf-8',
            sha256: createHash('sha256').update(expected).digest('hex'),
          });
          expect(
            await database.withWorkspace(workspaceId, ({ db }) =>
              db
                .select({
                  status: artifactsTable.status,
                  expiresAt: artifactsTable.expiresAt,
                })
                .from(artifactsTable)
                .where(eq(artifactsTable.id, artifactId)),
            ),
          ).toEqual([{ status: 'available', expiresAt: deadline }]);
          const read = await registry.execute({
            definition: identity('core.read_file'),
            executor: identity('core.read_file'),
            config: { format: 'csv', delimiter: ',', convertValues: true },
            input: { file },
            runtime,
            signal,
          });
          expect(read).toEqual({ kind: 'succeeded', output: data });
          if (read.kind !== 'succeeded')
            throw new Error('Read file did not succeed');
          const filtered = await registry.execute({
            definition: identity('core.filter'),
            executor: identity('core.filter'),
            config: { path: '$.paid', operator: 'equals' },
            input: { items: read.output, value: true },
            runtime,
            signal,
          });
          if (filtered.kind !== 'succeeded')
            throw new Error('Filter did not succeed');
          const summary = await registry.execute({
            definition: identity('core.summarize'),
            executor: identity('core.summarize'),
            config: {
              valuePath: '$.amount',
              groupBy: '$.currency',
              missing: 'error',
            },
            input: { items: (filtered.output as { items: unknown }).items },
            runtime,
            signal,
          });
          if (summary.kind !== 'succeeded')
            throw new Error('Summarize did not succeed');
          expect(
            await registry.execute({
              definition: identity('core.terminate'),
              executor: identity('core.terminate'),
              config: {},
              input: summary.output,
              runtime,
              signal,
            }),
          ).toMatchObject({
            kind: 'terminal_success',
            output: { groups: [{ key: 'EUR', sum: 20, count: 2 }] },
          });
          expect(beforeDispatch).not.toHaveBeenCalled();
          const { kind: _kind, ...reference } = file;
          await expect(
            artifacts.read({
              reference: { ...reference, sha256: 'b'.repeat(64) },
              maxBytes: 1048576,
              signal,
            }),
          ).rejects.toMatchObject({
            kind: 'failed',
            possiblyDispatched: false,
          });
          const foreign = capabilities.factories.artifacts?.({
            ...context,
            workspaceId: randomUUID(),
          });
          if (foreign?.read === undefined)
            throw new Error('Missing scoped file reader');
          await expect(
            foreign.read({ reference, maxBytes: 1048576, signal }),
          ).rejects.toMatchObject({
            kind: 'failed',
            possiblyDispatched: false,
          });
          destination = await createArtifactDestination();
          const ownedDestination = destination;
          const connectionId = randomUUID();
          const partKey = `part_${randomUUID()}`;
          const result = await createHttpRequestExecutorRegistration({
            httpClient: destination.httpClient,
          }).execute({
            config: {
              method: 'POST',
              url: artifactDestinationUrl,
              headers: {},
              timeoutMillis: 5000,
              maxRedirects: 0,
              maxResponseBytes: 8192,
              inlineResponseBytes: 8192,
              multipart: {
                parts: [
                  {
                    inputKey: partKey,
                    name: 'report',
                    kind: 'file',
                    filename: 'report.csv',
                  },
                ],
              },
            },
            input: { [partKey]: file },
            connectionRefs: { http_headers: connectionId },
            signal,
            runtime: {
              ...runtime,
              sideEffectClass: 'unsafe',
              connections: headerConnection(connectionId, randomUUID(), {
                authorization: ownedDestination.authorization,
              }),
            },
          });
          expect(result).toMatchObject({
            status: 200,
            body: {
              json: {
                parts: [
                  {
                    name: 'report',
                    filename: 'report.csv',
                    contentType: file.mediaType,
                    byteLength: expected.length,
                    sha256: file.sha256,
                  },
                ],
              },
            },
          });
          expect(beforeDispatch).toHaveBeenCalledTimes(1);
          expect(destination.observe()).toHaveLength(1);
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
          await clean(() => destination?.close() ?? Promise.resolve());
          await clean(
            () =>
              store?.delete({ artifactId, workspaceId }) ?? Promise.resolve(),
          );
          await clean(() => store?.close() ?? Promise.resolve());
          await clean(() => capabilities?.close() ?? Promise.resolve());
          await clean(() => database?.close() ?? Promise.resolve());
          await clean(() => environment.close());
          if (failures.length > 0)
            throw new AggregateError(
              failures,
              'Create file qualification cleanup failed',
            );
        },
        'Create file qualification',
      );
    }, 30000);
  },
);
