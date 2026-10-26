import { useState } from 'react';
import { PaperclipIcon } from 'lucide-react';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { FileDrop } from '@/components/ui/file-drop';
import { useRemovalFocus } from '@/lib/hooks/use-removal-focus';
import { cn } from '@/lib/utils';
import {
  acceptAttribute,
  acceptSummary,
  type FileField,
} from '../../model/files';
import type { UploadRow } from '../../model/uploads';
import { FileRow } from './row';

/**
 * A file question: a drop zone naming what fits, then one row per file. The
 * zone keeps its size as files arrive; a full field says so in place.
 */
export function FileFieldControl({
  field,
  id,
  rows,
  error,
  disabled,
  onAdd,
  onRemove,
  onRetry,
}: Readonly<{
  field: FileField;
  id: string;
  rows: readonly UploadRow[];
  error: string | undefined;
  disabled: boolean;
  /** Returns how many files did not fit. */
  onAdd: (files: readonly File[]) => number;
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
}>) {
  const [leftOut, setLeftOut] = useState(0);
  const { fallback, removeButton, removing } =
    useRemovalFocus<HTMLInputElement>();
  const taken = rows.filter((row) => row.phase !== 'failed');
  const attached = taken.length;
  const full = attached >= field.maxFiles;
  const settled = full && taken.every((row) => row.phase === 'ready');
  const summaryId = `${id}-accepts`;
  const helpId = field.help === '' ? undefined : `${id}-help`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const announced = rows
    .filter((row) => row.phase === 'ready' || row.phase === 'failed')
    .at(-1);
  return (
    <Field data-invalid={error === undefined ? undefined : true}>
      <FieldLabel htmlFor={id}>
        {field.label}
        {field.required ? '' : ' (optional)'}
      </FieldLabel>
      <FileDrop
        ref={fallback}
        id={id}
        // The field announces each file itself, below.
        announces={false}
        multiple={field.maxFiles > 1}
        accept={acceptAttribute(field)}
        disabled={disabled || full}
        aria-invalid={error !== undefined}
        aria-describedby={
          [summaryId, helpId, errorId].filter(Boolean).join(' ') || undefined
        }
        className={cn(
          'min-h-24 transition-[border-color,background-color,box-shadow] has-[[data-dragging=true]]:border-warning/80 has-[[data-dragging=true]]:bg-warning/[0.06] has-[[data-dragging=true]]:shadow-[0_0_0_4px_color-mix(in_srgb,var(--warning)_14%,transparent)] max-sm:min-h-28 motion-reduce:transition-none',
          full && 'border-solid opacity-100',
          settled && 'border-success/35 bg-success/[0.04]',
          error !== undefined && 'border-destructive/60',
        )}
        onChooseFiles={(files) => {
          setLeftOut(onAdd(files));
        }}
      >
        {({ dragging }) => (
          <div
            data-dragging={dragging}
            className="flex w-full min-w-0 items-center gap-3.5"
          >
            <span
              className={cn(
                'grid size-11 shrink-0 place-items-center rounded-full border border-surface-ink/10 bg-surface-ink/[0.04] text-action transition-transform duration-300 ease-unspool motion-reduce:transition-none',
                dragging && '-translate-y-0.5 -rotate-12 text-warning',
                settled && 'text-success',
              )}
            >
              <PaperclipIcon aria-hidden="true" className="size-5" />
            </span>
            <span className="min-w-0 text-sm">
              <DropPrompt
                field={field}
                dragging={dragging}
                full={full}
                settled={settled}
                attached={attached}
              />
              <span
                id={summaryId}
                className="mt-0.5 block text-[0.75rem] text-muted-foreground"
              >
                {acceptSummary(field)}
              </span>
            </span>
          </div>
        )}
      </FileDrop>
      {rows.length === 0 ? null : (
        <ul
          aria-label={`${field.label} files`}
          className="flex min-w-0 flex-col gap-2"
        >
          {rows.map((row) => (
            <FileRow
              key={row.key}
              row={row}
              disabled={disabled}
              removeRef={removeButton(row.key)}
              onRemove={() => {
                setLeftOut(0);
                removing(
                  rows.map((each) => each.key),
                  row.key,
                );
                onRemove(row.key);
              }}
              onRetry={() => {
                onRetry(row.key);
              }}
            />
          ))}
        </ul>
      )}
      <p className="sr-only" aria-live="polite">
        {announcement(announced)}
      </p>
      {leftOut === 0 ? null : (
        <FieldDescription>
          {leftOut === 1 ? 'One file was' : `${String(leftOut)} files were`}{' '}
          left out: this question takes up to {field.maxFiles}.
        </FieldDescription>
      )}
      {helpId === undefined ? null : (
        <FieldDescription id={helpId}>{field.help}</FieldDescription>
      )}
      {errorId === undefined ? null : (
        <FieldError id={errorId}>{error}</FieldError>
      )}
    </Field>
  );
}

function DropPrompt({
  field,
  dragging,
  full,
  settled,
  attached,
}: Readonly<{
  field: FileField;
  dragging: boolean;
  full: boolean;
  settled: boolean;
  attached: number;
}>) {
  const what = field.maxFiles - attached === 1 ? 'a file' : 'files';
  if (full)
    return (
      <span className="block font-medium">
        {settled ? fullPrompt(field) : 'Attaching…'}
      </span>
    );
  if (dragging)
    return <span className="block font-medium">Drop to attach</span>;
  return (
    <span className="block font-medium">
      <span className="max-sm:hidden">
        Drop {what} here or{' '}
        <span className="text-action underline decoration-action/40 underline-offset-4">
          choose
        </span>
      </span>
      <span className="sm:hidden">
        {field.accept.includes('images')
          ? `Choose ${what} or take a photo`
          : `Choose ${what}`}
      </span>
    </span>
  );
}

function fullPrompt(field: FileField): string {
  return field.maxFiles === 1
    ? 'File attached'
    : `All ${String(field.maxFiles)} files attached`;
}

function announcement(row: UploadRow | undefined): string {
  if (row === undefined) return '';
  return row.phase === 'ready'
    ? `${row.name} attached.`
    : `${row.name} not attached. ${row.error ?? ''}`;
}
