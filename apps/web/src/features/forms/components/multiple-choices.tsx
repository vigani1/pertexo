import type { RefCallback } from 'react';
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
  inputRef,
}: Readonly<{
  inputRef?: RefCallback<HTMLElement> | undefined;
  field: Extract<FormField, { type: 'multi_select' }>;
  id: string;
  value: readonly string[];
  error: string | undefined;
  disabled: boolean;
  onChange: (value: readonly string[]) => void;
}>) {
  const selected = new Set(value);
  const maximum = field.maxSelections ?? field.options.length;
  const minimum = Math.max(1, field.minSelections ?? 1);
  const limitId = `${id}-limits`;
  const helpId = field.help === '' ? undefined : `${id}-help`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const describedBy =
    [limitId, helpId, errorId].filter(Boolean).join(' ') || undefined;
  const isLocked = (option: string) =>
    !selected.has(option) && value.length >= maximum;
  // Correction focus goes to the first choice the person can still change;
  // at the selection limit, the unselected ones are disabled.
  const focusIndex = Math.max(
    0,
    field.options.findIndex((option) => !isLocked(option)),
  );
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
        {field.options.map((option, index) => (
          <label
            key={option}
            className="flex min-w-0 items-start gap-2 text-sm"
          >
            <Checkbox
              ref={index === focusIndex ? inputRef : undefined}
              checked={selected.has(option)}
              disabled={disabled || isLocked(option)}
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
      <FieldDescription id={limitId}>
        Choose {minimum}–{maximum} options.
        {field.required ? '' : ' You may leave this blank.'}
      </FieldDescription>
      {helpId === undefined ? null : (
        <FieldDescription id={helpId}>{field.help}</FieldDescription>
      )}
      {errorId === undefined ? null : (
        <FieldError id={errorId}>{error}</FieldError>
      )}
    </Field>
  );
}
