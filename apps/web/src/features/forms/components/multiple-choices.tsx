import type { FormField } from '@pertexo/workflow-model';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldError } from '@/components/ui/field';

export function MultipleChoices({
  field,
  id,
  value,
  error,
  disabled,
  onChange,
}: Readonly<{
  field: Pick<FormField, 'label' | 'required' | 'help'> &
    Readonly<{ options: readonly string[] }>;
  id: string;
  value: readonly string[];
  error: string | undefined;
  disabled: boolean;
  onChange: (value: readonly string[]) => void;
}>) {
  const selected = new Set(value);
  const helpId = field.help === '' ? undefined : `${id}-help`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const describedBy = [helpId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <Field data-invalid={error === undefined ? undefined : true}>
      <fieldset
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={error !== undefined}
        className="flex min-w-0 flex-col gap-3"
      >
        <legend className="mb-2 text-[0.8rem] font-semibold">
          {field.label}
          {field.required ? '' : ' (optional)'}
        </legend>
        {field.options.map((option) => (
          <label
            key={option}
            className="flex min-w-0 items-start gap-2 text-sm"
          >
            <Checkbox
              checked={selected.has(option)}
              disabled={disabled}
              onCheckedChange={(checked) => {
                const next = new Set(selected);
                if (checked) next.add(option);
                else next.delete(option);
                onChange(field.options.filter((item) => next.has(item)));
              }}
            />
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">
              {option}
            </span>
          </label>
        ))}
      </fieldset>
      {helpId === undefined ? null : (
        <FieldDescription id={helpId}>{field.help}</FieldDescription>
      )}
      {errorId === undefined ? null : (
        <FieldError id={errorId}>{error}</FieldError>
      )}
    </Field>
  );
}
