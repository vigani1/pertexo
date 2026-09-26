import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { FieldParseResult } from '../../../model/inspector-draft';
import type { NodeFormApi } from '../../../model/node-form';
import { useLiveField } from '../../../use-live-field';

/** One entry of a setup list: a numbered card with its own controls. */
export function BuilderCard({
  title,
  port,
  actions,
  children,
}: Readonly<{
  title: string;
  /** The output or ID the entry stands for, as the canvas shows it. */
  port?: string;
  actions: ReactNode;
  children: ReactNode;
}>) {
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border bg-white/[0.02] p-3">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <p className="flex min-w-0 items-baseline gap-2 text-sm font-semibold">
          {title}
          {port === undefined ? null : (
            <span className="font-mono text-[0.7rem] font-normal text-subtle-foreground">
              {port}
            </span>
          )}
        </p>
        <div className="flex items-center gap-0.5">{actions}</div>
      </div>
      {children}
    </li>
  );
}

/** Move up, move down and remove, for an entry whose order matters. */
export function EntryActions({
  label,
  first,
  last,
  canRemove,
  removeHint,
  editable,
  onMove,
  onRemove,
}: Readonly<{
  /** The entry in words, e.g. "case 2". */
  label: string;
  first: boolean;
  last: boolean;
  canRemove: boolean;
  /** Why it can't be removed, when it can't. */
  removeHint?: string;
  editable: boolean;
  onMove?: (by: -1 | 1) => void;
  onRemove: () => void;
}>) {
  return (
    <>
      {onMove === undefined ? null : (
        <>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Move ${label} up`}
            disabled={!editable || first}
            onClick={() => {
              onMove(-1);
            }}
          >
            <ArrowUpIcon />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Move ${label} down`}
            disabled={!editable || last}
            onClick={() => {
              onMove(1);
            }}
          >
            <ArrowDownIcon />
          </Button>
        </>
      )}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={`Remove ${label}`}
        title={canRemove ? undefined : removeHint}
        disabled={!editable || !canRemove}
        onClick={onRemove}
      >
        <Trash2Icon />
      </Button>
    </>
  );
}

/**
 * A text box inside a setup list that applies each valid value as people
 * type, like every other inspector field, and says what's wrong once they
 * leave it.
 */
export function LiveTextField<Value>({
  id,
  label,
  hint,
  value,
  format,
  parse,
  form,
  scratchKey,
  mono = false,
  inputMode,
  placeholder,
  className,
  equals,
  onCommit,
}: Readonly<{
  id: string;
  label: string;
  hint?: string;
  value: Value;
  format: (value: Value) => string;
  parse: (text: string) => FieldParseResult<Value>;
  form: NodeFormApi;
  /** Names this box's unfinished text for the form. */
  scratchKey: string;
  mono?: boolean;
  inputMode?: 'decimal' | 'numeric' | 'text';
  placeholder?: string;
  className?: string;
  /** Sameness for values that aren't compared by identity, like lists. */
  equals?: (left: Value, right: Value) => boolean;
  onCommit: (value: Value) => void;
}>) {
  const live = useLiveField<Value>({
    value,
    format,
    parse,
    commit: onCommit,
    onScratchChange: (scratch) => {
      form.reportScratch(scratchKey, scratch);
    },
    ...(equals === undefined ? {} : { equals }),
  });
  const errorId = `${id}-error`;
  return (
    <Field data-invalid={live.error !== undefined} className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        autoComplete="off"
        inputMode={inputMode}
        placeholder={placeholder}
        className={cn(mono && 'font-mono')}
        value={live.text}
        disabled={!form.editable}
        aria-invalid={live.error !== undefined}
        aria-describedby={live.error === undefined ? undefined : errorId}
        onChange={(event) => {
          live.change(event.currentTarget.value);
        }}
        onBlur={live.blur}
      />
      {hint === undefined ? null : <FieldDescription>{hint}</FieldDescription>}
      {live.error === undefined ? null : (
        <FieldError id={errorId}>{live.error}</FieldError>
      )}
    </Field>
  );
}
