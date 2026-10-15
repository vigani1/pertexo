import { useId, useState, type SubmitEvent } from 'react';
import {
  parseFormValues,
  FormValuesInvalidError,
  type FormField,
  type FormValues,
} from '@pertexo/workflow-model';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { ProgressButton } from '@/components/ui/progress-button';
import { Notice } from '@/components/ui/notice';
import { valuesFromDraft } from '../model/values';
export function FormResponse({
  fields,
  onSubmit,
  pending = false,
  disabled = false,
  submitLabel = 'Send response',
}: Readonly<{
  fields: readonly FormField[];
  onSubmit: (values: FormValues) => Promise<void>;
  pending?: boolean;
  disabled?: boolean;
  submitLabel?: string;
}>) {
  const id = useId();
  const [draft, setDraft] = useState<
    Readonly<Record<string, string | boolean>>
  >({});
  const [errors, setErrors] = useState<
    readonly Readonly<{ name: string; message: string }>[]
  >([]);
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || pending) return;
    let values: FormValues;
    try {
      values = parseFormValues(fields, valuesFromDraft(fields, draft));
    } catch (error) {
      if (error instanceof FormValuesInvalidError) {
        setErrors(error.fields);
        return;
      }
      throw error;
    }
    setErrors([]);
    await onSubmit(values);
  }
  const errorByName = new Map(
    errors.map((issue) => [issue.name, issue.message]),
  );
  function textValue(name: string) {
    const value = draft[name];
    return typeof value === 'string' ? value : '';
  }
  function change(name: string, value: string | boolean) {
    setDraft((previous) => ({ ...previous, [name]: value }));
    setErrors((previous) =>
      previous.filter((issue) => issue.name !== name && issue.name !== ''),
    );
  }
  return (
    <form
      onSubmit={(event) => void submit(event)}
      noValidate
      className="flex flex-col gap-5"
    >
      <fieldset
        disabled={disabled || pending}
        className="flex min-w-0 flex-col gap-5"
      >
        {fields.map((field) => (
          <LabelledField
            key={field.id}
            id={`${id}-${field.name}`}
            label={`${field.label}${field.required ? '' : ' (optional)'}`}
            description={field.help || undefined}
            error={errorByName.get(field.name)}
          >
            {(control) =>
              field.type === 'boolean' ? (
                <Checkbox
                  {...control}
                  checked={draft[field.name] === true}
                  onCheckedChange={(checked) => {
                    change(field.name, checked);
                  }}
                />
              ) : field.type === 'select' ? (
                <select
                  {...control}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                  value={textValue(field.name)}
                  onChange={(event) => {
                    change(field.name, event.target.value);
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
                  value={textValue(field.name)}
                  maxLength={10000}
                  rows={4}
                  onChange={(event) => {
                    change(field.name, event.target.value);
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
                  value={textValue(field.name)}
                  onChange={(event) => {
                    change(field.name, event.target.value);
                  }}
                />
              )
            }
          </LabelledField>
        ))}
      </fieldset>
      {errorByName.has('') ? (
        <Notice tone="destructive">{errorByName.get('')}</Notice>
      ) : null}
      <ProgressButton
        type="submit"
        pending={pending}
        pendingLabel="Sending…"
        disabled={disabled || pending}
        className="self-start"
      >
        {submitLabel}
      </ProgressButton>
    </form>
  );
}
