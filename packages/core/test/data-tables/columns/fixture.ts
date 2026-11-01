import { randomUUID } from 'node:crypto';

import type { DataTableSchemaChange } from '@pertexo/contracts';
import type { DataTableQuery } from '@pertexo/node-sdk';
import { createDataTablesStore } from '../../../src/data-tables/index.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  apiUrl,
  actorId,
  workspaceId,
} from '../../support/workflow-authoring.js';

export let store: ReturnType<typeof createDataTablesStore>;

export const scope = () => ({ workspaceId, actorId });

const all: DataTableQuery = { filters: [], limit: 100, offset: 0 };

export async function create() {
  const name = `Columns_${randomUUID().replaceAll('-', '')}`;
  const { id } = await store.create({
    ...scope(),
    idempotencyKey: randomUUID(),
    name,
    keyColumn: 'key',
    columns: [
      { name: 'key', type: 'text', required: true },
      { name: 'amount', type: 'number', required: true },
      { name: 'note', type: 'text', required: false },
    ],
  });
  return { id, name };
}

export async function collectExport(
  input: Omit<Parameters<typeof store.exportCsv>[0], 'consume'>,
) {
  let csv = '';
  await store.exportCsv({
    ...input,
    consume: async (chunks) => {
      for await (const chunk of chunks) csv += chunk;
    },
  });
  return { csv, rowCount: csv.trimEnd().split('\r\n').length - 1 };
}

export async function current(id: string) {
  const table = (await store.list(scope())).tables.find(
    (table) => table.id === id,
  );
  if (table === undefined) throw new Error('Table missing');
  return table;
}

export async function edit(id: string, change: DataTableSchemaChange) {
  return store.editSchema({
    ...scope(),
    tableId: id,
    expectedRevision: (await current(id)).revision,
    change,
    idempotencyKey: randomUUID(),
  });
}

export async function rows(id: string) {
  return (await store.find({ ...scope(), tableId: id, query: all })).rows;
}

export function beforeAllFixture1() {
  store = createDataTablesStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 6 }),
  );
}

export function afterAllFixture2() {
  return store.close();
}
