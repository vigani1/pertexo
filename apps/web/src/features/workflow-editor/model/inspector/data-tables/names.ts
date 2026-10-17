import type { DataTableBindings, DataTableColumn } from '@pertexo/node-sdk';
import type {
  DataTableDefinition,
  WorkflowGraphContract,
} from '@pertexo/contracts';

export function tableColumnNames(
  columns: readonly DataTableColumn[],
  bindings: DataTableBindings | undefined,
) {
  const configured =
    bindings ??
    Object.fromEntries(columns.map((column) => [column.id, column.id]));
  const fields = Object.entries(configured).map(([alias, id]) => ({
    alias,
    id,
    name: columns.find((column) => column.id === id)?.name,
  }));
  const changes = fields.filter(
    (field) => field.name !== undefined && field.alias !== field.name,
  );
  const missing = fields.some((field) => field.name === undefined);
  return {
    fields,
    changes,
    missing,
    // Adopt together: names can have swapped while the immutable column IDs stayed put.
    bindings: missing
      ? undefined
      : Object.fromEntries(
          fields.map((field) => [field.name ?? field.alias, field.id]),
        ),
  };
}

export function isColumnNameReviewCurrent(
  review: Readonly<{
    graph: WorkflowGraphContract;
    tableId: string;
    bindings: DataTableBindings;
  }>,
  graph: WorkflowGraphContract,
  table: Pick<DataTableDefinition, 'id' | 'columns'>,
): boolean {
  return (
    review.graph === graph &&
    review.tableId === table.id &&
    Object.entries(review.bindings).every(([name, id]) =>
      table.columns.some((column) => column.id === id && column.name === name),
    )
  );
}
