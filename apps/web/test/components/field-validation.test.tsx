import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LabelledField } from '../../src/components/ui/field';
import { Input } from '../../src/components/ui/input';
import {
  useFieldValidation,
  useFieldValues,
} from '../../src/components/ui/use-field-validation';

const required = (label: string) => (value: string) =>
  value.trim() === '' ? `Enter ${label}.` : undefined;

function CallerOwnedForm({
  serverErrors,
}: Readonly<{ serverErrors?: { first?: string; second?: string } }>) {
  const validation = useFieldValidation<'first' | 'second'>();
  const [values, setValues] = useState({ first: '', second: '' });
  const rule = { first: required('a first name'), second: required('a code') };
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (
          validation.submit({
            first: rule.first(values.first),
            second: rule.second(values.second),
          }) &&
          serverErrors !== undefined
        )
          validation.showErrors(serverErrors);
      }}
    >
      {/* Rendered out of name order: focus follows the document. */}
      {(['second', 'first'] as const).map((name) => (
        <LabelledField
          key={name}
          id={name}
          label={name === 'first' ? 'First name' : 'Code'}
          error={validation.error(name)}
          thread={validation.thread(name)}
        >
          {(control) => (
            <Input
              {...control}
              ref={validation.register(name)}
              value={values[name]}
              onChange={(event) => {
                const next = { ...values, [name]: event.target.value };
                setValues(next);
                validation.change(name, rule[name](next[name]));
              }}
              onBlur={() => {
                validation.blur(name, rule[name](values[name]));
              }}
            />
          )}
        </LabelledField>
      ))}
      <button type="submit">Save</button>
    </form>
  );
}

function PasswordForm() {
  const fields = useFieldValues(
    {
      password: required('a password'),
      confirmation: (value, values) =>
        value === values.password ? undefined : 'The passwords don’t match.',
    },
    { password: '', confirmation: '' },
  );
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        fields.validate();
      }}
    >
      {(['password', 'confirmation'] as const).map((name) => (
        <LabelledField
          key={name}
          id={name}
          label={name === 'password' ? 'Password' : 'Confirm password'}
          {...fields.field(name)}
        >
          {(control) => <Input {...control} {...fields.control(name)} />}
        </LabelledField>
      ))}
      <button type="submit">Save</button>
    </form>
  );
}

function thread(label: string) {
  return screen
    .getByLabelText(label)
    .closest('[data-slot="field-control"]')
    ?.getAttribute('data-state');
}

describe('field validation', () => {
  it('checks on blur, then live, and ties a knot once corrected', async () => {
    const user = userEvent.setup();
    render(<CallerOwnedForm />);
    const first = screen.getByLabelText('First name');
    await user.click(first);
    await user.tab();
    expect(first).toHaveAttribute('aria-invalid', 'true');
    expect(first).toHaveAccessibleDescription('Enter a first name.');
    expect(thread('First name')).toBe('invalid');

    await user.type(first, 'A');
    expect(first).toHaveAttribute('aria-invalid', 'false');
    expect(thread('First name')).toBe('corrected');
    await user.type(first, 'da');
    expect(thread('First name')).toBe('corrected');
    // Untouched fields stay quiet while another is corrected.
    expect(screen.getByLabelText('Code')).toHaveAttribute(
      'aria-invalid',
      'false',
    );
  });

  it('focuses the first invalid field in document order and then goes live', async () => {
    const user = userEvent.setup();
    render(<CallerOwnedForm />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByLabelText('Code')).toHaveFocus();
    expect(screen.getAllByRole('alert')).toHaveLength(2);

    await user.type(screen.getByLabelText('Code'), 'X');
    expect(screen.getByLabelText('Code')).toHaveAttribute(
      'aria-invalid',
      'false',
    );
  });

  it('places server field errors and focuses the first of them', async () => {
    const user = userEvent.setup();
    render(<CallerOwnedForm serverErrors={{ first: 'That name is taken.' }} />);
    await user.type(screen.getByLabelText('Code'), 'X');
    await user.type(screen.getByLabelText('First name'), 'Ada');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.getByLabelText('First name')).toHaveFocus();
    });
    expect(screen.getByLabelText('First name')).toHaveAccessibleDescription(
      'That name is taken.',
    );
  });

  it('re-checks a confirmation when the value it repeats changes', async () => {
    const user = userEvent.setup();
    render(<PasswordForm />);
    await user.type(screen.getByLabelText('Password'), 'woven-thread');
    await user.type(screen.getByLabelText('Confirm password'), 'woven');
    await user.tab();
    expect(
      screen.getByLabelText('Confirm password'),
    ).toHaveAccessibleDescription('The passwords don’t match.');

    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), 'woven');
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute(
      'aria-invalid',
      'false',
    );
    expect(thread('Confirm password')).toBe('corrected');
  });
});
