import type { FormField } from '@pertexo/workflow-model';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';

export function FormFieldControl({
  field,
  id,
  value,
  error,
  onChange,
}: Readonly<{
  field: FormField;
  id: string;
  value: string | boolean | undefined;
  error: string | undefined;
  onChange: (value: string | boolean) => void;
}>) {
  const text = typeof value === 'string' ? value : '';
  return (
    <LabelledField
      id={id}
      label={`${field.label}${field.required ? '' : ' (optional)'}`}
      description={field.help || undefined}
      error={error}
    >
      {(control) =>
        field.type === 'boolean' ? (
          <Checkbox
            {...control}
            checked={value === true}
            onCheckedChange={(checked) => {
              onChange(checked);
            }}
          />
        ) : field.type === 'select' ? (
          <select
            {...control}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
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
        ) : field.type === 'textarea' ? (
          <Textarea
            {...control}
            value={text}
            maxLength={10000}
            rows={4}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        ) : (
          <Input
            {...control}
            type={
              field.type === 'number'
                ? 'number'
                : field.type === 'date'
                  ? 'date'
                  : field.type === 'email'
                    ? 'email'
                    : 'text'
            }
            {...(field.type === 'number'
              ? { step: 'any' }
              : { maxLength: 10000 })}
            value={text}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        )
      }
    </LabelledField>
  );
}
