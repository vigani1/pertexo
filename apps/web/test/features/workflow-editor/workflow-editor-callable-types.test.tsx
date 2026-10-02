import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CallableObjectTypeDescriptorV1 } from '@pertexo/workflow-model/callable-type-contract';
import { CallableTypeEditor } from '@/features/workflow-editor/components/inspector/callable-type-editor';
import {
  formatCallableType,
  parseCallableTypeText,
} from '@/features/workflow-editor/model/inspector/callable-type-editor';

const empty: CallableObjectTypeDescriptorV1 = {
  type: 'object',
  properties: {},
  required: [],
};
const named: CallableObjectTypeDescriptorV1 = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
};

function tooDeepText(): string {
  let nested: unknown = { type: 'string' };
  for (let index = 0; index < 8; index += 1)
    nested = { type: 'array', items: nested, maxItems: 1 };
  return JSON.stringify({
    type: 'object',
    properties: { deep: nested },
    required: [],
  });
}

describe('callable contract text', () => {
  it('reads and formats the shared portable descriptor without coercion', () => {
    expect(parseCallableTypeText(formatCallableType(named))).toEqual({
      ok: true,
      value: named,
    });
  });

  it.each([
    '{',
    'null',
    '[]',
    '{"type":"string"}',
    '{"type":"object","properties":{},"required":["missing"]}',
    '{"type":"object","properties":{"constructor":{"type":"string"}},"required":[]}',
    '{"type":"object","properties":{},"required":[],"additionalProperties":false}',
    '{"type":"object","properties":{"items":{"type":"array","items":{"type":"string"},"maxItems":1001}},"required":[]}',
  ])('rejects unsupported or malformed text: %s', (text) => {
    expect(parseCallableTypeText(text).ok).toBe(false);
  });

  it('uses the shared depth bound rather than accepting arbitrarily nested types', () => {
    expect(parseCallableTypeText(tooDeepText()).ok).toBe(false);
  });
});

describe('callable type inspector field', () => {
  it('applies valid text live without replacing its formatting, focus or cursor', () => {
    const applied = vi.fn();
    const scratch = vi.fn();
    function Editor() {
      const [value, setValue] = useState(empty);
      return (
        <CallableTypeEditor
          id="input-type"
          label="Input type"
          value={value}
          editable
          onScratchChange={scratch}
          onChange={(next) => {
            setValue(next);
            applied(next);
          }}
        />
      );
    }
    render(<Editor />);
    const input = screen.getByRole('textbox', { name: 'Input type' });
    input.focus();
    const text = JSON.stringify(named);
    fireEvent.change(input, {
      target: { value: text, selectionStart: 7, selectionEnd: 7 },
    });
    expect(applied).toHaveBeenLastCalledWith(named);
    expect(input).toHaveValue(text);
    expect(input).toHaveFocus();
    expect((input as HTMLTextAreaElement).selectionStart).toBe(7);
    expect(scratch).toHaveBeenLastCalledWith(false);
    expect(input).toHaveAttribute('aria-describedby', 'input-type-description');
  });

  it.each([
    '{',
    '{"type":"object","properties":{},"required":["missing"]}',
    tooDeepText(),
  ])(
    'retains invalid text until corrected and connects its blur error: %s',
    (text) => {
      const onChange = vi.fn();
      const scratch = vi.fn();
      render(
        <CallableTypeEditor
          id="result-type"
          label="Result type"
          value={empty}
          editable
          onChange={onChange}
          onScratchChange={scratch}
        />,
      );
      const input = screen.getByRole('textbox', { name: 'Result type' });
      fireEvent.change(input, { target: { value: text } });
      expect(input).toHaveValue(text);
      expect(onChange).not.toHaveBeenCalled();
      expect(scratch).toHaveBeenLastCalledWith(true);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      fireEvent.blur(input);
      expect(screen.getByRole('alert')).toHaveAttribute(
        'id',
        'result-type-error',
      );
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(input).toHaveAttribute(
        'aria-describedby',
        'result-type-description result-type-error',
      );
      fireEvent.change(input, { target: { value: formatCallableType(named) } });
      expect(onChange).toHaveBeenLastCalledWith(named);
      expect(scratch).toHaveBeenLastCalledWith(false);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(input).toHaveAttribute('aria-invalid', 'false');
    },
  );

  it('follows external undo without remounting the focused control', () => {
    const props = {
      id: 'input-type',
      label: 'Input type',
      editable: true,
      onChange: vi.fn(),
      onScratchChange: vi.fn(),
    };
    const { rerender } = render(
      <CallableTypeEditor {...props} value={named} />,
    );
    const input = screen.getByRole('textbox', { name: 'Input type' });
    input.focus();
    fireEvent.change(input, { target: { value: '{' } });
    fireEvent.blur(input);
    input.focus();
    rerender(<CallableTypeEditor {...props} value={empty} />);
    expect(screen.getByRole('textbox', { name: 'Input type' })).toBe(input);
    expect(input).toHaveFocus();
    expect(input).toHaveValue(formatCallableType(empty));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it('disables editing when the caller has no edit authority', () => {
    render(
      <CallableTypeEditor
        id="input-type"
        label="Input type"
        value={empty}
        editable={false}
        onChange={vi.fn()}
        onScratchChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Input type' })).toBeDisabled();
  });
});
