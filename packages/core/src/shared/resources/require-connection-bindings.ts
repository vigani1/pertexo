import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import {
  addedWorkflowConnectionReferences,
  InvalidWorkflowGraphError,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import type { ResourceActor } from '../access/folder-access.types.js';
import {
  readConnectionScope,
  type ConnectionScope,
} from './connection-scope.repository.js';
import { connectionUseIssues } from './connection-bindings.repository.js';

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
  const added = addedWorkflowConnectionReferences(graph, previous);
  if (added.length === 0) return;
  await requireTransactionConnectionBindings(
    { db: drizzle(client) },
    await readConnectionScope(client, actor, 'connection:use'),
    added,
  );
}
