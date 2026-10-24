import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { formFieldSchema, type FormField } from '@pertexo/workflow-model';
import { FormFieldsEditor } from '@/features/forms/components/field-editor';

const base = {
  id: 'answer',
  name: 'answer',
  label: 'Answer',
  help: 'A field',
  required: true,
};

function Editor({
  initial,
  changed,
}: Readonly<{
  initial: readonly FormField[];
  changed: (fields: readonly FormField[]) => void;
}>) {
  const [fields, setFields] = useState(initial);
  return (
    <FormFieldsEditor
      fields={fields}
      onChange={(next) => {
        setFields(next);
        changed(next);
      }}
    />
  );
}

function mount(initial: readonly FormField[]) {
  const changed = vi.fn<(fields: readonly FormField[]) => void>();
  render(<Editor initial={initial} changed={changed} />);
  return changed;
}

it('moves and removes fields while retaining their editable values and order', async () => {
  const first = formFieldSchema.parse({
    ...base,
    id: 'first',
    name: 'first',
    label: 'First',
    type: 'text',
  });
  const second = formFieldSchema.parse({
    ...base,
    id: 'second',
    name: 'second',
    label: 'Second',
    type: 'number',
  });
  const changed = mount([first, second]);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Move field 1 down' }));
  expect(
    within(screen.getByRole('region', { name: 'Field 1' })).getByLabelText(
      'Label',
    ),
  ).toHaveValue('Second');
  expect(
    within(screen.getByRole('region', { name: 'Field 2' })).getByLabelText(
      'Label',
    ),
  ).toHaveValue('First');
  expect(changed).toHaveBeenLastCalledWith([second, first]);
  await user.click(screen.getByRole('button', { name: 'Remove field 2' }));
  expect(screen.queryByRole('region', { name: 'Field 2' })).toBeNull();
  expect(changed).toHaveBeenLastCalledWith([second]);
  expect(screen.getByRole('button', { name: 'Remove field 1' })).toBeDisabled();
});

it('keeps choice options across choice types and drops limits when changing type', async () => {
  const options = ['Red', 'Blue'];
  const changed = mount([
    formFieldSchema.parse({
      ...base,
      type: 'multi_select',
      options,
      minSelections: 1,
      maxSelections: 2,
    }),
  ]);
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText('Type'), 'select');
  expect(screen.getByLabelText('Options')).toHaveValue('Red\nBlue');
  expect(screen.queryByLabelText('Minimum selections')).toBeNull();
  expect(changed).toHaveBeenLastCalledWith([
    { ...base, type: 'select', options },
  ]);
  await user.selectOptions(screen.getByLabelText('Type'), 'multi_select');
  expect(screen.getByLabelText('Minimum selections')).toHaveAttribute(
    'placeholder',
    '1',
  );
  expect(screen.getByLabelText('Maximum selections')).toHaveAttribute(
    'placeholder',
    '2',
  );
  expect(changed).toHaveBeenLastCalledWith([
    { ...base, type: 'multi_select', options },
  ]);
  await user.selectOptions(screen.getByLabelText('Type'), 'text');
  expect(changed).toHaveBeenLastCalledWith([{ ...base, type: 'text' }]);
  await user.selectOptions(screen.getByLabelText('Type'), 'select');
  expect(screen.getByLabelText('Options')).toHaveValue('Option 1');
});

it('removes the consent requirement when unticked and restores it when ticked', async () => {
  const changed = mount([
    formFieldSchema.parse({ ...base, type: 'boolean', mustBeTicked: true }),
  ]);
  const user = userEvent.setup();
  const consent = screen.getByRole('checkbox', {
    name: 'Must be ticked to send',
  });
  await user.click(consent);
  expect(consent).not.toBeChecked();
  expect(changed).toHaveBeenLastCalledWith([{ ...base, type: 'boolean' }]);
  await user.click(consent);
  expect(consent).toBeChecked();
  expect(changed).toHaveBeenLastCalledWith([
    { ...base, type: 'boolean', mustBeTicked: true },
  ]);
});
