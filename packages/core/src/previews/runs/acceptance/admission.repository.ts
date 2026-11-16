import { readTransactionFolderScope } from '../../../shared/access/folder-access-facts.repository.js';
import { workflowScopeSql } from '../../../shared/access/folder-scope.repository.js';

import type { Role } from '@pertexo/policy';

import { and, eq, sql } from 'drizzle-orm';

import { workflowDrafts, workflows } from '@pertexo/database/schema';

import type { WorkspaceTransaction } from '@pertexo/database/primitives';

export async function lockActivePreviewWorkflow(
  transaction: WorkspaceTransaction,
  workflowId: string,
): Promise<boolean> {
  const workflow = await transaction.db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, transaction.workspaceId),
        eq(workflows.id, workflowId),
        eq(workflows.lifecycleStatus, 'active'),
      ),
    )
    .for('share')
    .limit(1);
  return workflow.length === 1;
}

export async function lockPreviewDraft(
  transaction: WorkspaceTransaction,
  workflowId: string,
) {
  const drafts = await transaction.db
    .select({
      revision: workflowDrafts.revision,
      graph: workflowDrafts.graphJson,
    })
    .from(workflowDrafts)
    .where(
      and(
        eq(workflowDrafts.workspaceId, transaction.workspaceId),
        eq(workflowDrafts.workflowId, workflowId),
      ),
    )
    .for('share')
    .limit(1);
  return drafts[0];
}

/** The actor's folder scope when it may update the workflow, else undefined. */
export async function previewWorkflowScope(
  transaction: WorkspaceTransaction,
  role: Role,
  actorId: string,
  workflowId: string,
) {
  const scope = await readTransactionFolderScope(
    transaction,
    { workspaceId: transaction.workspaceId, actorId },
    role,
  );
  const visible = await transaction.db
    .select({ one: sql`1` })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, transaction.workspaceId),
        eq(workflows.id, workflowId),
        workflowScopeSql(scope, sql`${workflows.id}`, 'workflow:update'),
      ),
    );
  return visible.length === 1 ? scope : undefined;
}

export async function previewWorkflowVisible(
  transaction: WorkspaceTransaction,
  role: Role,
  actorId: string,
  workflowId: string,
): Promise<boolean> {
  return (
    (await previewWorkflowScope(transaction, role, actorId, workflowId)) !==
    undefined
  );
}
