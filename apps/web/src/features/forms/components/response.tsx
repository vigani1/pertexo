import { FormFieldControl } from './field-control';
import { FileFieldControl } from './files/field';
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
import type { FormUploadTarget } from '../data/uploads.api';
import { useFormUploads } from '../hooks/use-form-uploads';

export function FormResponse({
  fields,
  onSubmit,
  pending = false,
  disabled = false,
  submitLabel = 'Send response',
  initialValues,
  uploads: target,
}: Readonly<{
  fields: readonly FormField[];
  onSubmit: (values: FormValues) => Promise<void>;
  pending?: boolean;
  disabled?: boolean;
  submitLabel?: string;
  initialValues?: FormValues;
  /** Where this response's files go; without it file questions can't attach. */
  uploads?: FormUploadTarget | undefined;
}>) {
  const id = useId();
  const uploads = useFormUploads(target);
  const [draft, setDraft] = useState<FormDraft>(() =>
    draftFromValues(initialValues),
  );
  const [errors, setErrors] = useState<
    readonly Readonly<{ name: string; message: string }>[]
  >([]);
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || pending || uploads.pending) return;
    let values: FormValues;
    try {
      values = parseFormValues(fields, {
        ...valuesFromDraft(fields, draft),
        ...Object.fromEntries(
          fields
            .filter((field) => field.type === 'file')
            .map((field) => [field.name, uploads.uploadIds(field)]),
        ),
      });
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
  function clearError(name: string) {
    setErrors((previous) =>
      previous.filter((issue) => issue.name !== name && issue.name !== ''),
    );
  }
  function change(name: string, value: FormDraftValue) {
    setDraft((previous) => ({ ...previous, [name]: value }));
    clearError(name);
  }
  const waitingId = `${id}-waiting`;
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
        {fields.map((field) =>
          field.type === 'file' ? (
            <FileFieldControl
              key={field.id}
              field={field}
              id={`${id}-${field.name}`}
              rows={uploads.rows[field.name] ?? []}
              disabled={disabled || pending}
              error={errorByName.get(field.name)}
              onAdd={(files) => {
                clearError(field.name);
                return uploads.add(field, files);
              }}
              onRemove={(key) => {
                clearError(field.name);
                uploads.remove(field, key);
              }}
              onRetry={uploads.retry}
            />
          ) : (
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
          ),
        )}
      </fieldset>
      {errorByName.has('') ? (
        <Notice tone="destructive">{errorByName.get('')}</Notice>
      ) : null}
      <div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-2">
        <ProgressButton
          type="submit"
          pending={pending}
          pendingLabel="Sending…"
          disabled={disabled || pending || uploads.pending}
          aria-describedby={uploads.pending ? waitingId : undefined}
        >
          {submitLabel}
        </ProgressButton>
        {uploads.pending ? (
          <p id={waitingId} className="text-sm text-muted-foreground">
            Waiting for files to finish uploading.
          </p>
        ) : null}
      </div>
    </form>
  );
}
