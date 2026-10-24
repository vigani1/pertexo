import { drizzle } from 'drizzle-orm/node-postgres';
import { and, sql } from 'drizzle-orm';
import { connections } from '../../../schema/connections.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import {
  canonicalJson,
  InvalidWorkflowGraphError,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import { uuidSchema } from '../../../connections/admission.js';
import type { WorkspaceTransaction } from '../../transactions.js';
import type { ResourceActor } from '../contract.js';
import {
  connectionScopeSql,
  readConnectionScope,
  type ConnectionScope,
} from './scope.js';

type ConnectionReference = Readonly<{
  id: string;
  path: string;
  enabled: boolean;
}>;
function bindings(graph: WorkflowGraph): Map<string, ConnectionReference> {
  const result = new Map<string, ConnectionReference>();
  const pending: {
    graph: WorkflowGraph;
    path: readonly string[];
    enabled: boolean;
  }[] = [{ graph, path: [], enabled: true }];
  for (const level of pending)
    for (const node of level.graph.nodes) {
      const path = [...level.path, node.id];
      const enabled = level.enabled && !(node.disabled ?? false);
      for (const [slot, id] of Object.entries(node.connectionRefs))
        result.set(
          canonicalJson([path, node.definition, slot, id.toLowerCase()]),
          {
            id,
            enabled,
            path: `$.${path.map((id) => `nodes.${id}`).join('.structured.body.')}.connectionRefs.${slot}`,
          },
        );
      if (node.structured !== undefined)
        pending.push({ graph: node.structured.body, path, enabled });
    }
  return result;
}

export function workflowConnectionReferences(
  graph: WorkflowGraph,
): readonly ConnectionReference[] {
  return [...bindings(graph).values()];
}
export function connectionReferenceIds(
  references: readonly { id: string }[],
): string[] {
  return [
    ...new Set(
      references.flatMap((reference) => {
        const parsed = uuidSchema.safeParse(reference.id);
        return parsed.success ? [parsed.data.toLowerCase()] : [];
      }),
    ),
  ];
}

/** The source is checked before a new reference can authorize any use of it. */
export async function connectionUseIssues(
  transaction: Pick<WorkspaceTransaction, 'db'>,
  scope: ConnectionScope,
  references: readonly { id: string; path: string }[],
  locking: 'share' | 'none' = 'none',
) {
  if (references.length === 0) return [];
  const ids = connectionReferenceIds(references);
  const query = transaction.db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        sql`${connections.id}=any(${sql.param(ids)}::uuid[])`,
        connectionScopeSql(scope, connections),
      ),
    )
    .orderBy(connections.id);
  const allowed =
    ids.length === 0
      ? []
      : await (locking === 'share' ? query.for('share') : query).catch(
          rethrowQueryFailure,
        );
  const permitted = new Set(allowed.map((row) => row.id));
  const issues = references
    .filter((reference) => !permitted.has(reference.id.toLowerCase()))
    .map((reference) => ({
      code: 'invalid_graph' as const,
      path: reference.path,
      message:
        'This connection is unavailable. Choose a connection you can use.',
    }));
  return issues;
}

export async function requireTransactionConnectionBindings(
  transaction: Pick<WorkspaceTransaction, 'db'>,
  scope: ConnectionScope,
  references: readonly { id: string; path: string }[],
): Promise<void> {
  const issues = await connectionUseIssues(
    transaction,
    scope,
    references,
    'share',
  );
  if (issues.length > 0) throw new InvalidWorkflowGraphError(issues);
}

/** Ordinary saves retain unchanged site bindings; executable admissions pass no previous graph. */
export async function requireConnectionBindings(
  client: PoolClient,
  actor: ResourceActor,
  graph: WorkflowGraph,
  previous?: WorkflowGraph,
): Promise<void> {
  const before = new Set(
    previous === undefined ? [] : bindings(previous).keys(),
  );
  const added = [...bindings(graph)]
    .filter(([key]) => !before.has(key))
    .map(([, reference]) => reference);
  if (added.length === 0) return;
  await requireTransactionConnectionBindings(
    { db: drizzle(client) },
    await readConnectionScope(client, actor, 'connection:use'),
    added,
  );
}
