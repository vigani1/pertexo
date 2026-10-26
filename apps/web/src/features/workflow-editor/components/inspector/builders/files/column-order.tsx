import { PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  addFileColumns,
  moveFileColumn,
  type ColumnLimits,
} from '../../../../model/inspector/files/columns';
import { fieldControlId } from '../../../../model/inspector/node-form';
import type { NodeFormApi } from '../../../../model/inspector/node-form';
import { EntryActions } from '../parts';

/**
 * The file's columns as an ordered list: each name a numbered chip that
 * moves up or down or leaves, and a box that adds a name, or one per line
 * when names are pasted. An empty list means every field, in first-seen
 * order, for inline data.
 */
export function ColumnOrder({
  form,
  columns,
  limits,
  hint,
  onChange,
}: Readonly<{
  form: NodeFormApi;
  columns: readonly string[];
  limits: ColumnLimits;
  hint: string;
  onChange: (columns: readonly string[]) => void;
}>) {
  const listId = fieldControlId(form.nodeId, 'columns');
  const addId = fieldControlId(form.nodeId, 'add-column');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  function add(text: string) {
    const result = addFileColumns(columns, text, limits);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setError(undefined);
    setDraft('');
    form.reportScratch('add-column', false);
    onChange(result.value);
    return true;
  }
  return (
    <Field>
      <FieldLabel id={`${listId}-label`} htmlFor={addId}>
        Columns, in output order
      </FieldLabel>
      <ol
        aria-labelledby={`${listId}-label`}
        className="flex flex-col gap-1 empty:hidden"
      >
        {columns.map((name, index) => (
          <li
            key={name}
            className="flex min-h-9 min-w-0 items-center gap-2 rounded-md border border-surface-ink/7 bg-surface-ink/[0.025] py-0.5 pr-0.5 pl-2"
          >
            <span
              aria-hidden="true"
              className="w-5 shrink-0 text-right font-mono text-[0.62rem] text-subtle-foreground"
            >
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[0.75rem] whitespace-pre">
              {name}
            </span>
            <span className="flex shrink-0 items-center">
              <EntryActions
                label={name}
                first={index === 0}
                last={index === columns.length - 1}
                canRemove
                editable={form.editable}
                onMove={(by) => {
                  onChange(moveFileColumn(columns, index, by));
                }}
                onRemove={() => {
                  onChange(columns.filter((column) => column !== name));
                }}
              />
            </span>
          </li>
        ))}
      </ol>
      {columns.length === 0 ? (
        <p className="rounded-md border border-dashed border-surface-ink/12 px-3 py-2 text-xs text-muted-foreground">
          All fields, in the order they first appear.
        </p>
      ) : null}
      <div className="flex min-w-0 gap-1.5">
        <Input
          id={addId}
          autoComplete="off"
          spellCheck={false}
          placeholder="Field name"
          className="font-mono"
          value={draft}
          disabled={!form.editable}
          aria-invalid={error !== undefined}
          aria-describedby={`${addId}-hint${error === undefined ? '' : ` ${addId}-error`}`}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setError(undefined);
            form.reportScratch('add-column', event.currentTarget.value !== '');
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            add(draft);
          }}
          onPaste={(event) => {
            const text = event.clipboardData.getData('text');
            if (!/\r?\n/u.test(text)) return;
            event.preventDefault();
            add(draft + text);
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={!form.editable || draft === ''}
          onClick={() => {
            add(draft);
          }}
        >
          <PlusIcon data-icon="inline-start" />
          Add column
        </Button>
      </div>
      <FieldDescription id={`${addId}-hint`}>
        {hint} Up to {limits.count.toLocaleString('en-US')} names; paste
        several, one per line.
      </FieldDescription>
      {error === undefined ? null : (
        <FieldError id={`${addId}-error`}>{error}</FieldError>
      )}
    </Field>
  );
}
