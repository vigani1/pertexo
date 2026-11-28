import { DATA_TABLE_LIMITS, formatByteSize } from '@pertexo/node-sdk';
import { useId, useState } from 'react';
import {
  dataTableCreateSchema,
  type DataTableCreate,
} from '@pertexo/contracts';
import {
  isDataTableKeyColumn,
  type DataTableNewColumn,
} from '@pertexo/node-sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FieldLabel as Label } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { Notice } from '@/components/patterns/notices/inline-notice';
import {
  Sheet,
  SheetFooter,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { useTableCommand } from '../data/tables.mutations';
import type { TableScope } from '../data/tables.api';
import { TableChoice } from './choice';
import { TableCommandFeedback } from './command-feedback';
type Column = DataTableNewColumn & { id: string };
const types = ['text', 'number', 'boolean', 'date', 'json'] as const;
function newColumn(): Column {
  return { id: crypto.randomUUID(), name: '', type: 'text', required: false };
}
export function CreateDataTable({
  scope,
  columnLimit,
  onClose,
  onCreated,
}: Readonly<{
  scope: TableScope;
  columnLimit: number;
  onClose: () => void;
  onCreated: (id: string) => void;
}>) {
  const nameId = useId();
  const [name, setName] = useState('');
  const [columns, setColumns] = useState<Column[]>(() => [newColumn()]);
  const [keyColumn, setKeyColumn] = useState('');
  const [error, setError] = useState<string>();
  const command = useTableCommand(
    scope,
    (body: DataTableCreate) => ({ kind: 'create', body }),
    {
      action: 'creating this table',
      onDone: (result) => {
        if ('id' in result) onCreated(result.id);
        onClose();
      },
    },
  );
  const locked = command.pending || command.uncertain;
  function change(id: string, patch: Partial<DataTableNewColumn>) {
    setColumns((current) =>
      current.map((column) =>
        column.id === id ? { ...column, ...patch } : column,
      ),
    );
    setError(undefined);
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !locked) onClose();
      }}
    >
      <SheetContent variant="form">
        <SheetTitle>New data table</SheetTitle>
        <SheetDescription>
          Small shared datasets for your workflows. Column types stay fixed
          after creation.
        </SheetDescription>
        <form
          className="mt-5 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = dataTableCreateSchema.safeParse({
              name,
              columns: columns.map(({ id: _id, ...column }) => column),
              keyColumn: keyColumn === '' ? null : keyColumn,
            });
            if (!parsed.success) {
              setError(
                parsed.error.issues[0]?.message ?? 'Check the table schema.',
              );
              return;
            }
            void command.send(parsed.data);
          }}
        >
          <fieldset disabled={locked} className="contents">
            <div className="grid gap-2">
              <Label htmlFor={nameId}>Table name</Label>
              <Input
                id={nameId}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
                placeholder="Customer orders"
                required
                maxLength={64}
              />
              <p className="text-xs text-muted-foreground">
                Letters, numbers, spaces, hyphens and underscores.
              </p>
            </div>
            <div className="flex flex-col gap-4">
              {columns.map((column) => (
                <NewTableColumn
                  key={column.id}
                  column={column}
                  removable={columns.length > 1}
                  onChange={(patch) => {
                    change(column.id, patch);
                  }}
                  onRemove={() => {
                    setColumns((current) =>
                      current.filter((item) => item.id !== column.id),
                    );
                  }}
                />
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={columns.length >= columnLimit}
              onClick={() => {
                setColumns((current) => [...current, newColumn()]);
              }}
            >
              Add column
            </Button>
            <NewTableKey
              columns={columns}
              value={keyColumn}
              onChange={setKeyColumn}
            />
          </fieldset>
          {error === undefined ? null : <Notice tone="warning">{error}</Notice>}
          <TableCommandFeedback command={command} />
          <SheetFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={locked}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={locked}>
              {command.pending ? 'Creating…' : 'Create table'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function NewTableColumn({
  column,
  removable,
  onChange,
  onRemove,
}: Readonly<{
  column: Column;
  removable: boolean;
  onChange: (patch: Partial<DataTableNewColumn>) => void;
  onRemove: () => void;
}>) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2 rounded-md border border-border p-3">
      <Label className="sr-only" htmlFor={`column-${column.id}`}>
        Column name
      </Label>
      <Input
        id={`column-${column.id}`}
        aria-label="Column name"
        value={column.name}
        onChange={(event) => {
          onChange({ name: event.target.value });
        }}
        placeholder="order_id"
        required
      />
      <Label className="sr-only" htmlFor={`type-${column.id}`}>
        Column type
      </Label>
      <TableChoice
        id={`type-${column.id}`}
        value={column.type}
        choices={types.map((type) => ({
          value: type,
          label: type === 'boolean' ? 'True / false' : type,
        }))}
        onChange={(value) => {
          onChange({
            type: value as DataTableNewColumn['type'],
          });
        }}
      />
      <div className="col-span-2 flex items-center justify-between gap-3">
        <Label className="flex items-center gap-2">
          <Switch
            checked={column.required}
            onCheckedChange={(required) => {
              onChange({ required });
            }}
          />
          Required
        </Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!removable}
          onClick={onRemove}
        >
          Remove column
        </Button>
      </div>
    </div>
  );
}

function NewTableKey({
  columns,
  value,
  onChange,
}: Readonly<{
  columns: readonly Column[];
  value: string;
  onChange: (value: string) => void;
}>) {
  return (
    <div className="grid gap-2">
      <Label htmlFor="table-key">Unique key (optional)</Label>
      <TableChoice
        id="table-key"
        value={value}
        choices={[
          { value: '', label: 'No unique key' },
          ...columns
            .filter(
              (column) => column.name !== '' && isDataTableKeyColumn(column),
            )
            .map((column) => ({
              value: column.name,
              label: column.name,
            })),
        ]}
        onChange={onChange}
      />
      <p className="text-xs text-muted-foreground">
        Upsert uses this required column. Key values must fit{' '}
        {formatByteSize(DATA_TABLE_LIMITS.keyBytes)}.
      </p>
    </div>
  );
}
