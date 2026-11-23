import {
  PROMOTION_LIMITS,
  workflowDataTableBindings,
  replaceWorkflowDataTableBinding,
} from '@pertexo/workflow-model';
import {
  DataTableError,
  dataTableIdentity,
  matchesDataTableIdentity,
  resolveDataTableBindings,
} from '@pertexo/node-sdk';
import type { WorkflowNode } from '@pertexo/workflow-model';
import type { DataTableDefinition } from '@pertexo/contracts';
import type { WorkflowPromotionRequirement } from '@pertexo/contracts';

/** Names locate the destination schema; aliases keep downstream output paths stable. */
export function rebindPromotionTable(
  node: WorkflowNode,
  {
    sourceNode,
    sourceTables,
    targetTables,
  }: Readonly<{
    sourceNode: WorkflowNode;
    sourceTables: readonly DataTableDefinition[];
    targetTables: readonly DataTableDefinition[];
  }>,
  report: (
    requirement: Omit<WorkflowPromotionRequirement, 'workflowId'>,
  ) => void,
): WorkflowNode {
  return workflowDataTableBindings(sourceNode).reduce(
    (bound, binding) =>
      binding.location === 'tool' && !binding.find
        ? bound
        : rebindTable(bound, binding, { sourceTables, targetTables }, report),
    node,
  );
}

function rebindTable(
  node: WorkflowNode,
  binding: ReturnType<typeof workflowDataTableBindings>[number],
  {
    sourceTables,
    targetTables,
  }: Omit<Parameters<typeof rebindPromotionTable>[1], 'sourceNode'>,
  report: Parameters<typeof rebindPromotionTable>[2],
): WorkflowNode {
  const { config, location, idBound } = binding;
  const identity = dataTableIdentity(config);
  const source = sourceTables.find((table) =>
    matchesDataTableIdentity(table, identity),
  );
  const tableName = source?.name ?? config.table;
  const target = targetTables.find((table) => table.name === tableName);
  const issue = (detail: string) => {
    report({
      nodeId: node.id,
      kind: 'table',
      name: tableName,
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
    tableName,
    report,
  });
  if (
    node.definition.key === 'core.table_upsert' &&
    !matchingUpsertKeys(source, target)
  )
    issue(
      'Upsert requires the same unique key column name and type in the target table.',
    );
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
          PROMOTION_LIMITS.requirementDetailCharacters,
        ),
      );
  }
  report({
    nodeId: node.id,
    kind: 'table',
    name: tableName,
    status: 'ready',
    detail:
      'Matched by table and column names and types. Existing output aliases are retained.',
  });
  return replaceWorkflowDataTableBinding(node, location, {
    table: target.name,
    ...(idBound ? { tableId: target.id } : {}),
    columnBindings: bindings,
  });
}

function matchingUpsertKeys(
  source: DataTableDefinition,
  target: DataTableDefinition,
): boolean {
  const from = source.columns.find(
    (column) => column.name === source.keyColumn,
  );
  const to = target.columns.find((column) => column.name === target.keyColumn);
  return from !== undefined && to?.name === from.name && to.type === from.type;
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
    report: Parameters<typeof rebindPromotionTable>[2];
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
