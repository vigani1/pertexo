import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { DataTableDefinition } from '@pertexo/contracts';
import { TableRowEditor } from '@/features/data-tables/components/row-editor';
import { createApiClient } from '@/lib/api/client';
import { renderInRouter } from '../../support/render-in-router';

const fetchRows = vi.fn<typeof fetch>();
const scope = {
  apiClient: createApiClient({
    fetch: fetchRows,
    readCsrfToken: () => undefined,
  }),
  userId: '01900000-0000-7000-8000-000000000004',
  workspaceId: '01900000-0000-7000-8000-000000000002',
};

const table = {
  id: '01900000-0000-7000-8000-000000000001',
  name: 'Orders',
  keyColumn: 'key',
  revision: 1,
  rowCount: 0,
  byteCount: 0,
  columns: [
    { id: 'c1', name: 'key', type: 'text', required: true },
    { id: 'c2', name: 'amount', type: 'number', required: false },
    { id: 'c3', name: 'note', type: 'text', required: false },
  ],
} as unknown as DataTableDefinition;

it('shows each field’s problem on it and focuses the first', async () => {
  renderInRouter(
    <TableRowEditor scope={scope} table={table} onClose={() => undefined} />,
  );
  fireEvent.change(await screen.findByLabelText(/amount/u), {
    target: { value: 'heavy' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save row' }));
  const key = screen.getByLabelText(/key/u);
  await waitFor(() => {
    expect(key).toHaveFocus();
  });
  expect(key).toHaveAccessibleDescription('Enter a value.');
  expect(screen.getByLabelText(/amount/u)).toHaveAccessibleDescription(
    'Enter a number.',
  );
  expect(fetchRows).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText(/amount/u), {
    target: { value: '12' },
  });
  expect(screen.getByLabelText(/amount/u)).not.toHaveAccessibleDescription(
    'Enter a number.',
  );
});

it('keeps a text cell’s line breaks', async () => {
  renderInRouter(
    <TableRowEditor
      scope={scope}
      table={table}
      row={{
        id: '01900000-0000-7000-8000-000000000003',
        revision: 1,
        values: { key: 'A-1', amount: null, note: 'first\nsecond' },
      }}
      onClose={() => undefined}
    />,
  );
  expect(await screen.findByLabelText(/note/u)).toHaveValue('first\nsecond');
});

it('keeps the stored values in their boolean, date, number and JSON controls', async () => {
  const mixed: DataTableDefinition = {
    ...table,
    columns: [
      ...table.columns,
      { id: 'c4', name: 'active', type: 'boolean', required: false },
      { id: 'c5', name: 'day', type: 'date', required: false },
      { id: 'c6', name: 'metadata', type: 'json', required: false },
    ],
  };
  renderInRouter(
    <TableRowEditor
      scope={scope}
      table={mixed}
      row={{
        id: '01900000-0000-7000-8000-000000000003',
        revision: 7,
        values: {
          key: 'A-1',
          amount: -12.5,
          note: 'first\nsecond',
          active: false,
          day: '2026-10-24',
          metadata: { region: 'EU' },
        },
      }}
      onClose={() => undefined}
    />,
  );
  expect(await screen.findByLabelText(/amount/u)).toHaveValue('-12.5');
  expect(screen.getByLabelText(/day/u)).toHaveValue('2026-10-24');
  expect(screen.getByRole('combobox', { name: /active/u })).toHaveTextContent(
    'False',
  );
  expect(screen.getByLabelText(/metadata/u)).toHaveValue(
    '{\n  "region": "EU"\n}',
  );
  expect(screen.getByLabelText(/note/u)).toHaveValue('first\nsecond');
});
