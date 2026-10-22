import { NotificationsProvider } from '@/components/ui/toast';
import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { it, expect, vi } from 'vitest';
import { BusinessValueFilter } from '@/features/workflow-runs/components/run-filters/business-value';
import { RunBusinessValues } from '@/features/workflow-runs/components/run-detail/business-values';
import type { RunSearch } from '@/features/workflow-runs/model/list/run-search';
function Filter({
  onSearchChange,
}: {
  onSearchChange: (search: RunSearch) => void;
}) {
  const [search, setSearch] = useState<RunSearch>({ status: 'failed' });
  return (
    <BusinessValueFilter
      search={search}
      onSearchChange={(next) => {
        setSearch(next);
        onSearchChange(next);
      }}
    />
  );
}
it('applies exact values with existing filters, keeps them for the next search and preserves empty text', async () => {
  const user = userEvent.setup(),
    onSearchChange = vi.fn();
  render(<Filter onSearchChange={onSearchChange} />);
  await user.click(screen.getByRole('button', { name: 'Run value: any' }));
  const popup = await screen.findByRole('dialog', {
    name: 'Find runs by a saved value',
  });
  await user.type(within(popup).getByLabelText('Name'), 'orderId');
  await user.type(within(popup).getByLabelText('Value'), ' A-1042 ');
  await user.click(within(popup).getByRole('button', { name: 'Find runs' }));
  expect(onSearchChange).toHaveBeenLastCalledWith({
    status: 'failed',
    runValueKey: 'orderId',
    runValue: ' A-1042 ',
  });
  await user.click(
    screen.getByRole('button', { name: /^Run value: orderId is/u }),
  );
  const again = await screen.findByRole('dialog', {
    name: 'Find runs by a saved value',
  });
  expect(within(again).getByLabelText('Name')).toHaveValue('orderId');
  await user.clear(within(again).getByLabelText('Value'));
  await user.click(within(again).getByRole('button', { name: 'Find runs' }));
  expect(onSearchChange).toHaveBeenLastCalledWith({
    status: 'failed',
    runValueKey: 'orderId',
    runValue: '',
  });
});
it('says which part to fix and sends nothing for an invalid name', async () => {
  const user = userEvent.setup(),
    onSearchChange = vi.fn();
  render(<Filter onSearchChange={onSearchChange} />);
  await user.click(screen.getByRole('button', { name: 'Run value: any' }));
  const popup = await screen.findByRole('dialog', {
    name: 'Find runs by a saved value',
  });
  await user.type(within(popup).getByLabelText('Name'), 'order id');
  await user.click(within(popup).getByRole('button', { name: 'Find runs' }));
  expect(within(popup).getByLabelText('Name')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  expect(onSearchChange).not.toHaveBeenCalled();
});
it('shows saved values as plain text with an explicit empty value and copy action', async () => {
  render(
    <NotificationsProvider>
      <RunBusinessValues values={{ orderId: '<b>A-1042</b>', empty: '' }} />
    </NotificationsProvider>,
  );
  expect(screen.getByText('<b>A-1042</b>')).toBeInTheDocument();
  expect(screen.getByText('Empty text')).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Copy orderId' })).toBeVisible();
  });
});
