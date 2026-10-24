import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import {
  type DataTableDefinition,
  dataTableWriteSchema,
  type DataTableWrite,
} from '@pertexo/contracts';
import { dataTableQuerySchema, type DataTableQuery } from '@pertexo/node-sdk';
import { DataTableRows } from '@/features/data-tables/components/rows/view';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
import { renderInRouter } from '../../support/render-in-router';

const table: DataTableDefinition = {
  id: '01900000-0000-7000-8000-000000000001',
  name: 'Records',
  revision: 1,
  keyColumn: 'reference',
  hasRemovedColumns: false,
  storedBytes: 1024,
  rowCount: 51,
  columns: [
    { id: 'reference', name: 'reference', type: 'text', required: true },
  ],
};
const records = Array.from({ length: 51 }, (_, index) => ({
  id: `01900000-0000-7000-8000-${String(index + 10).padStart(12, '0')}`,
  revision: index === 0 ? 7 : 1,
  values: { reference: `Item ${String(index + 1)}` },
}));

function mount({ editable }: Readonly<{ editable: boolean }>) {
  const reads: DataTableQuery[] = [],
    writes: DataTableWrite[] = [];
  const keys: (string | null)[] = [];
  const scope = {
    apiClient: createApiClient({
      fetch: testFetch,
      readCsrfToken: () => 'data-table-component-csrf',
    }),
    userId: '01900000-0000-7000-8000-000000000004',
    workspaceId: '01900000-0000-7000-8000-000000000002',
  };
  const path = `http://pertexo.test/v1/workspaces/${scope.workspaceId}/data-tables/${table.id}/rows`;
  mockServer.use(
    http.post(`${path}/query`, async ({ request }) => {
      const query = dataTableQuerySchema.parse(await request.json());
      reads.push(query);
      return HttpResponse.json({
        rows: records.slice(query.offset, query.offset + query.limit),
        affected: 0,
        hasMore: query.offset + query.limit < records.length,
      });
    }),
    http.post(path, async ({ request }) => {
      writes.push(dataTableWriteSchema.parse(await request.json()));
      keys.push(request.headers.get('idempotency-key'));
      return new HttpResponse(null, { status: 503 });
    }),
  );
  renderInRouter(
    <DataTableRows scope={scope} table={table} editable={editable} />,
  );
  return { reads, writes, keys };
}

it('pages using the current offset and keeps the previous-page action available', async () => {
  const { reads } = mount({ editable: false });
  await screen.findByText('Item 1', { exact: true });
  fireEvent.click(screen.getByRole('button', { name: 'Next rows' }));
  await screen.findByText('Item 51', { exact: true });
  expect(screen.queryByText('Item 1', { exact: true })).toBeNull();
  expect(screen.getByRole('button', { name: 'Next rows' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Previous rows' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Previous rows' }));
  await screen.findByText('Item 1', { exact: true });
  expect(reads.map(({ offset }) => offset)).toEqual([0, 50, 0]);
});

it('deletes the displayed row revision and keeps writes locked when the outcome is uncertain', async () => {
  const { writes, keys } = mount({ editable: true });
  await screen.findByText('Item 1', { exact: true });
  const remove = within(
    screen.getByRole('row', { name: /^Item 1\b/u }),
  ).getByRole('button', { name: 'Delete' });
  fireEvent.click(remove);
  await waitFor(() => {
    expect(writes).toHaveLength(1);
  });
  expect(writes[0]).toEqual({
    command: {
      operation: 'delete',
      table: 'Records',
      query: { filters: [], limit: 100, offset: 0 },
    },
    rowId: '01900000-0000-7000-8000-000000000010',
    expectedRevision: 7,
  });
  const retry = await screen.findByRole('button', {
    name: 'Retry same action',
  });
  expect(remove).toBeDisabled();
  fireEvent.click(retry);
  await waitFor(() => {
    expect(writes).toHaveLength(2);
  });
  expect(writes[1]).toEqual(writes[0]);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
});
