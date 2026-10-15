import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { formFieldsSchema } from '@pertexo/workflow-model';
import { FormResponse } from '@/features/forms/components/response';
const fields = formFieldsSchema.parse([
  { id: 'amount', name: 'amount', label: 'Amount', type: 'number' },
  { id: 'ready', name: 'ready', label: 'Ready', type: 'boolean' },
  {
    id: 'notes',
    name: 'notes',
    label: 'Notes',
    type: 'textarea',
    required: false,
  },
]);
it('preserves zero and false, omits blank optional input and reports required errors before sending', async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  render(<FormResponse fields={fields} onSubmit={send} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Send response' }));
  expect(send).not.toHaveBeenCalled();
  await screen.findByText('Enter a valid value for this field.');
  await user.type(screen.getByLabelText('Amount', { exact: true }), '0');
  await user.click(screen.getByRole('button', { name: 'Send response' }));
  await waitFor(() => {
    expect(send).toHaveBeenCalledWith({ amount: 0, ready: false });
  });
});
it('prevents changes and submissions while a response outcome is unresolved', async () => {
  const send = vi.fn();
  render(<FormResponse fields={fields} disabled onSubmit={send} />);
  expect(screen.getByLabelText('Amount', { exact: true })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Send response' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Send response' }));
  expect(send).not.toHaveBeenCalled();
});
it('initializes typed prefills once without replacing local edits on refetch', async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const { rerender } = render(
    <FormResponse
      fields={fields}
      initialValues={{ amount: 0, ready: false, notes: 'Captured context' }}
      onSubmit={send}
    />,
  );
  const user = userEvent.setup();
  expect(screen.getByLabelText('Amount', { exact: true })).toHaveValue(0);
  expect(screen.getByRole('checkbox', { name: 'Ready' })).not.toBeChecked();
  const notes = screen.getByLabelText('Notes (optional)', { exact: true });
  await user.clear(notes);
  await user.type(notes, 'My correction');
  rerender(
    <FormResponse
      fields={fields}
      initialValues={{ amount: 99, ready: true, notes: 'New server response' }}
      onSubmit={send}
    />,
  );
  expect(notes).toHaveValue('My correction');
  await user.click(screen.getByRole('button', { name: 'Send response' }));
  await waitFor(() => {
    expect(send).toHaveBeenCalledWith({
      amount: 0,
      ready: false,
      notes: 'My correction',
    });
  });
});
