import { Button } from '@/components/ui/button';
import { reviewTableBindings } from '../../../model/inspector/table-bindings';
import type { DataTableBindings } from '@pertexo/node-sdk';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { tablesQuery } from '@/features/data-tables/picker.public';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import { FieldLabel as Label } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { ChoiceSelect } from '../fields/choice-select';
import type { NodeFormApi } from '../../../model/inspector/node-form';
export function DataTableSetup({
  scope,
  config,
  form,
}: Readonly<{
  scope: WorkspaceApiScope;
  config: Readonly<Record<string, unknown>>;
  form: NodeFormApi;
}>) {
  const query = useQuery(tablesQuery(scope));
  const selected = typeof config.table === 'string' ? config.table : '';
  const tables = query.data?.tables ?? [];
  const table = tables.find((table) => table.name === selected);
  const bindings = config.columnBindings as DataTableBindings | undefined;
  const missing =
    selected !== '' && !tables.some((table) => table.name === selected);
  return (
    <div className="grid gap-3">
      <Label htmlFor={`table-${form.nodeId}`}>Workspace table</Label>
      <ChoiceSelect
        id={`table-${form.nodeId}`}
        value={selected}
        choices={[
          { value: '', label: 'Choose a table' },
          ...(missing
            ? [{ value: selected, label: `${selected} (unavailable)` }]
            : []),
          ...tables.map((table) => ({ value: table.name, label: table.name })),
        ]}
        disabled={!form.editable || query.isPending}
        onChange={(value) => {
          const target = tables.find((table) => table.name === value);
          form.commit(
            {
              config: {
                ...config,
                table: value ?? '',
                columnBindings: reviewTableBindings(target?.columns ?? [], {}),
              },
            },
            'table',
          );
        }}
      />
      {table === undefined ? null : (
        <section aria-label="Table column bindings" className="grid gap-2">
          <p className="text-xs text-muted-foreground">
            Input and output field names stay stable when table columns are
            renamed.
          </p>
          <ul className="grid gap-1 text-xs">
            {Object.entries(
              bindings ??
                Object.fromEntries(
                  table.columns.map((column) => [column.id, column.id]),
                ),
            ).map(([alias, id]) => (
              <li key={alias} className="break-words">
                {alias} ←{' '}
                {table.columns.find((column) => column.id === id)?.name ??
                  'Removed column'}
              </li>
            ))}
          </ul>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!form.editable}
            onClick={() => {
              form.commit(
                {
                  config: {
                    ...config,
                    columnBindings: reviewTableBindings(
                      table.columns,
                      bindings,
                    ),
                  },
                },
                'table-columns',
              );
            }}
          >
            Review current columns
          </Button>
          <p className="text-xs text-muted-foreground">
            Review adds new columns and removes missing bindings. Check Inputs
            afterwards; values for removed fields must also be removed.
          </p>
        </section>
      )}
      {query.isError ? (
        <Notice tone="warning">Tables could not be loaded.</Notice>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Use Inputs to map row values, filters and sorting. Find returns rows
        with id, revision and values. Writes change workspace data, including
        during tests.
      </p>
      <Link
        className="text-sm text-action underline"
        to="/w/$workspaceId/data-tables"
        params={{ workspaceId: scope.workspaceId }}
      >
        Manage data tables
      </Link>
    </div>
  );
}
