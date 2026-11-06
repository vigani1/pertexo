import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import { drizzle } from 'drizzle-orm/node-postgres';
import { isStoredDataError } from '../../src/shared/stored-values.js';
import { readTablesByNames } from '../../src/data-tables/table-lookups.repository.js';
import {
  apiPool,
  queryAsOwner,
  workspaceId,
} from '../support/workflow-authoring.js';
import {
  beforeAllFixture1,
  afterAllFixture2,
  store,
  scope,
  table,
  insert,
  query,
} from './records/fixture.js';
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);

it.each([
  ['null column', [null], 'key'],
  [
    'duplicate identity',
    [
      { id: 'key', name: 'key', type: 'text', required: true },
      { id: 'key', name: 'other', type: 'text', required: true },
    ],
    'key',
  ],
  [
    'invalid identity',
    [{ id: 'bad id', name: 'key', type: 'text', required: true }],
    'key',
  ],
  [
    'missing key',
    [{ id: 'key', name: 'key', type: 'text', required: true }],
    'missing',
  ],
  [
    'ineligible key',
    [{ id: 'key', name: 'key', type: 'boolean', required: true }],
    'key',
  ],
] as const)(
  'classifies a stored %s on every reader and keeps other tables usable',
  async (_name, columns, key) => {
    const damaged = await table();
    const healthy = await table();
    await insert(healthy, 'retained');
    const [original] = await queryAsOwner(
      'select columns_json,key_column from app.workspace_data_tables where id=$1',
      [damaged.id],
      workspaceId,
    );
    if (original === undefined) throw new Error('Missing stored definition');
    try {
      await queryAsOwner(
        'update app.workspace_data_tables set columns_json=$2::jsonb,key_column=$3 where id=$1',
        [damaged.id, JSON.stringify(columns), key],
        workspaceId,
      );
      const reads = [
        () => store.list(scope()),
        () => store.find({ ...scope(), tableId: damaged.id, query }),
        () =>
          store.exportCsv({
            ...scope(),
            tableId: damaged.id,
            query: { filters: [] },
            consume: async (chunks) => {
              for await (const chunk of chunks)
                expect(chunk).toBeTypeOf('string');
            },
          }),
        () =>
          withTenantScopedClient(apiPool, { workspaceId }, (client) =>
            readTablesByNames(drizzle(client), workspaceId, [damaged.name]),
          ),
      ];
      for (const read of reads) {
        const error = await read().then(
          () => undefined,
          (failure: unknown) => failure,
        );
        expect(isStoredDataError(error), String(error)).toBe(true);
      }
      expect(
        (await store.find({ ...scope(), tableId: healthy.id, query })).rows,
      ).toHaveLength(1);
      let csv = '';
      await store.exportCsv({
        ...scope(),
        tableId: healthy.id,
        query: { filters: [] },
        consume: async (chunks) => {
          for await (const chunk of chunks) csv += chunk;
        },
      });
      expect(csv).toContain('retained');
    } finally {
      await queryAsOwner(
        'update app.workspace_data_tables set columns_json=$2::jsonb,key_column=$3 where id=$1',
        [
          damaged.id,
          JSON.stringify(original.columns_json),
          original.key_column,
        ],
        workspaceId,
      );
      await store.remove({
        ...scope(),
        tableId: damaged.id,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      });
      await store.remove({
        ...scope(),
        tableId: healthy.id,
        expectedRevision: 2,
        idempotencyKey: randomUUID(),
      });
    }
  },
);
