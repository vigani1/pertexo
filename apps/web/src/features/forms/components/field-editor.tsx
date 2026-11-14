import { useId } from 'react';
import {
  FORM_FILE_LIMITS,
  FORM_LIMITS,
  type FormField,
} from '@pertexo/workflow-model';
import { formatByteLength } from '@/lib/format/bytes';
import { formatCount } from '@/lib/format/count';
import { Button } from '@/components/ui/button';
import { FormFieldCard } from './field-card';

export function FormFieldsEditor({
  fields,
  onChange,
  disabled = false,
}: Readonly<{
  fields: readonly FormField[];
  onChange: (fields: readonly FormField[]) => void;
  disabled?: boolean;
}>) {
  const id = useId();
  function update(index: number, change: (field: FormField) => FormField) {
    onChange(fields.map((field, i) => (i === index ? change(field) : field)));
  }
  function move(index: number, direction: -1 | 1) {
    const next = [...fields];
    const current = next[index],
      other = next[index + direction];
    if (current === undefined || other === undefined) return;
    next[index] = other;
    next[index + direction] = current;
    onChange(next);
  }
  function add() {
    const names = new Set(fields.map((field) => field.name));
    let index = fields.length + 1;
    while (names.has(`field_${String(index)}`)) index++;
    onChange([
      ...fields,
      {
        id: crypto.randomUUID(),
        name: `field_${String(index)}`,
        label: `Field ${String(index)}`,
        type: 'text',
        help: '',
        required: true,
      },
    ]);
  }
  return (
    <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-4">
      <legend className="mb-3 font-medium">Form fields</legend>
      {fields.map((field, index) => (
        <FormFieldCard
          key={field.id}
          field={field}
          id={id}
          index={index}
          count={fields.length}
          disabled={disabled}
          onMove={(direction) => {
            move(index, direction);
          }}
          onRemove={() => {
            onChange(fields.filter((item) => item.id !== field.id));
          }}
          onUpdate={(change) => {
            update(index, change);
          }}
        />
      ))}
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={disabled || fields.length >= FORM_LIMITS.fields}
        onClick={add}
      >
        Add field
      </Button>
      <p className="text-xs text-muted-foreground">
        Up to {formatCount(FORM_LIMITS.fields, 'field')}. A file question takes
        up to {formatCount(FORM_FILE_LIMITS.maxFiles, 'file')} of up to{' '}
        {formatByteLength(FORM_FILE_LIMITS.maxBytes)} each; files are not
        virus-checked.
      </p>
    </fieldset>
  );
}
