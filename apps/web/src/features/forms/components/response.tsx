import { FormFieldControl } from './field-control';
import { useId, useState, type SubmitEvent } from 'react';
import {
  parseFormValues,
  FormValuesInvalidError,
  type FormField,
  type FormValues,
} from '@pertexo/workflow-model';
import { ProgressButton } from '@/components/ui/progress-button';
import { Notice } from '@/components/ui/notice';
import {
  draftFromValues,
  valuesFromDraft,
  type FormDraft,
  type FormDraftValue,
} from '../model/values';
export function FormResponse({
  fields,
  onSubmit,
  pending = false,
  disabled = false,
  submitLabel = 'Send response',
  initialValues,
}: Readonly<{
  fields: readonly FormField[];
  onSubmit: (values: FormValues) => Promise<void>;
  pending?: boolean;
  disabled?: boolean;
  submitLabel?: string;
  initialValues?: FormValues;
}>) {
  const id = useId();
  const [draft, setDraft] = useState<FormDraft>(() =>
    draftFromValues(initialValues),
  );
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
  function change(name: string, value: FormDraftValue) {
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
          <FormFieldControl
            key={field.id}
            field={field}
            id={`${id}-${field.name}`}
            value={draft[field.name]}
            disabled={disabled || pending}
            error={errorByName.get(field.name)}
            onChange={(value) => {
              change(field.name, value);
            }}
          />
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
