import type { DataTableDefinition } from '@pertexo/contracts';
import type {
  DataTableColumn,
  DataTableRow,
  DataTableResult,
} from '@pertexo/node-sdk';
import {
  CheckIcon,
  KeyRoundIcon,
  PencilIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { tableCellText } from '../../model/values';
import { COLUMN_TYPES } from '../../model/column-types';

/**
 * A cell in its type's voice: numbers and dates in mono, true and false as
 * marks, JSON as compact code, an empty cell as a faint dash.
 */
function TableCell({
  type,
  value,
}: Readonly<{ type: DataTableColumn['type']; value: unknown }>) {
  const text = tableCellText(value);
  if (text === undefined)
    return (
      <span className="text-subtle-foreground/60">
        <span aria-hidden="true">—</span>
        <span className="sr-only">Empty</span>
      </span>
    );
  if (type === 'boolean')
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 text-xs font-medium',
          value === true ? 'text-success' : 'text-muted-foreground',
        )}
      >
        {value === true ? (
          <CheckIcon aria-hidden="true" className="size-3.5" />
        ) : (
          <XIcon aria-hidden="true" className="size-3.5" />
        )}
        {text}
      </span>
    );
  if (type === 'number' || type === 'date')
    return <span className="font-mono tabular-nums">{text}</span>;
  if (type === 'json')
    return (
      <code className="line-clamp-2 font-mono text-xs break-all text-foreground/80">
        {text}
      </code>
    );
  return (
    <div className="line-clamp-4 break-words whitespace-pre-wrap">{text}</div>
  );
}

export function RowsGrid({
  table,
  page,
  pending,
  editable,
  locked,
  onEdit,
  onDelete,
}: Readonly<{
  table: DataTableDefinition;
  page: DataTableResult | undefined;
  pending: boolean;
  editable: boolean;
  locked: boolean;
  onEdit: (row: DataTableRow) => void;
  onDelete: (row: DataTableRow) => void;
}>) {
  return (
    <div className="relative max-w-full overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{table.name} rows</caption>
        <thead className="bg-surface-ink/[0.025]">
          <tr className="border-b border-surface-ink/8">
            {table.columns.map((column) => {
              const look = COLUMN_TYPES[column.type];
              const Icon =
                column.name === table.keyColumn ? KeyRoundIcon : look.icon;
              return (
                <th
                  key={column.name}
                  scope="col"
                  className={cn(
                    'px-4 py-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground',
                    column.type === 'number' && 'text-right',
                  )}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Icon
                      aria-hidden="true"
                      className={cn('size-3.5', look.text)}
                    />
                    <span className="font-mono text-foreground/90">
                      {column.name}
                    </span>
                    <span className="sr-only">, {column.type}</span>
                  </span>
                </th>
              );
            })}
            {editable ? (
              <th scope="col" className="w-20 px-2 py-2.5">
                <span className="sr-only">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {pending
            ? Array.from({ length: 3 }, (_, index) => (
                <tr
                  key={`loading-${String(index)}`}
                  aria-hidden="true"
                  className="border-b border-surface-ink/5 last:border-0"
                >
                  <td
                    colSpan={table.columns.length + (editable ? 1 : 0)}
                    className="px-4 py-3"
                  >
                    <Skeleton className="h-3.5 w-full max-w-md" />
                  </td>
                </tr>
              ))
            : null}
          {page?.rows.map((row) => (
            <DataRow
              key={row.id}
              table={table}
              row={row}
              editable={editable}
              locked={locked}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </tbody>
      </table>
      {page?.rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          No rows match.{' '}
          {table.rowCount === 0
            ? 'Add a row or import CSV to start.'
            : 'Try a different filter.'}
        </p>
      ) : null}
    </div>
  );
}

function DataRow({
  table,
  row,
  editable,
  locked,
  onEdit,
  onDelete,
}: Readonly<{
  table: DataTableDefinition;
  row: DataTableRow;
  editable: boolean;
  locked: boolean;
  onEdit: (row: DataTableRow) => void;
  onDelete: (row: DataTableRow) => void;
}>) {
  return (
    <tr className="group/row border-b border-surface-ink/5 transition-colors last:border-0 hover:bg-surface-ink/[0.03] motion-reduce:transition-none">
      {table.columns.map((column) => (
        <td
          key={column.name}
          className={cn(
            'max-w-72 min-w-28 px-4 py-2.5 align-top',
            column.type === 'number' && 'text-right',
            // A number or a day never breaks across lines.
            (column.type === 'number' || column.type === 'date') &&
              'whitespace-nowrap',
          )}
        >
          <TableCell type={column.type} value={row.values[column.name]} />
        </td>
      ))}
      {editable ? (
        <td className="px-2 py-1.5 align-top">
          {/* Shown on hover or focus; always on touch screens. */}
          <div className="flex justify-end gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Edit"
              title="Edit row"
              disabled={locked}
              onClick={() => {
                onEdit(row);
              }}
            >
              <PencilIcon aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Delete"
              title="Delete row"
              className="hover:text-destructive"
              disabled={locked}
              onClick={() => {
                onDelete(row);
              }}
            >
              <Trash2Icon aria-hidden="true" />
            </Button>
          </div>
        </td>
      ) : null}
    </tr>
  );
}
