import { describe, it, expect, vi } from 'vitest';
import { DataTableError } from '@pertexo/node-sdk';
import type { DataTablesStore } from '@pertexo/database/data-tables';
import { DataTablesService } from '../../src/data-tables/service.js';
function fixture() {
  const prepared: unknown[] = [];
  const definition = {
    id: 'table',
    name: 'Orders',
    columns: [
      { id: 'id', name: 'id', type: 'text', required: true },
      { id: 'amount', name: 'amount', type: 'number', required: true },
      { id: 'active', name: 'active', type: 'boolean', required: false },
    ],
    keyColumn: 'id',
    hasRemovedColumns: false,
    rowCount: 0,
    storedBytes: 0,
    revision: 1,
  } as const;
  const imported = vi
    .fn<DataTablesStore['importRows']>()
    .mockImplementation((input) => {
      const rows =
        'prepareRows' in input
          ? input.prepareRows({
              ...definition,
              columns: [...definition.columns],
            })
          : input.rows;
      prepared.push(rows);
      return Promise.resolve({ affected: rows.length });
    });
  const store = {
    list: vi.fn<DataTablesStore['list']>().mockResolvedValue({
      tables: [{ ...definition, columns: [...definition.columns] }],
      quotas: {
        tableLimit: 20,
        columnLimit: 20,
        rowLimit: 10000,
        byteLimit: 52428800,
        storedBytes: 0,
        tableCount: 1,
      },
    }),
    editSchema: vi.fn<DataTablesStore['editSchema']>(),
    exportCsv: vi.fn<DataTablesStore['exportCsv']>(),
    create: vi.fn<DataTablesStore['create']>(),
    remove: vi.fn<DataTablesStore['remove']>(),
    configure: vi.fn<DataTablesStore['configure']>(),
    find: vi.fn<DataTablesStore['find']>(),
    write: vi.fn<DataTablesStore['write']>(),
    importRows: imported,
    close: vi.fn<DataTablesStore['close']>(),
  } satisfies DataTablesStore;
  return { service: new DataTablesService(store), imported, prepared };
}
const input = {
  workspaceId: 'workspace',
  actorId: 'actor',
  tableId: 'table',
  idempotencyKey: 'key',
  rows: [],
};
describe('typed CSV import', () => {
  it('handles a BOM, quoted commas and newlines and converts only declared types', async () => {
    const { service, prepared } = fixture();
    expect(
      await service.importCsv({
        ...input,
        csv: '\ufeffid,amount,active\r\n"001,23",12.5,false\r\n"two\nlines",0,true',
      }),
    ).toEqual({ affected: 2 });
    expect(prepared[0]).toEqual([
      { id: '001,23', amount: 12.5, active: false },
      { id: 'two\nlines', amount: 0, active: true },
    ]);
  });
  it.each([
    'id,id,active\na,1,true',
    'missing,amount,active\na,1,true',
    'id,amount,active\na,"broken,true',
  ])(
    'refuses malformed or mismatched headers before writing: %s',
    async (csv) => {
      const { service, imported } = fixture();
      await expect(service.importCsv({ ...input, csv })).rejects.toMatchObject({
        name: 'DataTableError',
        code: 'invalid_values',
      });
      expect(imported).toHaveBeenCalledOnce();
    },
  );
  it('imports a file that leaves out optional columns, which stay empty', async () => {
    const { service, prepared } = fixture();
    expect(
      await service.importCsv({ ...input, csv: 'amount,id\n3,b-1' }),
    ).toEqual({ affected: 1 });
    expect(prepared[0]).toEqual([{ amount: 3, id: 'b-1' }]);
  });
  it.each([
    ['id,id,active\na,1,true', 'The CSV names the column id more than once.'],
    [
      'id,amount,colour\na,1,red',
      'The CSV has a column this table doesn’t: colour. Rename or remove it.',
    ],
    ['id,active\na,true', 'The CSV is missing the required column amount.'],
  ])('names what is wrong with the header: %s', async (csv, message) => {
    const { service } = fixture();
    await expect(service.importCsv({ ...input, csv })).rejects.toThrow(message);
  });
  it('passes an empty cell on as no value, for the store to require', async () => {
    const { service, prepared } = fixture();
    await service.importCsv({ ...input, csv: 'id,amount\n,4' });
    expect(prepared[0]).toEqual([{ id: null, amount: 4 }]);
  });
  it('reports the exact bad record and column without partially importing', async () => {
    const { service, imported } = fixture();
    imported.mockRejectedValue(
      new DataTableError('invalid_values', 'Column amount needs number.', 2),
    );
    await expect(
      service.importCsv({
        ...input,
        csv: 'id,amount,active\na,12,true\nb,wrong,false',
      }),
    ).rejects.toThrow('CSV row 3: Column amount needs number');
    expect(imported).toHaveBeenCalledOnce();
  });
  it('bounds rows and bytes with split-file guidance', async () => {
    const { service, imported } = fixture();
    await expect(
      service.importCsv({
        ...input,
        csv:
          'id,amount,active\n' +
          Array.from({ length: 1001 }, (_, i) => `${String(i)},1,true`).join(
            '\n',
          ),
      }),
    ).rejects.toThrow('Split');
    await expect(
      service.importCsv({ ...input, csv: 'x'.repeat(1048577) }),
    ).rejects.toThrow('Split');
    expect(imported).toHaveBeenCalledTimes(2);
  });
});
