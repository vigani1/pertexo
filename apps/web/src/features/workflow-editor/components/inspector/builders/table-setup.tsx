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
          form.commit({ config: { ...config, table: value ?? '' } }, 'table');
        }}
      />
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
