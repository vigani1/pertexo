import { createRef, useState, type Ref } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MappingSourceEditor } from '@/features/workflow-editor/components/inspector/input-mappings/mapping-source-editor';
import { ChoiceSelect } from '@/features/workflow-editor/components/inspector/fields/choice-select';

function ChoiceHarness({
  disabled = false,
  inputRef,
  onChange = () => undefined,
}: Readonly<{
  disabled?: boolean;
  inputRef?: Ref<HTMLButtonElement>;
  onChange?: (value: string | null) => void;
}>) {
  const [value, setValue] = useState<string | null>('alpha');
  return (
    <form aria-label="Destination settings">
      <label htmlFor="destination">Destination</label>
      <p id="destination-hint">Choose where the step sends its output.</p>
      <ChoiceSelect
        value={value}
        choices={[
          { value: null, label: 'No source' },
          { value: 'alpha', label: 'Alpha' },
          { value: 'beta', label: 'Beta' },
        ]}
        disabled={disabled}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
        control={{
          id: 'destination',
          name: 'destination',
          ref: inputRef,
          invalid: true,
          describedBy: 'destination-hint',
        }}
      />
    </form>
  );
}

describe('inspector choice control', () => {
  it('keeps its label, feedback, form name and focus target', () => {
    const inputRef = createRef<HTMLButtonElement>();
    render(<ChoiceHarness inputRef={inputRef} />);
    const control = screen.getByRole('combobox', { name: 'Destination' });
    expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(control).toHaveAccessibleDescription(
      'Choose where the step sends its output.',
    );
    inputRef.current?.focus();
    expect(control).toHaveFocus();
    const form = screen.getByRole<HTMLFormElement>('form', {
      name: 'Destination settings',
    });
    expect(new FormData(form).get('destination')).toBe('alpha');
  });

  it('selects with the keyboard and can clear the source', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ChoiceHarness onChange={onChange} />);
    const control = screen.getByRole('combobox', { name: 'Destination' });
    await user.click(control);
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Alpha' })).toHaveFocus();
    });
    await user.keyboard('{End}');
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Beta' })).toHaveFocus();
    });
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('beta');
    expect(control).toHaveTextContent('Beta');
    await user.keyboard('{ArrowDown}');
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Beta' })).toHaveFocus();
    });
    await user.keyboard('{Home}');
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'No source' })).toHaveFocus();
    });
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('keeps a disabled choice closed', async () => {
    const user = userEvent.setup();
    render(<ChoiceHarness disabled />);
    const control = screen.getByRole('combobox', { name: 'Destination' });
    expect(control).toBeDisabled();
    await user.click(control);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('associates an unavailable source step with its error', () => {
    render(
      <MappingSourceEditor
        nodeId="target"
        row={{
          id: 'source',
          destinationKey: 'customer',
          kind: 'node_output',
          nodeId: 'missing',
          path: '',
        }}
        type={undefined}
        predecessors={[]}
        loopPorts={[]}
        error="Link the source step first."
        disabled={false}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('combobox', { name: 'Source step' }),
    ).toHaveAccessibleDescription('Link the source step first.');
  });

  it('associates an unavailable loop input with its error', () => {
    render(
      <MappingSourceEditor
        nodeId="target"
        row={{
          id: 'source',
          destinationKey: 'customer',
          kind: 'structured_input',
          port: 'old',
          path: '',
        }}
        type={undefined}
        predecessors={[]}
        loopPorts={[]}
        error="Choose an input from this loop."
        disabled={false}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('combobox', { name: 'Read' }),
    ).toHaveAccessibleDescription('Choose an input from this loop.');
  });
});
