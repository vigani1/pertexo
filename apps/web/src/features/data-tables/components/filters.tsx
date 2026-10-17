import { useState } from 'react';
import type { DataTableDefinition } from '@pertexo/contracts';
import { dataTableCsvValue, type DataTableQuery } from '@pertexo/node-sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FieldLabel as Label } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { TableChoice } from './choice';
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
  return (
    <form
      className="flex flex-wrap items-end gap-2"
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
      <div className="grid min-w-32 flex-1 gap-1">
        <Label htmlFor="filter-column">Column</Label>
        <TableChoice
          id="filter-column"
          value={column}
          choices={table.columns.map((item) => ({
            value: item.name,
            label: item.name,
          }))}
          onChange={setColumn}
        />
      </div>
      <div className="grid min-w-32 flex-1 gap-1">
        <Label htmlFor="filter-operator">Match</Label>
        <TableChoice
          id="filter-operator"
          value={operator}
          choices={[
            { value: 'equals', label: 'Equals' },
            { value: 'not_equals', label: 'Does not equal' },
            { value: 'contains', label: 'Contains text' },
            { value: 'greater_than', label: 'Greater than' },
            { value: 'less_than', label: 'Less than' },
          ]}
          onChange={setOperator}
        />
      </div>
      <div className="grid min-w-32 flex-1 gap-1">
        <Label htmlFor="filter-value">Value</Label>
        <Input
          id="filter-value"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
      </div>
      <Button type="submit" variant="outline">
        Filter
      </Button>
      <Button
        type="button"
        variant="ghost"
        disabled={query.filters.length === 0}
        onClick={() => {
          onChange({ ...query, filters: [], offset: 0 });
        }}
      >
        Clear
      </Button>
      <div className="grid min-w-36 gap-1">
        <Label htmlFor="row-sort">Sort</Label>
        <TableChoice
          id="row-sort"
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
      </div>
      {error === undefined ? null : (
        <Notice tone="warning" className="w-full">
          {error}
        </Notice>
      )}
    </form>
  );
}
