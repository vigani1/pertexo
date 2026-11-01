import type { PoolClient } from 'pg';
import { sql, and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowVersions } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  DataTableError,
  isDataTableDefinition,
  resolveDataTableBindings,
  type DataTableConfig,
} from '@pertexo/node-sdk';
import {
  isRecord,
  type WorkflowNode,
  type WorkflowGraph,
  type GraphValidationIssue,
} from '@pertexo/workflow-model';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { readTablesByNames } from '../definitions.queries.js';
import type { DataTableDefinition } from '../contract.js';

type ReferenceNode = Pick<
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
    config: DataTableConfig;
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
      if (isDataTableDefinition(node.definition))
        found.push({
          config: node.config as DataTableConfig,
          path,
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
      const table = tables.find((table) => table.name === ref.config.table);
      if (table === undefined)
        throw new DataTableError(
          'not_found',
          `Table ${ref.config.table} is unavailable. Select an existing table.`,
        );
      const names = resolveDataTableBindings({
        columns: table.columns,
        bindings: ref.config.columnBindings,
        hasRemovedColumns: table.hasRemovedColumns,
      });
      for (const alias of literalAliases(ref.node))
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
  const refs = references(graph);
  if (refs.length === 0) return [];
  const found = await readTablesByNames(
    drizzle(client),
    workspaceId,
    refs.map((ref) => ref.config.table),
  ).catch(rethrowQueryFailure);
  return issuesFor(refs, found);
}

/** Every published start, including Call, replay and recovery, crosses this fence. */
export async function requireRunTableReferences(
  transaction: WorkspaceTransaction,
  workflowVersionId: string,
): Promise<void> {
  const [version] = await transaction.db
    .select({
      nodes: sql<
        readonly ReferenceNode[] | null
      >`${workflowVersions.graphJson}->'nodes'`,
    })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workspaceId, transaction.workspaceId),
        eq(workflowVersions.id, workflowVersionId),
      ),
    );
  const nodes = version?.nodes;
  if (nodes === undefined || nodes === null) return;
  const refs = references({ nodes });
  if (refs.length === 0) return;
  const found = await readTablesByNames(
    transaction.db,
    transaction.workspaceId,
    refs.map((ref) => ref.config.table),
  );
  const issues = issuesFor(refs, found);
  if (issues.length > 0)
    throw new DataTableError(
      'invalid_values',
      issues[0]?.message ?? 'Review table columns.',
    );
}
