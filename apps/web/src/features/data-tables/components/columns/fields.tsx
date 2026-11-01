import type { DataTableDefinition } from '@pertexo/contracts';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Notice } from '@/components/ui/notice';
import { FieldLabel as Label } from '@/components/ui/field';
import { TableChoice } from '../choice';
import type { ColumnEditIntent, ColumnEditFields } from '../../model/columns';
import { isDataTableKeyColumn } from '@pertexo/node-sdk';
import { FORMAT_LOCALE } from '@/lib/format/locale';

const types = ['text', 'number', 'boolean', 'date', 'json'] as const;
export function ColumnFields({
  table,
  intent,
  fields,
  locked,
  onChange,
}: Readonly<{
  table: DataTableDefinition;
  intent: ColumnEditIntent;
  fields: ColumnEditFields;
  locked: boolean;
  onChange: (patch: Partial<ColumnEditFields>) => void;
}>) {
  const selected =
    intent.kind === 'remove'
      ? table.columns.find((column) => column.id === intent.id)
      : undefined;
  return (
    <fieldset disabled={locked} className="grid gap-3">
      {intent.kind === 'add' || intent.kind === 'rename' ? (
        <>
          <Label htmlFor="edit-column-name">Column name</Label>
          <Input
            id="edit-column-name"
            value={fields.name}
            maxLength={64}
            required
            onChange={(event) => {
              onChange({ name: event.target.value });
            }}
          />
        </>
      ) : null}
      {intent.kind === 'add' ? (
        <>
          <Label htmlFor="edit-column-type">Column type</Label>
          <TableChoice
            id="edit-column-type"
            value={fields.type}
            choices={types.map((value) => ({ value, label: value }))}
            onChange={(value) => {
              onChange({ type: value as ColumnEditFields['type'] });
            }}
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={fields.required}
              onCheckedChange={(required) => {
                onChange({ required });
              }}
            />
            Required column
          </label>
          <Label htmlFor="edit-column-default">
            Default for existing rows
            {fields.required ? ' (required)' : ' (optional)'}
          </Label>
          <Input
            id="edit-column-default"
            value={fields.defaultText}
            onChange={(event) => {
              onChange({ defaultText: event.target.value });
            }}
          />
          <p className="text-xs text-muted-foreground">
            Use a typed value: true/false for booleans, YYYY-MM-DD for dates,
            JSON for JSON columns. Optional blanks become empty cells. Future
            writes still provide required values.
          </p>
        </>
      ) : null}
      {intent.kind === 'key' ? (
        <>
          <Label htmlFor="edit-table-key">Unique key</Label>
          <TableChoice
            id="edit-table-key"
            value={fields.keyId}
            choices={[
              { value: '', label: 'No unique key' },
              ...table.columns.filter(isDataTableKeyColumn).map((column) => ({
                value: column.id,
                label: column.name,
              })),
            ]}
            onChange={(keyId) => {
              onChange({ keyId });
            }}
          />
          <p className="text-xs text-muted-foreground">
            Every existing value must be unique and fit the key limit. A
            rejected change leaves the table as it was.
          </p>
        </>
      ) : null}
      {intent.kind === 'remove' ? (
        <Notice tone="warning">
          Delete {selected?.name} and its cells in all{' '}
          {table.rowCount.toLocaleString(FORMAT_LOCALE)} rows?
          {table.keyColumn === selected?.name
            ? ' This also clears the unique key.'
            : ''}{' '}
          Workflows that bind this column must be updated.
        </Notice>
      ) : null}
    </fieldset>
  );
}
