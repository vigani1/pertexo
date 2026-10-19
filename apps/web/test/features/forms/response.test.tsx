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
  await screen.findByText('This field is required.');
  await user.type(screen.getByLabelText('Amount', { exact: true }), '0');
  await user.click(screen.getByRole('button', { name: 'Send response' }));
  await waitFor(() => {
    expect(send).toHaveBeenCalledWith({ amount: 0, ready: false });
  });
});
it('asks for a tick on a must-be-ticked box before sending', async () => {
  const consent = formFieldsSchema.parse([
    {
      id: 'agree',
      name: 'agree',
      label: 'I agree to the terms',
      type: 'boolean',
      mustBeTicked: true,
    },
  ]);
  const send = vi.fn().mockResolvedValue(undefined);
  render(<FormResponse fields={consent} onSubmit={send} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Send response' }));
  expect(await screen.findByText('Tick this box to continue.')).toBeVisible();
  expect(send).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole('checkbox', { name: 'I agree to the terms' }),
  );
  await user.click(screen.getByRole('button', { name: 'Send response' }));
  await waitFor(() => {
    expect(send).toHaveBeenCalledWith({ agree: true });
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

const choices = formFieldsSchema.parse([
  {
    id: 'channels',
    name: 'channels',
    label: 'Channels',
    help: 'Choose the channels to use.',
    type: 'multi_select',
    options: ['Email', 'SMS'],
  },
]);
it('renders labelled multiple choices, requires a choice and submits configured order', async () => {
  const send = vi.fn().mockResolvedValue(undefined),
    user = userEvent.setup();
  render(<FormResponse fields={choices} onSubmit={send} />);
  expect(
    screen.getByRole('group', { name: 'Channels' }),
  ).toHaveAccessibleDescription(
    'Choose 1–2 options. Choose the channels to use.',
  );
  await user.click(screen.getByRole('button', { name: 'Send response' }));
  expect(send).not.toHaveBeenCalled();
  await screen.findByText('Choose 1–2 different available options.');
  await user.click(screen.getByRole('checkbox', { name: 'SMS' }));
  await user.click(screen.getByRole('checkbox', { name: 'Email' }));
  await user.click(screen.getByRole('button', { name: 'Send response' }));
  await waitFor(() => {
    expect(send).toHaveBeenCalledWith({ channels: ['Email', 'SMS'] });
  });
});
it('keeps editable array prefills once and prevents disabled checkbox changes', async () => {
  const send = vi.fn().mockResolvedValue(undefined),
    user = userEvent.setup();
  const view = render(
    <FormResponse
      fields={choices}
      initialValues={{ channels: ['Email'] }}
      onSubmit={send}
    />,
  );
  const email = screen.getByRole('checkbox', { name: 'Email' }),
    sms = screen.getByRole('checkbox', { name: 'SMS' });
  expect(email).toBeChecked();
  await user.click(sms);
  view.rerender(
    <FormResponse
      fields={choices}
      initialValues={{ channels: [] }}
      onSubmit={send}
    />,
  );
  expect(email).toBeChecked();
  expect(sms).toBeChecked();
  view.rerender(
    <FormResponse
      fields={choices}
      initialValues={{ channels: [] }}
      disabled
      onSubmit={send}
    />,
  );
  expect(email).toHaveAttribute('aria-disabled', 'true');
  await user.click(email);
  expect(email).toBeChecked();
});

it('enforces selection limits visibly without locking selected choices', async () => {
  const bounded = formFieldsSchema.parse([
    {
      id: 'channels',
      name: 'channels',
      label: 'Channels',
      type: 'multi_select',
      options: ['Email', 'SMS', 'Chat'],
      minSelections: 2,
      maxSelections: 2,
    },
  ]);
  const send = vi.fn().mockResolvedValue(undefined),
    user = userEvent.setup();
  render(
    <FormResponse
      fields={bounded}
      onSubmit={send}
      initialValues={{ channels: ['Email'] }}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Send response' }));
  expect(send).not.toHaveBeenCalled();
  await screen.findByText('Choose 2 different available options.');
  await user.click(screen.getByRole('checkbox', { name: 'SMS' }));
  expect(screen.getByRole('checkbox', { name: 'Chat' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await user.click(screen.getByRole('checkbox', { name: 'Email' }));
  expect(screen.getByRole('checkbox', { name: 'Chat' })).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await user.click(screen.getByRole('checkbox', { name: 'Chat' }));
  await user.click(screen.getByRole('button', { name: 'Send response' }));
  expect(send).toHaveBeenCalledWith({ channels: ['SMS', 'Chat'] });
});
