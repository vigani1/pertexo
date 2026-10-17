import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { AuditFilters } from '@/features/governance/components/filters';
it('labels fields, waits until submission to validate, and sends plain filters', async () => {
  const onApply = vi.fn(),
    user = userEvent.setup();
  render(<AuditFilters filters={{}} onApply={onApply} />);
  await user.type(screen.getByLabelText('Target ID'), 'invalid');
  expect(screen.queryByText('Invalid UUID')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Apply filters' }));
  expect(onApply).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Target ID')).toHaveFocus();
  await user.clear(screen.getByLabelText('Target ID'));
  await user.type(screen.getByLabelText('Person name'), 'Alice');
  await user.click(screen.getByRole('button', { name: 'Apply filters' }));
  expect(onApply).toHaveBeenCalledWith({ person: 'Alice' });
});
