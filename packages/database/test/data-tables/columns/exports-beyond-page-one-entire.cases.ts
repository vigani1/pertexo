import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import {
  store,
  scope,
  create,
  collectExport,
  current,
  edit,
  rows,
} from './fixture.js';

export function registerExportsBeyondPageOneEntire(): void {
  it('exports beyond page one and the entire filtered result with formula escaping', async () => {
    const table = await create();
    await store.importRows({
      ...scope(),
      tableId: table.id,
      idempotencyKey: randomUUID(),
      rows: Array.from({ length: 120 }, (_, amount) => ({
        key: `row${String(amount)}`,
        amount,
        note: amount === 119 ? '=SUM(A1:A2)' : 'plain',
      })),
    });
    const exported = await collectExport({
      ...scope(),
      tableId: table.id,
      query: { filters: [] },
    });
    expect(exported.rowCount).toBe(120);
    expect(exported.csv.trimEnd().split('\r\n')).toHaveLength(121);
    expect(exported.csv).toContain('"row119","119","\'=SUM(A1:A2)"');
    const filtered = await collectExport({
      ...scope(),
      tableId: table.id,
      query: {
        filters: [{ column: 'amount', operator: 'greater_than', value: 60 }],
      },
    });
    expect(filtered.rowCount).toBe(59);
    expect(filtered.csv.split('\r\n')[1]).toContain('row61');
    expect(filtered.csv.trimEnd().split('\r\n').at(-1)).toContain('row119');
  });

  it('claims raw CSV before conversion so a committed import replays after a schema change', async () => {
    const table = await create();
    let conversions = 0;
    const input = {
      ...scope(),
      tableId: table.id,
      idempotencyKey: randomUUID(),
      csv: 'key,amount,note\na,1,',
      prepareRows: () => {
        conversions += 1;
        return [{ key: 'a', amount: 1, note: null }];
      },
    };
    const result = await store.importRows(input);
    await edit(table.id, {
      operation: 'rename_column',
      columnId: 'amount',
      name: 'total',
    });
    expect(await store.importRows(input)).toEqual(result);
    expect(conversions).toBe(1);
    expect((await rows(table.id))[0]?.values).toEqual({
      key: 'a',
      total: 1,
      note: null,
    });
    await expect(
      store.importRows({ ...input, csv: 'key,amount,note\nb,2,' }),
    ).rejects.toThrow('Idempotency');
  });

  it('streams complete CSV beyond the former cap with UTF-8 and quoting', async () => {
    const table = await create();
    await store.importRows({
      ...scope(),
      tableId: table.id,
      idempotencyKey: randomUUID(),
      rows: Array.from({ length: 25 }, (_, amount) => ({
        key: `row${String(amount)}`,
        amount,
        note: 'é"'.repeat(15000),
      })),
    });
    const exported = await collectExport({
      ...scope(),
      tableId: table.id,
      query: { filters: [] },
    });
    expect(Buffer.byteLength(exported.csv)).toBeGreaterThan(1_048_576);
    expect(exported.rowCount).toBe(25);
    const filtered = await collectExport({
      ...scope(),
      tableId: table.id,
      query: {
        filters: [{ column: 'amount', operator: 'less_than', value: 2 }],
      },
    });
    expect(filtered.rowCount).toBe(2);
  });

  it('aborts an export rather than mixing headers and rows after a column rename', async () => {
    const table = await create();
    await store.importRows({
      ...scope(),
      tableId: table.id,
      idempotencyKey: randomUUID(),
      rows: [{ key: 'a', amount: 2 }],
    });
    await expect(
      store.exportCsv({
        ...scope(),
        tableId: table.id,
        query: { filters: [] },
        consume: async (csv) => {
          const iterator = csv[Symbol.asyncIterator]();
          expect((await iterator.next()).value).toContain(
            '"key","amount","note"',
          );
          await edit(table.id, {
            operation: 'rename_column',
            columnId: 'amount',
            name: 'total',
          });
          await iterator.next();
        },
      }),
    ).rejects.toThrow(/columns changed during export/iu);
    expect((await current(table.id)).columns[1]?.name).toBe('total');
  });

  it('enforces a new valid unique key and rolls back a later duplicate write', async () => {
    const table = await create();
    await store.importRows({
      ...scope(),
      tableId: table.id,
      idempotencyKey: randomUUID(),
      rows: [
        { key: 'a', amount: 1 },
        { key: 'b', amount: 2 },
      ],
    });
    await edit(table.id, { operation: 'set_key', columnId: 'amount' });
    expect((await current(table.id)).keyColumn).toBe('amount');
    await expect(
      store.importRows({
        ...scope(),
        tableId: table.id,
        idempotencyKey: randomUUID(),
        rows: [{ key: 'c', amount: 2 }],
      }),
    ).rejects.toMatchObject({ code: 'key_conflict' });
    expect((await current(table.id)).rowCount).toBe(2);
  });
}
