import { MultipleChoices } from './multiple-choices';
import type { FormField } from '@pertexo/workflow-model';
import { LabelledField } from '@/components/ui/field';
import type { FormDraftValue } from '../model/values';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { DateInput } from '@/components/ui/date-input';

export function FormFieldControl({
  field,
  id,
  value,
  error,
  disabled,
  onChange,
}: Readonly<{
  field: FormField;
  id: string;
  value: FormDraftValue | undefined;
  error: string | undefined;
  disabled: boolean;
  onChange: (value: FormDraftValue) => void;
}>) {
  if (field.type === 'multi_select')
    return (
      <MultipleChoices
        field={field}
        id={id}
        value={typeof value === 'object' ? value : []}
        error={error}
        disabled={disabled}
        onChange={onChange}
      />
    );
  const text = typeof value === 'string' ? value : '';
  return (
    <LabelledField
      id={id}
      label={`${field.label}${field.required ? '' : ' (optional)'}`}
      description={field.help || undefined}
      error={error}
    >
      {(control) => {
        if (field.type === 'boolean') {
          return (
            <Checkbox
              {...control}
              checked={value === true}
              disabled={disabled}
              onCheckedChange={(checked) => {
                onChange(checked);
              }}
            />
          );
        }
        if (field.type === 'select') {
          return (
            <select
              {...control}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-base focus-visible:outline-2 focus-visible:outline-ring md:text-sm"
              value={text}
              onChange={(event) => {
                onChange(event.target.value);
              }}
            >
              <option value="">Choose…</option>
              {field.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          );
        }
        if (field.type === 'date') {
          return (
            <DateInput
              control={control}
              value={text}
              disabled={disabled}
              onChange={onChange}
            />
          );
        }
        if (field.type === 'textarea') {
          return (
            <Textarea
              {...control}
              value={text}
              maxLength={10000}
              rows={4}
              onChange={(event) => {
                onChange(event.target.value);
              }}
            />
          );
        }
        return (
          <Input
            {...control}
            type={INPUT_TYPES[field.type] ?? 'text'}
            {...(field.type === 'number'
              ? { step: 'any' }
              : { maxLength: 10000 })}
            value={text}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        );
      }}
    </LabelledField>
  );
}

const INPUT_TYPES: Readonly<
  Partial<Record<FormField['type'], 'number' | 'email'>>
> = { number: 'number', email: 'email' };
