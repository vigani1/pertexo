import { useState } from 'react';
import type { DataTableDefinition } from '@pertexo/contracts';
import { dataTableCsvValue, type DataTableQuery } from '@pertexo/node-sdk';
import { FilterIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DismissibleFilterChip } from '@/components/patterns/lists/filter-chip';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/patterns/notices/inline-notice';
import { TableChoice } from './choice';
import { tableCellText } from '../model/values';
const OPERATORS = [
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Does not equal' },
  { value: 'contains', label: 'Contains text' },
  { value: 'greater_than', label: 'Greater than' },
  { value: 'less_than', label: 'Less than' },
];

/** The rows' one filter, in one row above the grid. */
export function DataTableFilters({
  table,
  query,
  onChange,
}: Readonly<{
  table: DataTableDefinition;
  query: DataTableQuery;
  onChange: (query: DataTableQuery) => void;
}>) {
  const [open, setOpen] = useState(false);
  const [column, setColumn] = useState(table.columns[0]?.name ?? '');
  const [operator, setOperator] = useState('equals');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const active = query.filters[0];
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (next) {
            setColumn(active?.column ?? table.columns[0]?.name ?? '');
            setOperator(active?.operator ?? 'equals');
            setValue(
              active === undefined ? '' : (tableCellText(active.value) ?? ''),
            );
            setError(undefined);
          }
          setOpen(next);
        }}
      >
        <SheetTrigger render={<Button variant="outline" size="sm" />}>
          <FilterIcon aria-hidden="true" data-icon="inline-start" />
          Filter
        </SheetTrigger>
        <SheetContent variant="form">
          <SheetTitle>Filter rows</SheetTitle>
          <form
            aria-label="Filter rows"
            className="mt-5 flex min-w-0 flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const field = table.columns.find((item) => item.name === column);
              if (field === undefined) return;
              try {
                const parsed = dataTableCsvValue(
                  field,
                  value,
                ) as DataTableQuery['filters'][number]['value'];
                onChange({
                  ...query,
                  offset: 0,
                  filters: [
                    {
                      column,
                      operator:
                        operator as DataTableQuery['filters'][number]['operator'],
                      value: parsed,
                    },
                  ],
                });
                setOpen(false);
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : 'Check the filter value.',
                );
              }
            }}
          >
            {/* One sentence to read: "colour · contains · red". */}
            <TableChoice
              label="Column"
              value={column}
              className="w-full"
              choices={table.columns.map((item) => ({
                value: item.name,
                label: item.name,
              }))}
              onChange={setColumn}
            />
            <TableChoice
              label="Match"
              value={operator}
              className="w-full"
              choices={OPERATORS}
              onChange={setOperator}
            />
            <Input
              aria-label="Value"
              placeholder="Value"
              className="w-full"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
              }}
            />
            {error === undefined ? null : (
              <Notice tone="warning">{error}</Notice>
            )}
            <Button type="submit" variant="primary" className="self-end">
              Apply filter
            </Button>
          </form>
        </SheetContent>
      </Sheet>
      {active === undefined ? null : (
        <DismissibleFilterChip
          removeLabel="Clear filter"
          label={`${active.column} ${OPERATORS.find((item) => item.value === active.operator)?.label.toLowerCase() ?? ''} ${tableCellText(active.value) ?? ''}`}
          onRemove={() => {
            onChange({ ...query, filters: [], offset: 0 });
          }}
        />
      )}
    </div>
  );
}

/** The rows' order, beside the row actions so filters keep their own row. */
export function DataTableSort({
  table,
  query,
  onChange,
}: Readonly<{
  table: DataTableDefinition;
  query: DataTableQuery;
  onChange: (query: DataTableQuery) => void;
}>) {
  return (
    <TableChoice
      label="Sort"
      className="h-8 w-40"
      value={
        query.sort === undefined
          ? ''
          : `${query.sort.column}:${query.sort.direction}`
      }
      choices={[
        { value: '', label: 'Creation order' },
        ...table.columns.flatMap((item) => [
          { value: `${item.name}:asc`, label: `${item.name} ↑` },
          { value: `${item.name}:desc`, label: `${item.name} ↓` },
        ]),
      ]}
      onChange={(next) => {
        const [sortColumn, direction] = next.split(':');
        const { sort: _sort, ...rest } = query;
        onChange(
          next === ''
            ? { ...rest, offset: 0 }
            : {
                ...rest,
                offset: 0,
                sort: {
                  column: sortColumn ?? '',
                  direction: direction === 'desc' ? 'desc' : 'asc',
                },
              },
        );
      }}
    />
  );
}
