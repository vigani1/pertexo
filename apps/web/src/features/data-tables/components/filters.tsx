import { useState } from 'react';
import type { DataTableDefinition } from '@pertexo/contracts';
import { dataTableCsvValue, type DataTableQuery } from '@pertexo/node-sdk';
import { FilterIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
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
  const [column, setColumn] = useState(table.columns[0]?.name ?? '');
  const [operator, setOperator] = useState('equals');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const active = query.filters[0];
  return (
    <form
      aria-label="Filter rows"
      className="flex min-w-0 flex-wrap items-center gap-2"
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
          setError(undefined);
        } catch (cause) {
          setError(
            cause instanceof Error ? cause.message : 'Check the filter value.',
          );
        }
      }}
    >
      {/* One sentence to read: "colour · contains · red". */}
      <TableChoice
        label="Column"
        value={column}
        className="h-8 w-36"
        choices={table.columns.map((item) => ({
          value: item.name,
          label: item.name,
        }))}
        onChange={setColumn}
      />
      <TableChoice
        label="Match"
        value={operator}
        className="h-8 w-40"
        choices={OPERATORS}
        onChange={setOperator}
      />
      <Input
        aria-label="Value"
        placeholder="Value"
        className="h-8 w-40"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
        }}
      />
      <Button type="submit" variant="outline" size="sm">
        <FilterIcon aria-hidden="true" data-icon="inline-start" />
        Filter
      </Button>
      {active === undefined ? null : (
        <button
          type="button"
          aria-label="Clear filter"
          className="inline-flex max-sm:min-h-11 max-w-full min-w-0 items-center gap-1.5 rounded-sm border border-action/25 bg-action/8 px-2 py-1 text-xs text-accent-foreground outline-none hover:border-action/50 focus-ring"
          onClick={() => {
            onChange({ ...query, filters: [], offset: 0 });
          }}
        >
          <span className="min-w-0 truncate">
            {active.column}{' '}
            {OPERATORS.find(
              (item) => item.value === active.operator,
            )?.label.toLowerCase()}{' '}
            {tableCellText(active.value) ?? ''}
          </span>
          <XIcon aria-hidden="true" className="size-3 shrink-0" />
        </button>
      )}
      {error === undefined ? null : (
        <Notice tone="warning" className="w-full">
          {error}
        </Notice>
      )}
    </form>
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
