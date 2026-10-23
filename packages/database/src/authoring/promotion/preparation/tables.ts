import {
  DataTableError,
  isDataTableDefinition,
  resolveDataTableBindings,
  type DataTableConfig,
} from '@pertexo/node-sdk';
import type { WorkflowNode } from '@pertexo/workflow-model';
import type { DataTableDefinition } from '../../../data-tables/contract.js';
import type { WorkflowPromotionRequirement } from '@pertexo/contracts';

/** Names locate the destination schema; aliases keep downstream output paths stable. */
export function rebindPromotionTable(
  node: WorkflowNode,
  sourceTables: readonly DataTableDefinition[],
  targetTables: readonly DataTableDefinition[],
  report: (
    requirement: Omit<WorkflowPromotionRequirement, 'workflowId'>,
  ) => void,
): WorkflowNode {
  if (!isDataTableDefinition(node.definition)) return node;
  const config = node.config as DataTableConfig;
  const source = sourceTables.find((table) => table.name === config.table);
  const target = targetTables.find((table) => table.name === config.table);
  const issue = (detail: string) => {
    report({
      nodeId: node.id,
      kind: 'table',
      name: config.table,
      status: 'incompatible',
      detail,
    });
  };
  if (source === undefined || target === undefined) {
    issue(
      'Create a compatible table with this name in the target workspace. Promotion never copies table rows or schemas.',
    );
    return node;
  }
  let names: Readonly<Record<string, string>>;
  try {
    names = resolveDataTableBindings({
      columns: source.columns,
      bindings: config.columnBindings,
      hasRemovedColumns: source.hasRemovedColumns,
    });
  } catch (error) {
    if (!(error instanceof DataTableError)) throw error;
    issue(error.message);
    return node;
  }
  const bindings = rebindPromotionColumns(source, target, {
    names,
    nodeId: node.id,
    tableName: config.table,
    report,
  });
  if (node.definition.key === 'core.table_upsert') {
    const from = source.columns.find(
      (column) => column.name === source.keyColumn,
    );
    const to = target.columns.find(
      (column) => column.name === target.keyColumn,
    );
    const columnChanged =
      from?.name !== to?.name ||
      from?.type !== to?.type ||
      from === undefined ||
      to === undefined;
    if (columnChanged)
      issue(
        'Upsert requires the same unique key column name and type in the target table.',
      );
  }
  if (
    ['core.table_insert', 'core.table_upsert'].includes(node.definition.key)
  ) {
    const missing = target.columns.filter(
      (column) =>
        column.required && !Object.values(bindings).includes(column.id),
    );
    if (missing.length > 0)
      issue(
        `Target required columns are not supplied: ${missing.map((column) => column.name).join(', ')}.`.slice(
          0,
          512,
        ),
      );
  }
  report({
    nodeId: node.id,
    kind: 'table',
    name: config.table,
    status: 'ready',
    detail:
      'Matched by table and column names and types. Existing output aliases are retained.',
  });
  return { ...node, config: { ...node.config, columnBindings: bindings } };
}

function rebindPromotionColumns(
  source: DataTableDefinition,
  target: DataTableDefinition,
  {
    names,
    nodeId,
    tableName,
    report,
  }: Readonly<{
    names: Readonly<Record<string, string>>;
    nodeId: string;
    tableName: string;
    report: Parameters<typeof rebindPromotionTable>[3];
  }>,
): Record<string, string> {
  const bindings: Record<string, string> = {};
  for (const [alias, name] of Object.entries(names)) {
    const from = source.columns.find((column) => column.name === name);
    const to = target.columns.find((column) => column.name === name);
    const incompatibleColumn =
      from?.type !== to?.type ||
      from === undefined ||
      to === undefined ||
      (!from.required && to.required);
    if (incompatibleColumn) {
      report({
        nodeId: nodeId,
        kind: 'column',
        name: `${tableName}.${name}`,
        status: 'incompatible',
        detail:
          'The target column must exist with the same type and compatible requiredness. Output aliases are kept.',
      });
      continue;
    }
    Object.defineProperty(bindings, alias, { value: to.id, enumerable: true });
  }

  return bindings;
}
