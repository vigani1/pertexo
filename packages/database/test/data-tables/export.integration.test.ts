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
    parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
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
it('releases its client when the destination fails or the caller cancels', async () => {
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
it('keeps a one-connection API pool available while several export consumers are stalled', async () => {
  const table = await create();
  await store.importRows({
    ...scope(),
    tableId: table.id,
    idempotencyKey: randomUUID(),
    rows: Array.from({ length: 600 }, (_, i) => ({
      key: String(i),
      note: 'before',
    })),
  });
  const release = Promise.withResolvers<undefined>();
  const opened = Array.from({ length: 3 }, () =>
    Promise.withResolvers<undefined>(),
  );
  const downloads = opened.map((ready) =>
    store.exportCsv({
      ...scope(),
      tableId: table.id,
      query: { filters: [] },
      consume: async (csv) => {
        let rows = 0;
        let first = '',
          last = '';
        for await (const chunk of csv) {
          if (rows === 1) {
            first = chunk;
            ready.resolve(undefined);
            await release.promise;
          }
          last = chunk;
          rows += 1;
        }
        expect(rows).toBe(601);
        expect(first).toContain('before');
        expect(last).toContain('after');
      },
    }),
  );
  const readyTimeout = setTimeout(() => {
    for (const ready of opened)
      ready.reject(new Error('An export retained the only pooled connection'));
  }, 5000);
  try {
    await Promise.all(opened.map((ready) => ready.promise));
    // The only client must be available before any download is allowed to advance.
    const list = await store.list({
      ...scope(),
      signal: AbortSignal.timeout(3000),
    });
    const definition = list.tables.find((entry) => entry.id === table.id);
    if (definition === undefined) throw new Error('Missing table');
    const written = await store.write({
      ...scope(),
      tableId: table.id,
      idempotencyKey: randomUUID(),
      command: {
        operation: 'update',
        table: definition.name,
        values: { note: 'after' },
        query: {
          filters: [{ column: 'note', operator: 'equals', value: 'before' }],
          limit: 1000,
          offset: 0,
        },
      },
    });
    expect(written.affected).toBe(600);
  } finally {
    clearTimeout(readyTimeout);
    release.resolve(undefined);
    // Settle without throwing so a failure above is the one reported.
    await Promise.allSettled(downloads);
  }
  await Promise.all(downloads);
});

it('bounds wide-row batches by bytes while fetching more than sixteen rows', async () => {
  const table = await create();
  await store.importRows({
    ...scope(),
    tableId: table.id,
    idempotencyKey: randomUUID(),
    rows: Array.from({ length: 100 }, (_, i) => ({
      key: String(i),
      note: 'x'.repeat(60_000),
    })),
  });
  const definition = (await store.list(scope())).tables.find(
    (entry) => entry.id === table.id,
  );
  if (definition === undefined) throw new Error('Missing table');
  let bytes = 0,
    rows = 0;
  await store.exportCsv({
    ...scope(),
    tableId: table.id,
    query: { filters: [] },
    consume: async (csv) => {
      for await (const chunk of csv) {
        bytes += Buffer.byteLength(chunk);
        if (rows++ === 1) {
          // Delete after the first batch is checked in; only its buffered rows remain.
          await store.write({
            ...scope(),
            tableId: table.id,
            idempotencyKey: randomUUID(),
            command: {
              operation: 'delete',
              table: definition.name,
              query: {
                filters: [{ column: 'note', operator: 'contains', value: 'x' }],
                limit: 1000,
                offset: 0,
              },
            },
          });
        }
      }
    },
  });
  expect(rows - 1).toBeGreaterThan(16);
  expect(rows - 1).toBeLessThan(100);
  expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
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
