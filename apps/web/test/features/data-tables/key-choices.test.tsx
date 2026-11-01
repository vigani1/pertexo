import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { DataTableDefinition } from '@pertexo/contracts';
import { EditTableColumns } from '@/features/data-tables/components/columns/dialog';
import { CreateDataTable } from '@/features/data-tables/components/create';
import { createApiClient } from '@/lib/api/client';
import { testFetch } from '../../support/render-app';
import { renderInRouter } from '../../support/render-in-router';

const scope = {
  apiClient: createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'table-key-choices-csrf',
  }),
  userId: '01900000-0000-7000-8000-000000000004',
  workspaceId: '01900000-0000-7000-8000-000000000002',
};

const column = (name: string, type: string, required: boolean) => ({
  id: name,
  name,
  type,
  required,
});

const table = {
  id: '01900000-0000-7000-8000-000000000001',
  name: 'Records',
  revision: 7,
  keyColumn: null,
  hasRemovedColumns: false,
  storedBytes: 0,
  rowCount: 0,
  columns: [
    column('reference', 'text', true),
    column('amount', 'number', true),
    column('day', 'date', true),
    column('flag', 'boolean', true),
    column('details', 'json', true),
    column('note', 'text', false),
    column('optional_amount', 'number', false),
    column('optional_day', 'date', false),
  ],
} as DataTableDefinition;

async function offeredKeys(event: ReturnType<typeof userEvent.setup>) {
  await event.click(screen.getByLabelText(/unique key/iu));
  const offered = (await screen.findAllByRole('option')).map(
    (option) => option.textContent,
  );
  await event.keyboard('{Escape}');
  return offered;
}

it('offers only required text, number and date columns when changing the key of a table', async () => {
  const event = userEvent.setup();
  renderInRouter(
    <EditTableColumns scope={scope} table={table} onClose={vi.fn()} />,
  );
  const dialog = await screen.findByRole('dialog');
  await event.click(
    within(dialog).getByRole('button', { name: 'Change unique key' }),
  );
  expect(await offeredKeys(event)).toEqual([
    'No unique key',
    'reference',
    'amount',
    'day',
  ]);
});

it('offers a new column as the key only once it is named, required and an eligible type', async () => {
  const event = userEvent.setup();
  renderInRouter(
    <CreateDataTable
      scope={scope}
      columnLimit={20}
      onClose={vi.fn()}
      onCreated={vi.fn()}
    />,
  );
  await screen.findByRole('dialog');
  expect(await offeredKeys(event)).toEqual(['No unique key']);

  await event.type(screen.getByLabelText('Column name'), 'order_id');
  const required = screen.getByRole('switch', { name: 'Required' });
  if (required.getAttribute('aria-checked') === 'true')
    await event.click(required);
  expect(await offeredKeys(event)).toEqual(['No unique key']);

  await event.click(required);
  expect(await offeredKeys(event)).toEqual(['No unique key', 'order_id']);

  for (const [type, eligible] of [
    ['number', true],
    ['date', true],
    ['True / false', false],
    ['json', false],
    ['text', true],
  ] as const) {
    await event.click(screen.getByLabelText('Column type'));
    await event.click(await screen.findByRole('option', { name: type }));
    expect(await offeredKeys(event), type).toEqual(
      eligible ? ['No unique key', 'order_id'] : ['No unique key'],
    );
  }
});
