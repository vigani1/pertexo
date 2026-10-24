import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  DataTableDefinition,
  DataTableSchemaEdit,
} from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import { sendTableCommand, type TableScope } from '../../data/tables.api';
import { tableKeys } from '../../data/tables.queries';
import { TableCommandFeedback } from '../command-feedback';

import {
  readColumnEdit,
  type ColumnEditIntent,
  type ColumnEditFields,
} from '../../model/columns';
import { ColumnFields } from './fields';

export function EditTableColumns({
  scope,
  table,
  onClose,
}: Readonly<{
  scope: TableScope;
  table: DataTableDefinition;
  onClose: () => void;
}>) {
  const [base] = useState(table);
  const [intent, setIntent] = useState<ColumnEditIntent>({ kind: 'add' });
  const [fields, setFields] = useState<ColumnEditFields>(() => ({
    name: '',
    type: 'text',
    required: false,
    defaultText: '',
    keyId:
      base.columns.find((column) => column.name === base.keyColumn)?.id ?? '',
  }));
  const [error, setError] = useState<string>();
  const cache = useQueryClient();
  const command = useRetainedCommand(
    (body: DataTableSchemaEdit, key: string) =>
      sendTableCommand(scope, { kind: 'schema', tableId: base.id, body }, key),
    async () => {
      await cache.invalidateQueries({ queryKey: tableKeys.scope(scope) });
      onClose();
    },
    { action: 'changing table columns' },
  );
  const locked = command.pending || command.uncertain;
  function choose(next: ColumnEditIntent) {
    if (locked) return;
    setIntent(next);
    setFields((current) => ({
      ...current,
      name:
        next.kind === 'rename'
          ? (base.columns.find((column) => column.id === next.id)?.name ?? '')
          : '',
    }));
    setError(undefined);
    command.reset();
  }
  function submit() {
    if (locked) return;
    try {
      void command.send(readColumnEdit(base.revision, intent, fields));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Check the column values.',
      );
    }
  }
  const idleSubmitLabel =
    intent.kind === 'remove' ? 'Confirm delete column' : 'Save column changes';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !locked) onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogTitle>Edit columns</DialogTitle>
        <DialogDescription>
          {base.name} · Renaming preserves workflow bindings. Deleting removes
          stored cells and makes bound workflow steps require review.
        </DialogDescription>
        <div className="mt-5 grid gap-5">
          <ColumnChoices base={base} locked={locked} onChoose={choose} />
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <ColumnFields
              table={base}
              intent={intent}
              fields={fields}
              locked={locked}
              onChange={(patch) => {
                setFields((current) => ({ ...current, ...patch }));
              }}
            />
            {error === undefined ? null : (
              <Notice tone="warning">{error}</Notice>
            )}
            <TableCommandFeedback command={command} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" disabled={locked}>
                {command.pending ? 'Saving…' : idleSubmitLabel}
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
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ColumnChoices({
  base,
  locked,
  onChoose,
}: Readonly<{
  base: DataTableDefinition;
  locked: boolean;
  onChoose: (intent: ColumnEditIntent) => void;
}>) {
  return (
    <>
      {' '}
      <ul className="divide-y divide-border">
        {base.columns.map((column) => (
          <li
            key={column.id}
            className="flex flex-wrap items-center justify-between gap-2 py-2"
          >
            <span className="min-w-0 break-words text-sm">
              {column.name} · {column.type}
              {column.required ? ' · required' : ''}
              {base.keyColumn === column.name ? ' · unique key' : ''}
            </span>
            <div className="flex gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={locked}
                onClick={() => {
                  onChoose({ kind: 'rename', id: column.id });
                }}
              >
                Rename {column.name}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={locked || base.columns.length === 1}
                onClick={() => {
                  onChoose({ kind: 'remove', id: column.id });
                }}
              >
                Delete {column.name}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={locked}
          onClick={() => {
            onChoose({ kind: 'add' });
          }}
        >
          Add column
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={locked}
          onClick={() => {
            onChoose({ kind: 'key' });
          }}
        >
          Change unique key
        </Button>
      </div>
    </>
  );
}
