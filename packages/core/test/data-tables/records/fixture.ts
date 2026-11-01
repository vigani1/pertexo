import { randomUUID } from 'node:crypto';

import {
  dataTableNewColumnsSchema,
  type DataTableQuery,
} from '@pertexo/node-sdk';
import { createDataTablesStore } from '../../../src/data-tables/index.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';

import {
  apiUrl,
  actorId,
  workspaceId,
} from '../../support/workflow-authoring.js';

export let store: ReturnType<typeof createDataTablesStore>;

export const scope = () => ({ workspaceId, actorId });

export const columns = dataTableNewColumnsSchema.parse([
  { name: 'key', type: 'text', required: true },
  { name: 'amount', type: 'number' },
  { name: 'active', type: 'boolean' },
]);

export const query: DataTableQuery = { filters: [], limit: 100, offset: 0 };

export async function table() {
  const name = `Orders_${randomUUID().replaceAll('-', '')}`;
  const result = await store.create({
    ...scope(),
    name,
    columns,
    keyColumn: 'key',
    idempotencyKey: randomUUID(),
  });
  return { ...result, name };
}

export async function insert(
  f: Awaited<ReturnType<typeof table>>,
  key: string,
  amount = 1,
) {
  return store.write({
    ...scope(),
    tableId: f.id,
    command: {
      operation: 'insert',
      table: f.name,
      values: { key, amount, active: true },
    },
    idempotencyKey: randomUUID(),
  });
}

export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Fixture value missing');
  return value;
}

export function beforeAllFixture1() {
  store = createDataTablesStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 6 }),
  );
}

export function afterAllFixture2() {
  return store.close();
}
