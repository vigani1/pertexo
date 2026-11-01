import { randomUUID } from 'node:crypto';

import { dataTableNewColumnsSchema } from '@pertexo/node-sdk';
import { expect, it } from 'vitest';

import { store } from '../records/fixture.js';
import { newWorkspace, revisionOf, type Actor } from './world.js';

const ELIGIBLE = [
  ['text', 'a'],
  ['number', 7],
  ['date', '2026-01-02'],
] as const;

const INELIGIBLE = [
  ['a required boolean', { type: 'boolean', required: true }],
  ['a required JSON', { type: 'json', required: true }],
  ['an optional text', { type: 'text', required: false }],
  ['an optional number', { type: 'number', required: false }],
  ['an optional date', { type: 'date', required: false }],
] as const;

const keyRefused = {
  code: 'invalid_values',
  message: 'The unique key must be a required text, number or date column.',
};

function create(
  actor: Actor,
  column: Readonly<{ type: string; required: boolean }>,
  keyColumn: string | null,
) {
  return store.create({
    ...actor,
    idempotencyKey: randomUUID(),
    name: `Keyed_${randomUUID().replaceAll('-', '')}`,
    columns: dataTableNewColumnsSchema.parse([
      { name: 'candidate', ...column },
      { name: 'other', type: 'text' },
    ]),
    keyColumn,
  });
}

export function registerKeyColumn(): void {
  it.each(ELIGIBLE)(
    'takes a required %s column as a unique key, at creation and later, and keys rows on it',
    async (type, value) => {
      const actor = await newWorkspace();
      const created = await create(
        actor,
        { type, required: true },
        'candidate',
      );
      const later = await create(actor, { type, required: true }, null);
      await store.editSchema({
        ...actor,
        tableId: later.id,
        idempotencyKey: randomUUID(),
        expectedRevision: await revisionOf(actor, later.id),
        change: { operation: 'set_key', columnId: 'candidate' },
      });
      const { tables } = await store.list(actor);
      for (const { id } of [created, later]) {
        const table = tables.find((item) => item.id === id);
        if (table === undefined) throw new Error('Table missing');
        expect(table.keyColumn).toBe('candidate');
        const upsert = (other: string) =>
          store.write({
            ...actor,
            tableId: id,
            idempotencyKey: randomUUID(),
            command: {
              operation: 'upsert',
              table: table.name,
              values: { candidate: value, other },
            },
          });
        await upsert('first');
        await upsert('second');
        const { rows } = await store.find({
          ...actor,
          tableId: id,
          query: { filters: [], limit: 10, offset: 0 },
        });
        expect(rows.map((row) => row.values.other)).toEqual(['second']);
      }
    },
  );

  it.each(INELIGIBLE)(
    'refuses %s column as a unique key, at creation and later, and changes nothing',
    async (_name, column) => {
      const actor = await newWorkspace();
      await expect(create(actor, column, 'candidate')).rejects.toMatchObject(
        keyRefused,
      );
      expect((await store.list(actor)).quotas.tableCount).toBe(0);

      const later = await create(actor, column, null);
      await expect(
        store.editSchema({
          ...actor,
          tableId: later.id,
          idempotencyKey: randomUUID(),
          expectedRevision: await revisionOf(actor, later.id),
          change: { operation: 'set_key', columnId: 'candidate' },
        }),
      ).rejects.toMatchObject(keyRefused);
      const table = (await store.list(actor)).tables.find(
        ({ id }) => id === later.id,
      );
      expect(table?.keyColumn).toBeNull();
    },
  );
}
