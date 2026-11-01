import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  createArtifactStore,
  parseArtifactStoreConfig,
} from '@pertexo/artifact-store';
import {
  createWorkspaceDatabase,
  artifacts as artifactsTable,
} from '@pertexo/database/testing';
import { createPagedFileSource } from './pages-source.fixture.js';
import { createHttpRequestExecutorRegistration } from '@pertexo/integrations/server';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import { filePageBundleSchema, FILE_PAGE_LIMITS } from '@pertexo/node-sdk';
import type {
  NodeArtifactReference,
  NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import { createWorkerNodeRuntimeCapabilities } from '../../../src/attempts/execution/runtime-capabilities.js';
import { createArtifactDatabaseEnvironment } from './database.js';
import {
  createArtifactDestination,
  artifactDestinationUrl,
} from './http-destination.js';
import { runWithCleanup } from '../../support/infrastructure/test-operation.js';
import { assertPagedHttpSource } from './paging/http.js';
import { headerConnection } from '../../support/attempts/header-connection.js';

const enabled =
  process.env.ARTIFACT_STORE_INTEGRATION === 'true' &&
  process.env.WORKER_TRANSPORT_INTEGRATION === 'true';

(enabled ? describe : describe.skip)(
  'ordinary data pages through real worker storage',
  () => {
    it('pages CSV and real JSON HTTP results, summarizes, creates ordered files and sends exact bytes', async () => {
      const environment = createArtifactDatabaseEnvironment();
      const config = parseArtifactStoreConfig(process.env);
      const workspaceId = randomUUID(),
        ids: string[] = [];
      const deadline = new Date(Date.now() + 600000);
      let capabilities:
        | Awaited<ReturnType<typeof createWorkerNodeRuntimeCapabilities>>
        | undefined;
      let store: ReturnType<typeof createArtifactStore> | undefined;
      let database: ReturnType<typeof createWorkspaceDatabase> | undefined;
      let destination:
        Awaited<ReturnType<typeof createArtifactDestination>> | undefined;
      let httpSource:
        Awaited<ReturnType<typeof createPagedFileSource>> | undefined;
      const context = {
        workspaceId,
        runId: randomUUID(),
        nodeRunId: randomUUID(),
        attemptId: randomUUID(),
        attemptNumber: 1,
        nodeId: 'pages',
        invocationKey: 'root:pages',
        workerId: 'file-pages-qualification',
        artifactRetentionDeadline: deadline,
      };
      await runWithCleanup(
        async () => {
          await environment.initialize();
          capabilities = await createWorkerNodeRuntimeCapabilities(
            {
              database: environment.workerConfig,
              artifactScratchDirectory: environment.artifactScratchDirectory,
              artifactStore: config,
            },
            {
              artifactId: () => {
                const id = randomUUID();
                ids.push(id);
                return id;
              },
            },
          );
          store = createArtifactStore(config);
          database = createWorkspaceDatabase(environment.apiConfig);
          const artifacts = capabilities.factories.artifacts?.(context);
          if (
            artifacts?.openVerified === undefined ||
            artifacts.read === undefined
          )
            throw new Error('Missing checked file capabilities');
          const signal = new AbortController().signal;
          const beforeDispatch = vi.fn<NodeExecutionRuntime['beforeDispatch']>(
            () => Promise.resolve(),
          );
          const runtime: NodeExecutionRuntime = {
            ...context,
            artifacts,
            sideEffectClass: 'safe',
            beforeDispatch,
          };
          const registry = createPlatformNodeRegistry();
          const execute = (key: string, config: unknown, input: unknown) =>
            registry.execute({
              definition: { key, version: 1 },
              executor: { key, version: 1 },
              config,
              input,
              runtime,
              signal,
            });
          const rows = Array.from({ length: 5000 }, (_, id) => ({
            id,
            currency: 'EUR',
            amount: 2,
            text: 'a'.repeat(300),
          }));
          const csv = Buffer.from(
            'id,currency,amount,text\r\n' +
              rows
                .map((row) => `${String(row.id)},EUR,2,${row.text}\r\n`)
                .join(''),
          );
          expect(csv.length).toBeGreaterThan(1048576);
          const source = await artifacts.write({
            body: (async function* () {
              for (let offset = 0; offset < csv.length; offset += 65536)
                yield await Promise.resolve(
                  Buffer.from(csv.subarray(offset, offset + 65536)),
                );
            })(),
            maxBytes: FILE_PAGE_LIMITS.fileBytes,
            mediaType: 'text/csv; charset=utf-8',
            purpose: 'node-output',
            signal,
          });
          const read = await execute(
            'core.read_file',
            { format: 'csv', delimiter: ',', outputMode: 'pages' },
            { file: { kind: 'artifact', ...source } },
          );
          if (read.kind !== 'succeeded') throw new Error('CSV paging failed');
          const bundle = filePageBundleSchema.parse(read.output);
          expect(bundle.itemCount).toBe(rows.length);
          expect(bundle.pageCount).toBeGreaterThan(1);
          let sum = 0;
          for (const page of bundle.pages) {
            const read = await execute(
              'core.read_file',
              { format: 'json' },
              { file: page },
            );
            if (read.kind !== 'succeeded') throw new Error('Page read failed');
            const filtered = await execute(
              'core.filter',
              { path: '$.currency', operator: 'equals' },
              { items: read.output, value: 'EUR' },
            );
            if (filtered.kind !== 'succeeded')
              throw new Error('Page filter failed');
            const summarized = await execute(
              'core.summarize',
              { valuePath: '$.amount', missing: 'error' },
              { items: (filtered.output as { items: unknown }).items },
            );
            if (summarized.kind !== 'succeeded')
              throw new Error('Page summary failed');
            sum +=
              (summarized.output as { groups: readonly { sum: number }[] })
                .groups[0]?.sum ?? 0;
          }
          expect(sum).toBe(10000);
          expect(beforeDispatch).not.toHaveBeenCalled();
          const created = await execute(
            'core.create_file',
            { format: 'json', inputMode: 'pages' },
            { pages: bundle.pages },
          );
          if (created.kind !== 'succeeded')
            throw new Error('JSON assembly failed');
          const file = (
            created.output as {
              file: NodeArtifactReference & { kind: 'artifact' };
            }
          ).file;
          const expected = Buffer.from(JSON.stringify(rows));
          expect(file.byteLength).toBe(expected.length);
          expect(file.sha256).toBe(
            createHash('sha256').update(expected).digest('hex'),
          );
          const verified = await artifacts.openVerified({
            reference: (({ kind: _kind, ...reference }) => reference)(file),
            maxBytes: FILE_PAGE_LIMITS.fileBytes,
            signal,
          });
          try {
            const actual: Buffer[] = [];
            for await (const chunk of verified.open(
              signal,
            ) as AsyncIterable<Uint8Array>)
              actual.push(Buffer.from(chunk));
            expect(Buffer.concat(actual)).toEqual(expected);
          } finally {
            await verified.release();
          }
          const createdCsv = await execute(
            'core.create_file',
            {
              format: 'csv',
              inputMode: 'pages',
              delimiter: ',',
              columns: ['currency', 'id', 'amount'],
            },
            { pages: bundle.pages },
          );
          if (createdCsv.kind !== 'succeeded')
            throw new Error('CSV assembly failed');
          const csvFile = (createdCsv.output as { file: NodeArtifactReference })
            .file;
          const csvBytes = await artifacts.read({
            reference: csvFile,
            maxBytes: 1048576,
            signal,
          });
          try {
            expect(Buffer.from(csvBytes).toString()).toBe(
              '"currency","id","amount"\r\n' +
                rows.map((row) => `"EUR","${String(row.id)}","2"\r\n`).join(''),
            );
          } finally {
            csvBytes.fill(0);
          }
          const metadata = await database.withWorkspace(workspaceId, ({ db }) =>
            db
              .select({
                id: artifactsTable.id,
                bytes: artifactsTable.byteLength,
                expiresAt: artifactsTable.expiresAt,
                status: artifactsTable.status,
              })
              .from(artifactsTable),
          );
          expect(metadata).toHaveLength(bundle.pageCount + 3);
          expect(
            metadata.every(
              (row) =>
                row.status === 'available' &&
                row.expiresAt.getTime() === deadline.getTime(),
            ),
          ).toBe(true);
          const foreign = capabilities.factories.artifacts?.({
            ...context,
            workspaceId: randomUUID(),
          });
          if (foreign?.read === undefined)
            throw new Error('Missing scoped reader');
          const first = bundle.pages[0];
          if (first === undefined) throw new Error('Missing first page');
          const { kind: _firstKind, ...firstReference } = first;
          await expect(
            foreign.read({
              reference: firstReference,
              maxBytes: FILE_PAGE_LIMITS.bytes,
              signal,
            }),
          ).rejects.toMatchObject({ possiblyDispatched: false });
          await expect(
            artifacts.read({
              reference: { ...firstReference, sha256: 'b'.repeat(64) },
              maxBytes: FILE_PAGE_LIMITS.bytes,
              signal,
            }),
          ).rejects.toMatchObject({ possiblyDispatched: false });
          destination = await createArtifactDestination();
          const target = destination,
            connectionId = randomUUID(),
            partKey = `part_${randomUUID()}`;
          const sent = await createHttpRequestExecutorRegistration({
            httpClient: target.httpClient,
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
                    filename: 'report.json',
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
                authorization: target.authorization,
              }),
            },
          });
          expect(sent).toMatchObject({
            status: 200,
            body: {
              json: {
                parts: [
                  {
                    name: 'report',
                    filename: 'report.json',
                    contentType: 'application/json',
                    byteLength: expected.length,
                    sha256: file.sha256,
                  },
                ],
              },
            },
          });
          expect(beforeDispatch).toHaveBeenCalledOnce();
          expect(target.observe()).toHaveLength(1);
          httpSource = await createPagedFileSource();
          const pagedSource = httpSource;
          await assertPagedHttpSource({
            pagedSource,
            runtime,
            signal,
            execute,
          });
          expect(await readdir(environment.artifactScratchDirectory)).toEqual(
            [],
          );
        },
        async () => {
          const cleanup: Promise<unknown>[] = [];
          if (destination !== undefined) cleanup.push(destination.close());
          if (httpSource !== undefined) cleanup.push(httpSource.close());
          if (store !== undefined) {
            const active = store;
            cleanup.push(
              ...ids.map((artifactId) =>
                active.delete({ artifactId, workspaceId }),
              ),
            );
          }
          const results = await Promise.allSettled(cleanup);
          const errors = results.flatMap((result) =>
            result.status === 'rejected' ? [result.reason as unknown] : [],
          );
          for (const operation of [
            () => store?.close(),
            () => capabilities?.close(),
            () => database?.close(),
            () => environment.close(),
          ]) {
            try {
              await operation();
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length > 0)
            throw new AggregateError(
              errors,
              'File page qualification cleanup failed',
            );
        },
        'File page qualification',
      );
    }, 60000);
  },
);
