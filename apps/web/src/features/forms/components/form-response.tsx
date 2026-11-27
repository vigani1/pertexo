import { isApiError } from '@/lib/api/error';
import { formatCount } from '@/lib/format/count';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { FormFieldControl } from './field-control';
import { FileFieldControl } from './files/field';
import {
  useEffect,
  useEffectEvent,
  useId,
  useState,
  type ReactNode,
  type SubmitEvent,
} from 'react';
import {
  parseFormValues,
  FormValuesInvalidError,
  type FormField,
  type FormValues,
} from '@pertexo/workflow-model';
import { ProgressButton } from '@/components/ui/progress-button';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { cn } from '@/lib/class-names';
import { Notice } from '@/components/patterns/notices/inline-notice';
import {
  draftFromValues,
  valuesFromDraft,
  type FormDraft,
  type FormDraftValue,
} from '../model/form-values';
import type { FormUploadTarget } from '../data/form-uploads.api';
import { useFormUploads } from '../data/form-uploads.mutations';

type FormResponseProps = Readonly<{
  serverError?: unknown;
  intro?: ReactNode;
  fields: readonly FormField[];
  onSubmit: (values: FormValues) => Promise<void>;
  pending?: boolean;
  disabled?: boolean;
  submitLabel?: string;
  initialValues?: FormValues;
  /** Where this response's files go; without it file questions can't attach. */
  uploads?: FormUploadTarget | undefined;
}>;

export function FormResponse({
  fields,
  pending = false,
  disabled = false,
  submitLabel = 'Send response',
  intro,
  ...submission
}: FormResponseProps) {
  const id = useId();
  const { uploads, draft, validation, submit, clearError, change } =
    useResponseDraft({ fields, pending, disabled, ...submission });
  const answered = new Set(
    fields
      .filter((field) => {
        if (field.type === 'file') return uploads.uploadIds(field).length > 0;
        const value = draft[field.name];
        if (field.type === 'boolean' && field.mustBeTicked === true)
          return value === true;
        return (
          typeof value === 'boolean' ||
          (typeof value === 'string'
            ? value.trim() !== ''
            : (value?.length ?? 0) > 0)
        );
      })
      .map((field) => field.name),
  );
  const remaining = fields.filter(
    (field) => field.required && !answered.has(field.name),
  ).length;
  const waitingId = `${id}-waiting`;
  return (
    <form
      onSubmit={(event) => void submit(event)}
      noValidate
      className={cn(
        'grid min-w-0 gap-8',
        intro !== undefined &&
          'md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:gap-12 lg:gap-18',
      )}
    >
      {intro === undefined ? null : (
        <ResponseIntro answered={answered.size} total={fields.length}>
          {intro}
        </ResponseIntro>
      )}
      <div className="flex min-w-0 flex-col gap-5">
        <fieldset
          disabled={disabled || pending}
          className="flex min-w-0 flex-col gap-5"
        >
          {fields.map((field) => (
            <ResponseField
              key={field.id}
              threaded={intro !== undefined}
              answered={answered.has(field.name)}
            >
              {field.type === 'file' ? (
                <FileFieldControl
                  field={field}
                  id={`${id}-${field.name}`}
                  inputRef={validation.register(field.name)}
                  rows={uploads.rows[field.name] ?? []}
                  disabled={disabled || pending}
                  error={validation.error(field.name)}
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
                  field={field}
                  id={`${id}-${field.name}`}
                  inputRef={validation.register(field.name)}
                  value={draft[field.name]}
                  disabled={disabled || pending}
                  error={validation.error(field.name)}
                  onChange={(value) => {
                    change(field.name, value);
                  }}
                />
              )}
            </ResponseField>
          ))}
        </fieldset>
        {validation.error('') !== undefined ? (
          <Notice tone="destructive">{validation.error('')}</Notice>
        ) : null}
        <div
          className={cn(
            'flex min-h-9 flex-wrap items-center gap-x-4 gap-y-2',
            intro !== undefined && 'relative pl-8',
          )}
        >
          {intro === undefined ? null : (
            <StatusMark
              display="mark"
              tone="neutral"
              className="absolute top-2 left-0"
            />
          )}
          <ProgressButton
            type="submit"
            variant={intro === undefined ? 'default' : 'primary'}
            pending={pending}
            pendingLabel="Sending…"
            disabled={disabled || pending || uploads.pending}
            aria-describedby={uploads.pending ? waitingId : undefined}
          >
            {submitLabel}
          </ProgressButton>
          {intro === undefined || remaining === 0 ? null : (
            <p className="text-meta text-muted-foreground">
              {formatCount(remaining, 'required answer')} left.
            </p>
          )}
          {uploads.pending ? (
            <p id={waitingId} className="text-sm text-muted-foreground">
              Waiting for files to finish uploading.
            </p>
          ) : null}
        </div>
      </div>
    </form>
  );
}

function ResponseIntro({
  answered,
  total,
  children,
}: Readonly<{ answered: number; total: number; children: ReactNode }>) {
  return (
    <div className="flex min-w-0 flex-col gap-6 self-start md:sticky md:top-12">
      {children}
      {total === 0 ? null : (
        <label className="flex w-55 max-w-full flex-col gap-2 font-mono text-meta text-muted-foreground">
          {answered} of {total} answered
          <progress
            className="h-1.5 w-full appearance-none overflow-hidden rounded-full bg-select-raised [&::-webkit-progress-bar]:bg-select-raised [&::-webkit-progress-value]:bg-action [&::-moz-progress-bar]:bg-action"
            max={total}
            value={answered}
          />
        </label>
      )}
    </div>
  );
}

function ResponseField({
  answered,
  threaded,
  children,
}: Readonly<{ answered: boolean; threaded: boolean; children: ReactNode }>) {
  return (
    <div
      className={cn(
        threaded &&
          'relative pl-8 before:absolute before:top-5 before:bottom-[-1.25rem] before:left-2.5 before:border-l before:border-dashed before:border-border-strong',
      )}
    >
      {threaded ? (
        <StatusMark
          display="mark"
          tone={answered ? 'success' : 'neutral'}
          className="absolute top-0.5 left-0"
        />
      ) : null}
      {children}
    </div>
  );
}

function useResponseDraft({
  fields,
  onSubmit,
  pending,
  disabled,
  initialValues,
  uploads: target,
  serverError,
}: Omit<FormResponseProps, 'intro' | 'submitLabel'>) {
  const uploads = useFormUploads(target);
  const [draft, setDraft] = useState<FormDraft>(() =>
    draftFromValues(initialValues),
  );
  const validation = useFieldValidation<string>();
  const showServerError = useEffectEvent((cause: unknown) => {
    if (!isApiError(cause)) return;
    const known = new Set(fields.map((field) => field.name));
    const issues = cause.problem?.errors?.filter((issue) =>
      known.has(issue.path),
    );
    if (issues !== undefined && issues.length > 0)
      validation.showErrors(
        Object.fromEntries(issues.map((issue) => [issue.path, issue.message])),
      );
  });
  useEffect(() => {
    showServerError(serverError);
  }, [serverError]);
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
        validation.submit(
          Object.fromEntries(
            error.fields.map((issue) => [issue.name, issue.message]),
          ),
        );
        return;
      }
      throw error;
    }
    validation.reset();
    await onSubmit(values);
  }
  function clearError(name: string) {
    validation.change(name, undefined);
    validation.change('', undefined);
  }
  function change(name: string, value: FormDraftValue) {
    setDraft((previous) => ({ ...previous, [name]: value }));
    clearError(name);
  }
  return { uploads, draft, validation, submit, clearError, change };
}
