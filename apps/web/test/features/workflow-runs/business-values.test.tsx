import { NotificationsProvider } from '@/components/ui/toast';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { it, expect, vi } from 'vitest';
import { BusinessValueFilter } from '@/features/workflow-runs/components/run-filters/business-value';
import { RunBusinessValues } from '@/features/workflow-runs/components/run-detail/business-values';
it('applies exact values with existing filters and preserves empty text', async () => {
  const user = userEvent.setup(),
    onSearchChange = vi.fn();
  render(
    <BusinessValueFilter
      search={{ status: 'failed' }}
      onSearchChange={onSearchChange}
    />,
  );
  await user.click(screen.getByText('Run value'));
  await user.type(await screen.findByLabelText('Run value key'), 'orderId');
  await user.type(screen.getByLabelText('Exact value'), ' A-1042 ');
  await user.click(screen.getByRole('button', { name: 'Apply value filter' }));
  expect(onSearchChange).toHaveBeenLastCalledWith({
    status: 'failed',
    runValueKey: 'orderId',
    runValue: ' A-1042 ',
  });
  await user.clear(screen.getByLabelText('Exact value'));
  await user.click(screen.getByRole('button', { name: 'Apply value filter' }));
  expect(onSearchChange).toHaveBeenLastCalledWith({
    status: 'failed',
    runValueKey: 'orderId',
    runValue: '',
  });
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
