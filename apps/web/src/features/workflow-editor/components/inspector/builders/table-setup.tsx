import { useRef, type ReactNode } from 'react';
import { TableColumnNames } from '../data-tables/column-names';
import { Button } from '@/components/ui/button';
import { reviewTableBindings } from '../../../model/inspector/table-bindings';
import {
  dataTableIdentity,
  matchesDataTableIdentity,
  type DataTableBindings,
} from '@pertexo/node-sdk';
import { AGENT_FIND_ROWS } from '@pertexo/workflow-model';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { tablesQuery } from '@/features/data-tables/public';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import { FieldLabel as Label } from '@/components/ui/field';
import { QueryView } from '@/components/patterns/states/query-view';
import { ChoiceSelect } from '../fields/choice-select';
import type { NodeFormApi } from '../../../model/inspector/node-form';
export function DataTableSetup({
  scope,
  definitionKey,
  config,
  form,
  children,
}: Readonly<{
  scope: WorkspaceApiScope;
  definitionKey: string;
  config: Readonly<Record<string, unknown>>;
  form: NodeFormApi;
  children?: ReactNode;
}>) {
  const query = useQuery(tablesQuery(scope));
  const reviewButton = useRef<HTMLButtonElement>(null);
  const name = typeof config.table === 'string' ? config.table : '';
  const tableId =
    typeof config.tableId === 'string' ? config.tableId : undefined;
  const identity = dataTableIdentity({ table: name, tableId });
  const tables = query.data?.tables ?? [];
  const table = tables.find((table) =>
    matchesDataTableIdentity(table, identity),
  );
  const bindings = config.columnBindings as DataTableBindings | undefined;
  const missing = name !== '' && table === undefined;
  return (
    <div className="grid gap-3">
      <Label htmlFor={`table-${form.nodeId}`}>Workspace table</Label>
      <ChoiceSelect
        value={table?.id ?? (missing ? 'missing' : '')}
        choices={[
          { value: '', label: 'Choose a table' },
          ...(missing
            ? [{ value: 'missing', label: `${name} (unavailable)` }]
            : []),
          ...tables.map((table) => ({ value: table.id, label: table.name })),
        ]}
        disabled={!form.editable || query.isPending}
        onChange={(value) => {
          if (value === 'missing') return;
          const target = tables.find((table) => table.id === value);
          const { tableId: _oldId, ...other } = config;
          form.commit(
            {
              config: {
                ...other,
                table: target?.name ?? '',
                ...(definitionKey === AGENT_FIND_ROWS.key &&
                target !== undefined
                  ? { tableId: target.id }
                  : {}),
                columnBindings: reviewTableBindings(target?.columns ?? [], {}),
              },
            },
            'table',
          );
        }}
        control={{ id: `table-${form.nodeId}` }}
      />
      {table === undefined ? null : (
        <section aria-label="Table column bindings" className="grid gap-2">
          <p className="text-xs text-muted-foreground">
            Input and output field names stay stable when table columns are
            renamed.
          </p>
          <TableColumnNames
            table={table}
            bindings={bindings}
            form={form}
            returnFocus={reviewButton}
          />
          <Button
            ref={reviewButton}
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
      <QueryView query={query} resource="Tables" loading={null} />
      <p className="text-xs text-muted-foreground">
        {children ??
          'Use Inputs to map row values, filters and sorting. Find returns rows with id, revision and values. Writes change workspace data, including during tests.'}
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
