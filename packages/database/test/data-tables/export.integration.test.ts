import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createDataTablesStore } from '../../src/data-tables/index.js';
import { parseDatabaseConfig } from '../../src/config.js';
import {
  apiUrl,
  actorId,
  workspaceId,
  queryAsOwner,
} from '../support/workflow-authoring.js';

const scope = () => ({ actorId, workspaceId });
let store: ReturnType<typeof createDataTablesStore>;
beforeAll(() => {
  store = createDataTablesStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  );
});
afterAll(() => store.close());
async function create() {
  return store.create({
    ...scope(),
    name: `Export_${randomUUID().replaceAll('-', '')}`,
    columns: [
      { name: 'key', type: 'text', required: true },
      { name: 'note', type: 'text', required: false },
    ],
    idempotencyKey: randomUUID(),
  });
}
it('releases its snapshot/client when the destination fails or the caller cancels', async () => {
  const table = await create();
  await expect(
    store.exportCsv({
      ...scope(),
      tableId: table.id,
      query: { filters: [] },
      consume: async (chunks) => {
        for await (const chunk of chunks) {
          expect(chunk.length).toBeGreaterThan(0);
          throw new Error('destination closed');
        }
      },
    }),
  ).rejects.toThrow('destination closed');
  const abort = new AbortController();
  await expect(
    store.exportCsv({
      ...scope(),
      tableId: table.id,
      query: { filters: [] },
      signal: abort.signal,
      consume: async (chunks) => {
        for await (const chunk of chunks) {
          expect(chunk.length).toBeGreaterThan(0);
          abort.abort();
          abort.signal.throwIfAborted();
        }
      },
    }),
  ).rejects.toThrow(/aborted/iu);
  expect(
    (
      await store.list({ ...scope(), signal: AbortSignal.timeout(3000) })
    ).tables.some((entry) => entry.id === table.id),
  ).toBe(true);
});
it('rejects a stale filter before offering its CSV iterable to a download consumer', async () => {
  const table = await create();
  let consumed = false;
  await expect(
    store.exportCsv({
      ...scope(),
      tableId: table.id,
      query: {
        filters: [{ column: 'removed', operator: 'equals', value: 'value' }],
      },
      consume: () => {
        consumed = true;
        return Promise.resolve();
      },
    }),
  ).rejects.toThrow(/column/iu);
  expect(consumed).toBe(false);
});
it('streams a 100,000-row near-1-GiB table under a 192-MiB child-process heap', async () => {
  await store.configure({
    ...scope(),
    tableLimit: 100,
    columnLimit: 50,
    rowLimit: 100000,
    byteLimit: 1073741824,
    idempotencyKey: randomUUID(),
  });
  const table = await create();
  await queryAsOwner(
    `insert into app.workspace_data_table_rows(workspace_id,table_id,id,values_json)
    select $1,$2,gen_random_uuid(),jsonb_build_object('key',n::text,'note',repeat('x',10670))::text from generate_series(1,100000) n`,
    [workspaceId, table.id],
    workspaceId,
  );
  await queryAsOwner(
    `update app.workspace_data_tables set row_count=100000,stored_bytes=(select sum(octet_length(values_json)) from app.workspace_data_table_rows where workspace_id=$1 and table_id=$2) where workspace_id=$1 and id=$2`,
    [workspaceId, table.id],
    workspaceId,
  );
  await queryAsOwner(
    `update app.workspace_data_table_quotas set stored_bytes=(select sum(stored_bytes) from app.workspace_data_tables where workspace_id=$1) where workspace_id=$1`,
    [workspaceId],
    workspaceId,
  );
  const definition = (await store.list(scope())).tables.find(
    (entry) => entry.id === table.id,
  );
  expect(definition?.storedBytes).toBeGreaterThan(1_060_000_000);
  expect(definition?.storedBytes).toBeLessThanOrEqual(1_073_741_824);
  const script = `
    import { createDataTablesStore } from '@pertexo/database/data-tables';
    const store = createDataTablesStore(JSON.parse(process.env.EXPORT_TEST_CONFIG));
    let bytes = 0, chunks = 0, heap = 0;
    const started = performance.now();
    try {
      await store.exportCsv({ workspaceId: process.env.EXPORT_TEST_WORKSPACE, actorId: process.env.EXPORT_TEST_ACTOR, tableId: process.env.EXPORT_TEST_TABLE, query: { filters: [] }, consume: async (csv) => {
        for await (const chunk of csv) { bytes += Buffer.byteLength(chunk); chunks += 1; if (chunks % 256 === 0) heap = Math.max(heap, process.memoryUsage().heapUsed); }
      } });
      console.log(JSON.stringify({ bytes, rows: chunks - 1, peakSampledHeap: heap, millis: performance.now() - started }));
    } finally { await store.close(); }
  `;
  const result = await promisify(execFile)(
    process.execPath,
    ['--max-old-space-size=192', '--input-type=module', '-e', script],
    {
      env: {
        ...process.env,
        EXPORT_TEST_CONFIG: JSON.stringify(
          parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
        ),
        EXPORT_TEST_WORKSPACE: workspaceId,
        EXPORT_TEST_ACTOR: actorId,
        EXPORT_TEST_TABLE: table.id,
      },
      timeout: 120000,
    },
  );
  const evidence = JSON.parse(result.stdout) as {
    bytes: number;
    rows: number;
    peakSampledHeap: number;
    millis: number;
  };
  expect(evidence.rows).toBe(100000);
  expect(evidence.bytes).toBeGreaterThan(1_060_000_000);
  process.stdout.write(
    'Streamed CSV quota evidence ' + JSON.stringify(evidence) + '\n',
  );
}, 180000);
