import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { NodeConfig, SchemaFieldSpec } from '../../model/inspector-draft';

export function SchemaField({
  field,
  value,
  nodeId,
  scratchValue,
  error,
  disabled,
  onChange,
  onScratchChange,
}: Readonly<{
  field: SchemaFieldSpec;
  value: NodeConfig[string] | undefined;
  nodeId: string;
  scratchValue?: string;
  error?: string;
  disabled: boolean;
  onChange: (value: NodeConfig[string]) => void;
  onScratchChange: (value: string) => void;
}>) {
  if (field.kind === 'boolean')
    return (
      <Field>
        <label className="flex items-center gap-3 text-sm">
          <input
            id={`config-${nodeId}-${field.key}`}
            type="checkbox"
            name={`config.${field.key}`}
            checked={value === true}
            disabled={disabled}
            onChange={(event) => {
              onChange(event.currentTarget.checked);
            }}
          />
          {field.label}
        </label>
      </Field>
    );
  if (field.options !== undefined)
    return (
      <Field>
        <FieldLabel htmlFor={`config-${nodeId}-${field.key}`}>
          {field.label}
        </FieldLabel>
        <select
          id={`config-${nodeId}-${field.key}`}
          name={`config.${field.key}`}
          autoComplete="off"
          className="recessed-control h-10 rounded-lg border px-3 text-base"
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.currentTarget.value);
          }}
        >
          <option value="">Choose a value</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </Field>
    );
  return (
    <Field data-invalid={error !== undefined}>
      <FieldLabel htmlFor={`config-${nodeId}-${field.key}`}>
        {field.label}
      </FieldLabel>
      <Input
        id={`config-${nodeId}-${field.key}`}
        name={`config.${field.key}`}
        autoComplete="off"
        type="text"
        inputMode={
          field.kind === 'number' || field.kind === 'integer'
            ? 'decimal'
            : undefined
        }
        value={
          field.kind === 'number' || field.kind === 'integer'
            ? scratchValue
            : typeof value === 'string' || typeof value === 'number'
              ? String(value)
              : ''
        }
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-describedby={
          error === undefined
            ? undefined
            : `config-${nodeId}-${field.key}-error`
        }
        onChange={(event) => {
          if (field.kind === 'number' || field.kind === 'integer')
            onScratchChange(event.currentTarget.value);
          else onChange(event.currentTarget.value);
        }}
      />
      {error === undefined ? null : (
        <FieldError id={`config-${nodeId}-${field.key}-error`}>
          {error}
        </FieldError>
      )}
    </Field>
  );
}
