import type { PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  DataTableError,
  dataTableIdentity,
  matchesDataTableIdentity,
  resolveDataTableBindings,
} from '@pertexo/node-sdk';
import {
  mapWorkflowNodes,
  replaceWorkflowDataTableBinding,
  workflowDataTableBinding,
  isRecord,
  type WorkflowNode,
  type WorkflowGraph,
  type GraphValidationIssue,
} from '@pertexo/workflow-model';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { readTablesByIdentity } from '../table-lookups.repository.js';
import type { DataTableDefinition } from '../data-table-commands.types.js';
import { readVersionNodes } from './references.repository.js';

export type ReferenceNode = Pick<
  WorkflowNode,
  'id' | 'definition' | 'config' | 'inputMappings' | 'label' | 'disabled'
> & { readonly structured?: { readonly body: ReferenceGraph } | undefined };
type ReferenceGraph = Readonly<{ nodes: readonly ReferenceNode[] }>;

function literalAliases(node: ReferenceNode): string[] {
  const aliases: string[] = [];
  const values = node.inputMappings.values;
  if (values?.kind === 'literal' && isRecord(values.value))
    aliases.push(...Object.keys(values.value));
  const query = node.inputMappings.query;
  if (query?.kind === 'literal' && isRecord(query.value)) {
    if (Array.isArray(query.value.filters))
      for (const filter of query.value.filters)
        if (isRecord(filter) && typeof filter.column === 'string')
          aliases.push(filter.column);
    if (
      isRecord(query.value.sort) &&
      typeof query.value.sort.column === 'string'
    )
      aliases.push(query.value.sort.column);
  }
  return aliases;
}

function references(graph: ReferenceGraph) {
  const found: {
    binding: NonNullable<ReturnType<typeof workflowDataTableBinding>>;
    path: string;
    label: string;
    node: ReferenceNode;
  }[] = [];
  const levels = [{ nodes: graph.nodes, path: '$' }];
  for (const level of levels)
    for (const [index, node] of level.nodes.entries()) {
      if (node.disabled ?? false) continue;
      const path = `${level.path}.nodes[${String(index)}]`;
      if (node.structured !== undefined)
        levels.push({
          nodes: node.structured.body.nodes,
          path: `${path}.structured.body`,
        });
      const binding = workflowDataTableBinding(node);
      if (binding !== undefined)
        found.push({
          binding,
          path: binding.location === 'tool' ? `${path}.config.tool` : path,
          label: node.label ?? node.id,
          node,
        });
    }
  return found;
}

function issuesFor(
  refs: ReturnType<typeof references>,
  tables: readonly DataTableDefinition[],
): readonly GraphValidationIssue[] {
  return refs.flatMap((ref) => {
    try {
      const { config, location } = ref.binding;
      const identity = dataTableIdentity(config);
      const table = tables.find((table) =>
        matchesDataTableIdentity(table, identity),
      );
      if (table === undefined)
        throw new DataTableError(
          'not_found',
          `Table ${config.table} is unavailable. Select an existing table.`,
        );
      const names = resolveDataTableBindings({
        columns: table.columns,
        bindings: config.columnBindings,
        hasRemovedColumns: table.hasRemovedColumns,
      });
      for (const alias of location === 'step' ? literalAliases(ref.node) : [])
        if (!Object.hasOwn(names, alias))
          throw new DataTableError(
            'invalid_values',
            `Column ${alias} is not bound. Review Inputs after changing table columns.`,
          );
      return [];
    } catch (error) {
      if (!(error instanceof DataTableError)) throw error;
      return [
        {
          code: 'invalid_graph' as const,
          path: `${ref.path}.config.columnBindings`,
          message: `${ref.label}: ${error.message}`,
        },
      ];
    }
  });
}

export async function dataTableReferenceIssues(
  client: PoolClient,
  workspaceId: string,
  graph: WorkflowGraph,
): Promise<readonly GraphValidationIssue[]> {
  const { issues } = await reviewTableReferences(client, workspaceId, graph);
  return issues;
}

/** Publication resolves existing draft names to IDs under the same reference locks. */
export async function bindPublicationTables(
  client: PoolClient,
  workspaceId: string,
  graph: WorkflowGraph,
) {
  const { issues, refs, found } = await reviewTableReferences(
    client,
    workspaceId,
    graph,
  );
  if (issues.length > 0) return { kind: 'refused', issues } as const;
  const byName = new Map(found.map((table) => [table.name, table.id]));
  const pins = new Map(
    refs.flatMap(({ node, binding }) => {
      if (!binding.find || binding.config.tableId !== undefined) return [];
      const tableId = byName.get(binding.config.table);
      return tableId === undefined
        ? []
        : [[node, { binding, tableId }] as const];
    }),
  );
  return {
    kind: 'bound',
    graph:
      pins.size === 0
        ? graph
        : mapWorkflowNodes(graph, (node) => {
            const pin = pins.get(node);
            if (pin === undefined) return node;
            return replaceWorkflowDataTableBinding(node, pin.binding.location, {
              ...pin.binding.config,
              tableId: pin.tableId,
            });
          }),
  } as const;
}

/** A portable export uses current names and carries no workspace table IDs. */
export async function projectPortableTableNames(
  client: PoolClient,
  workspaceId: string,
  graph: WorkflowGraph,
): Promise<WorkflowGraph> {
  const pins = new Map(
    references(graph).flatMap(({ node, binding }) =>
      binding.config.tableId === undefined ? [] : [[node, binding] as const],
    ),
  );
  if (pins.size === 0) return graph;
  const tables = await readTablesByIdentity(
    drizzle(client),
    workspaceId,
    [...pins.values()].map(({ config }) => dataTableIdentity(config)),
  ).catch(rethrowQueryFailure);
  const names = new Map(tables.map((table) => [table.id, table.name]));
  return mapWorkflowNodes(graph, (node) => {
    const binding = pins.get(node);
    if (binding === undefined) return node;
    const name = names.get(binding.config.tableId ?? '');
    return name === undefined
      ? node
      : replaceWorkflowDataTableBinding(node, binding.location, {
          ...binding.config,
          table: name,
        });
  });
}

async function reviewTableReferences(
  client: PoolClient,
  workspaceId: string,
  graph: WorkflowGraph,
) {
  const refs = references(graph);
  const found = await readTablesByIdentity(
    drizzle(client),
    workspaceId,
    refs.map(({ binding }) => dataTableIdentity(binding.config)),
  ).catch(rethrowQueryFailure);
  return { refs, found, issues: issuesFor(refs, found) };
}

/** Every published start, including Call, replay and recovery, crosses this fence. */
export async function requireRunTableReferences(
  transaction: WorkspaceTransaction,
  workflowVersionId: string,
): Promise<void> {
  const nodes = await readVersionNodes(transaction, workflowVersionId);
  if (nodes === undefined || nodes === null) return;
  const refs = references({ nodes });
  if (refs.length === 0) return;
  const found = await readTablesByIdentity(
    transaction.db,
    transaction.workspaceId,
    refs.map(({ binding }) => dataTableIdentity(binding.config)),
  );
  const issues = issuesFor(refs, found);
  if (issues.length > 0)
    throw new DataTableError(
      'invalid_values',
      issues[0]?.message ?? 'Review table columns.',
    );
}
