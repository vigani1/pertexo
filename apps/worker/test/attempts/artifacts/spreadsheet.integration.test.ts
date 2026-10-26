import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createArtifactStore,
  parseArtifactStoreConfig,
} from '@pertexo/artifact-store';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import { filePageBundleSchema } from '@pertexo/node-sdk';
import type {
  NodeArtifactReference,
  NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import { createWorkerNodeRuntimeCapabilities } from '../../../src/attempts/execution/runtime-capabilities.js';
import { runWithCleanup } from '../../support/infrastructure/test-operation.js';
import { createArtifactDatabaseEnvironment } from './database.js';

const XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
type FileOutput = NodeArtifactReference & { kind: 'artifact' };

const integration =
  process.env.ARTIFACT_STORE_INTEGRATION === 'true' &&
  process.env.WORKER_TRANSPORT_INTEGRATION === 'true';
(integration ? describe : describe.skip)(
  'Excel workbooks through real worker storage',
  () => {
    it('writes and reads workbooks inline and as pages, and refuses hostile ones', async () => {
      const environment = createArtifactDatabaseEnvironment();
      const config = parseArtifactStoreConfig(process.env);
      const workspaceId = randomUUID();
      const ids: string[] = [];
      const context = {
        workspaceId,
        runId: randomUUID(),
        nodeRunId: randomUUID(),
        attemptId: randomUUID(),
        attemptNumber: 1,
        nodeId: 'workbook',
        invocationKey: 'root:workbook',
        workerId: 'spreadsheet-qualification',
        artifactRetentionDeadline: new Date(Date.now() + 600_000),
      };
      let capabilities:
        | Awaited<ReturnType<typeof createWorkerNodeRuntimeCapabilities>>
        | undefined;
      let store: ReturnType<typeof createArtifactStore> | undefined;
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
          const artifacts = capabilities.factories.artifacts?.(context);
          if (artifacts?.read === undefined)
            throw new Error('Missing file capabilities');
          const runtime: NodeExecutionRuntime = {
            ...context,
            artifacts,
            sideEffectClass: 'safe',
            beforeDispatch: vi.fn().mockResolvedValue(undefined),
          };
          const registry = createPlatformNodeRegistry();
          const signal = new AbortController().signal;
          const execute = (key: string, stepConfig: unknown, input: unknown) =>
            registry.execute({
              definition: { key, version: 1 },
              executor: { key, version: 1 },
              config: stepConfig,
              input,
              runtime,
              signal,
            });
          const fileOf = (output: unknown) =>
            (output as { file: FileOutput }).file;

          const rows = Array.from({ length: 2_400 }, (_, id) => ({
            id,
            currency: id % 3 === 0 ? 'USD' : 'EUR',
            amount: id / 8,
            paid: id % 2 === 0,
          }));
          const inline = await execute(
            'core.create_file',
            { format: 'xlsx', sheetName: 'Orders', columns: [] },
            { data: rows.slice(0, 40) },
          );
          if (inline.kind !== 'succeeded') throw new Error('Create failed');
          const workbook = fileOf(inline.output);
          expect(workbook.mediaType).toBe(XLSX);
          expect(
            await execute(
              'core.read_file',
              { format: 'xlsx', sheet: 'Orders' },
              { file: workbook },
            ),
          ).toEqual({ kind: 'succeeded', output: rows.slice(0, 40) });

          const upload = async (bytes: Buffer, mediaType = XLSX) => ({
            kind: 'artifact' as const,
            ...(await artifacts.write({
              body: Readable.from([bytes]),
              maxBytes: bytes.length,
              mediaType,
              purpose: 'node-output',
              signal,
            })),
          });
          const csv = await upload(
            Buffer.from(
              'id,currency,amount,paid\r\n' +
                rows
                  .map(
                    (row) =>
                      `${String(row.id)},${row.currency},${String(row.amount)},${String(row.paid)}\r\n`,
                  )
                  .join(''),
            ),
            'text/csv',
          );
          const csvPages = await execute(
            'core.read_file',
            { format: 'csv', delimiter: ',', outputMode: 'pages' },
            { file: csv },
          );
          if (csvPages.kind !== 'succeeded') throw new Error('Paging failed');
          const paged = await execute(
            'core.create_file',
            {
              format: 'xlsx',
              inputMode: 'pages',
              sheetName: 'All orders',
              columns: ['id', 'currency', 'amount', 'paid'],
            },
            { pages: filePageBundleSchema.parse(csvPages.output).pages },
          );
          if (paged.kind !== 'succeeded') throw new Error('Pages failed');
          const reread = await execute(
            'core.read_file',
            { format: 'xlsx', outputMode: 'pages' },
            { file: fileOf(paged.output) },
          );
          if (reread.kind !== 'succeeded') throw new Error('Reread failed');
          const bundle = filePageBundleSchema.parse(reread.output);
          expect(bundle.itemCount).toBe(2_400);
          const page = await execute(
            'core.read_file',
            { format: 'json' },
            { file: bundle.pages.at(-1) },
          );
          if (page.kind !== 'succeeded' || !Array.isArray(page.output))
            throw new Error('Page read failed');
          expect(page.output.at(-1)).toEqual(rows.at(-1));
          const bytes = await artifacts.read({
            reference: workbook,
            maxBytes: workbook.byteLength,
            signal,
          });
          await expect(
            execute(
              'core.read_file',
              { format: 'xlsx' },
              { file: await upload(declareHugeEntry(Buffer.from(bytes))) },
            ),
          ).rejects.toMatchObject({
            safeErrorCode: 'execution.file_input',
            diagnostic: { reason: 'spreadsheet_too_large' },
          });
          await expect(
            execute(
              'core.read_file',
              { format: 'xlsx', outputMode: 'pages' },
              {
                file: await upload(
                  Buffer.from('d0cf11e0a1b11ae1'.padEnd(1024, '0'), 'hex'),
                ),
              },
            ),
          ).rejects.toMatchObject({
            diagnostic: { reason: 'unsupported_spreadsheet' },
          });
          await expect(
            execute(
              'core.read_file',
              { format: 'xlsx', sheet: 'Missing' },
              { file: workbook },
            ),
          ).rejects.toMatchObject({
            diagnostic: { reason: 'sheet_missing', sheets: ['Orders'] },
          });
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
          for (const artifactId of ids)
            await clean(
              () =>
                store?.delete({ artifactId, workspaceId }) ?? Promise.resolve(),
            );
          await clean(() => store?.close() ?? Promise.resolve());
          await clean(() => capabilities?.close() ?? Promise.resolve());
          await clean(() => environment.close());
          if (failures.length > 0)
            throw new AggregateError(
              failures,
              'Spreadsheet qualification cleanup failed',
            );
        },
        'Spreadsheet qualification',
      );
    }, 60_000);
  },
);

/** Claims 200 MB for the first zip entry; a reader must refuse before inflating. */
function declareHugeEntry(bytes: Buffer): Buffer {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const directory = bytes.readUInt32LE(end + 16);
  bytes.writeUInt32LE(200 * 1024 * 1024, directory + 24);
  return bytes;
}
