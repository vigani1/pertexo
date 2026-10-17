import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { DataTableDefinition } from '@pertexo/contracts';
import type { DataTableRow } from '@pertexo/node-sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FieldLabel as Label } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
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
import { readTableValues, editTableValues } from '../model/values';
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
            {table.columns.map((column) => (
              <div key={column.name} className="grid gap-2">
                <Label htmlFor={`cell-${column.name}`}>
                  {column.name}
                  {column.required ? ' *' : ''}
                  <span className="font-normal text-muted-foreground">
                    {' '}
                    · {column.type}
                  </span>
                </Label>
                {column.type === 'boolean' ? (
                  <TableChoice
                    id={`cell-${column.name}`}
                    value={draft[column.name] ?? ''}
                    choices={[
                      ...(column.required
                        ? []
                        : [{ value: '', label: 'Empty' }]),
                      { value: 'true', label: 'True' },
                      { value: 'false', label: 'False' },
                    ]}
                    onChange={(value) => {
                      setDraft((current) => ({
                        ...current,
                        [column.name]: value,
                      }));
                    }}
                  />
                ) : column.type === 'json' ? (
                  <Textarea
                    id={`cell-${column.name}`}
                    value={draft[column.name] ?? ''}
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        [column.name]: event.target.value,
                      }));
                    }}
                    className="font-mono"
                    rows={4}
                    required={column.required}
                  />
                ) : (
                  <Input
                    id={`cell-${column.name}`}
                    type={
                      column.type === 'date'
                        ? 'date'
                        : column.type === 'number'
                          ? 'number'
                          : 'text'
                    }
                    step={column.type === 'number' ? 'any' : undefined}
                    value={draft[column.name] ?? ''}
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        [column.name]: event.target.value,
                      }));
                    }}
                    required={column.required}
                  />
                )}
              </div>
            ))}
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
