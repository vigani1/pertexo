import type { DataTableColumn } from '@pertexo/node-sdk';
import { KeyRoundIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { COLUMN_TYPES } from '../model/column-types';

/** A column as a chip: its type's mark, its name, a key if it is one. */
export function ColumnChip({
  column,
  isKey = false,
  className,
}: Readonly<{
  column: Pick<DataTableColumn, 'name' | 'type'>;
  isKey?: boolean;
  className?: string;
}>) {
  const look = COLUMN_TYPES[column.type];
  const Icon = isKey ? KeyRoundIcon : look.icon;
  return (
    <span
      className={cn(
        'inline-flex max-w-40 min-w-0 items-center gap-1.5 rounded-md border border-white/7 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[0.7rem] text-muted-foreground',
        isKey && 'border-action/30 text-accent-foreground',
        className,
      )}
    >
      <Icon aria-hidden="true" className={cn('size-3 shrink-0', look.text)} />
      <span className="truncate">{column.name}</span>
      <span className="sr-only">
        , {column.type}
        {isKey ? ', unique key' : ''}
      </span>
    </span>
  );
}

/**
 * A table drawn as a small woven swatch: one warp thread per column in its
 * type's colour, and weft threads that grow with its rows (none when empty,
 * up to five for ten thousand and more), so a list of tables reads by shape.
 */
export function TableSwatch({
  columns,
  rowCount,
  className,
}: Readonly<{
  columns: readonly Pick<DataTableColumn, 'type'>[];
  rowCount: number;
  className?: string;
}>) {
  const warp = columns.slice(0, 7);
  const weft =
    rowCount === 0 ? 0 : Math.min(5, Math.floor(Math.log10(rowCount)) + 1);
  const width = 40;
  const height = 32;
  const step = width / (warp.length + 1);
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      className={cn(
        'size-10 shrink-0 rounded-lg border border-white/7 bg-white/[0.025] p-1.5',
        className,
      )}
      fill="none"
      strokeLinecap="round"
    >
      {Array.from({ length: weft }, (_, index) => {
        const y = (height / (weft + 1)) * (index + 1);
        return (
          <line
            key={`weft-${String(index)}`}
            x1={2}
            x2={width - 2}
            y1={y}
            y2={y}
            className="stroke-white/25"
            strokeWidth={1.4}
          />
        );
      })}
      {warp.map((column, index) => {
        const x = step * (index + 1);
        return (
          <line
            key={`warp-${String(index)}`}
            x1={x}
            x2={x}
            y1={3}
            y2={height - 3}
            className={COLUMN_TYPES[column.type].thread}
            strokeWidth={2}
          />
        );
      })}
    </svg>
  );
}

/** A thin meter for "this much of that much", never fully empty when used. */
export function UsageMeter({
  used,
  limit,
  label,
  className,
}: Readonly<{
  used: number;
  limit: number;
  label: string;
  className?: string;
}>) {
  const share = limit <= 0 ? 0 : Math.min(1, used / limit);
  const shown = used > 0 ? Math.max(share, 0.03) : 0;
  return (
    <span
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={used}
      className={cn(
        'relative block h-1 overflow-hidden rounded-full bg-white/[0.07]',
        className,
      )}
    >
      <span
        className={cn(
          'absolute inset-y-0 left-0 rounded-full',
          share >= 0.9 ? 'bg-warning' : 'bg-action/80',
        )}
        style={{ width: `${String(shown * 100)}%` }}
      />
    </span>
  );
}
