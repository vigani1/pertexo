import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { DataTableDefinition } from '@pertexo/contracts';
import type { DataTableRow } from '@pertexo/node-sdk';
import { Button } from '@/components/ui/button';
import { DateInput } from '@/components/ui/date-input';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { LabelledField } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import {
  sendTableCommand,
  type TableScope,
  type TableCommand,
} from '../data/tables.api';
import { tableKeys } from '../data/tables.queries';
import {
  editTableValues,
  readTableValues,
  tableValueErrors,
} from '../model/values';
import { TableChoice } from './choice';
import { TableCommandFeedback } from './command-feedback';
export function TableRowEditor({
  scope,
  table,
  row,
  schemaChanged = false,
  onClose,
}: Readonly<{
  scope: TableScope;
  table: DataTableDefinition;
  row?: DataTableRow | undefined;
  schemaChanged?: boolean;
  onClose: () => void;
}>) {
  const cache = useQueryClient();
  const [draft, setDraft] = useState(() =>
    editTableValues(table.columns, row?.values),
  );
  const [error, setError] = useState<string>();
  const validation = useFieldValidation<string>();
  const command = useRetainedCommand(
    (body: TableCommand, key: string) => sendTableCommand(scope, body, key),
    async () => {
      await cache.invalidateQueries({ queryKey: tableKeys.scope(scope) });
      onClose();
    },
    { action: 'saving this row' },
  );
  const locked = command.pending || command.uncertain;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !locked) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>{row === undefined ? 'Add row' : 'Edit row'}</DialogTitle>
        <DialogDescription>
          {table.name} ·{' '}
          {row === undefined
            ? 'All required fields need a value.'
            : `Editing revision ${String(row.revision)}. Your edits are kept if the row changes.`}
        </DialogDescription>
        {schemaChanged ? (
          <Notice tone="warning">
            Columns changed while this form was open. Your values are kept.
            Close and reopen the row to review the current columns.
          </Notice>
        ) : null}
        <form
          className="mt-5 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (schemaChanged) return;
            setError(undefined);
            if (!validation.submit(tableValueErrors(table.columns, draft)))
              return;
            try {
              const values = readTableValues(table.columns, draft);
              void command.send({
                kind: 'write',
                tableId: table.id,
                body:
                  row === undefined
                    ? {
                        command: {
                          operation: 'insert',
                          table: table.name,
                          values,
                        },
                      }
                    : {
                        command: {
                          operation: 'update',
                          table: table.name,
                          values,
                          query: { filters: [], limit: 100, offset: 0 },
                        },
                        rowId: row.id,
                        expectedRevision: row.revision,
                      },
              });
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : 'Check the row values.',
              );
            }
          }}
        >
          <fieldset
            disabled={locked || schemaChanged}
            className="grid min-w-0 gap-4"
          >
            {table.columns.map((column) => {
              const set = (text: string) => {
                const next = { ...draft, [column.name]: text };
                setDraft(next);
                validation.change(
                  column.name,
                  tableValueErrors([column], next)[column.name],
                );
              };
              const text = draft[column.name] ?? '';
              return (
                <LabelledField
                  key={column.name}
                  id={`cell-${column.name}`}
                  label={
                    <>
                      {column.name}
                      {column.required ? ' *' : ''}
                      <span className="font-normal text-muted-foreground">
                        {' '}
                        · {column.type}
                      </span>
                    </>
                  }
                  error={validation.error(column.name)}
                >
                  {(control) =>
                    column.type === 'boolean' ? (
                      <TableChoice
                        id={control.id}
                        value={text}
                        choices={[
                          ...(column.required
                            ? []
                            : [{ value: '', label: 'Empty' }]),
                          { value: 'true', label: 'True' },
                          { value: 'false', label: 'False' },
                        ]}
                        onChange={set}
                      />
                    ) : column.type === 'date' ? (
                      <DateInput
                        control={control}
                        inputRef={validation.register(column.name)}
                        value={text}
                        onChange={set}
                      />
                    ) : column.type === 'number' ? (
                      <Input
                        {...control}
                        ref={validation.register(column.name)}
                        inputMode="decimal"
                        className="font-mono"
                        value={text}
                        onChange={(event) => {
                          set(event.currentTarget.value);
                        }}
                      />
                    ) : (
                      // Text keeps its line breaks; JSON gets room to read.
                      <Textarea
                        {...control}
                        ref={validation.register(column.name)}
                        value={text}
                        onChange={(event) => {
                          set(event.currentTarget.value);
                        }}
                        className={
                          column.type === 'json' ? 'font-mono' : 'min-h-9'
                        }
                        rows={Math.min(
                          8,
                          Math.max(
                            column.type === 'json' ? 4 : 1,
                            text.split('\n').length,
                          ),
                        )}
                      />
                    )
                  }
                </LabelledField>
              );
            })}
          </fieldset>
          {error === undefined ? null : <Notice tone="warning">{error}</Notice>}
          <TableCommandFeedback command={command} />
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="primary"
              disabled={locked || schemaChanged}
            >
              {command.pending ? 'Saving…' : 'Save row'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={locked}
              onClick={onClose}
            >
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
