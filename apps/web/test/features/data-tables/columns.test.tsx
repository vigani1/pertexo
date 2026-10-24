import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { expect, it, vi } from 'vitest';
import {
  dataTableSchemaEditSchema,
  type DataTableDefinition,
  type DataTableSchemaEdit,
} from '@pertexo/contracts';
import { EditTableColumns } from '@/features/data-tables/components/columns/dialog';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
import { renderInRouter } from '../../support/render-in-router';

const table: DataTableDefinition = {
  id: '01900000-0000-7000-8000-000000000001',
  name: 'Records',
  revision: 7,
  keyColumn: 'reference',
  hasRemovedColumns: false,
  storedBytes: 1024,
  rowCount: 12,
  columns: [
    { id: 'reference', name: 'reference', type: 'text', required: true },
    { id: 'score', name: 'score', type: 'number', required: false },
  ],
};

it('prefills names and retains the exact destructive column edit after an uncertain response', async () => {
  const writes: DataTableSchemaEdit[] = [];
  const keys: (string | null)[] = [];
  const onClose = vi.fn();
  const scope = {
    apiClient: createApiClient({
      fetch: testFetch,
      readCsrfToken: () => 'table-columns-component-csrf',
    }),
    userId: '01900000-0000-7000-8000-000000000004',
    workspaceId: '01900000-0000-7000-8000-000000000002',
  };
  mockServer.use(
    http.put(
      `http://pertexo.test/v1/workspaces/${scope.workspaceId}/data-tables/${table.id}/schema`,
      async ({ request }) => {
        writes.push(dataTableSchemaEditSchema.parse(await request.json()));
        keys.push(request.headers.get('idempotency-key'));
        return new HttpResponse(null, { status: 503 });
      },
    ),
  );
  renderInRouter(
    <EditTableColumns scope={scope} table={table} onClose={onClose} />,
  );
  await screen.findByRole('dialog');
  expect(screen.getByLabelText('Column name')).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: 'Rename reference' }));
  expect(screen.getByLabelText('Column name')).toHaveValue('reference');
  fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
  expect(screen.getByLabelText('Column name')).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: 'Delete score' }));
  expect(
    screen.getByText(/Delete score and its cells in all 12 rows/u),
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole('button', { name: 'Confirm delete column' }),
  );
  const retry = await screen.findByRole('button', {
    name: 'Retry same action',
  });
  expect(writes).toEqual([
    {
      expectedRevision: 7,
      change: { operation: 'remove_column', columnId: 'score', confirm: true },
    },
  ]);
  expect(
    screen.getByRole('button', { name: 'Rename reference' }),
  ).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(retry);
  await waitFor(() => {
    expect(writes).toHaveLength(2);
  });
  expect(writes[1]).toEqual(writes[0]);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
});
