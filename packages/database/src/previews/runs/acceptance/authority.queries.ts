import { readTransactionFolderScope } from '../../../tenant-access/resources/facts.js';
import { workflowScopeSql } from '../../../tenant-access/resources/query-scope.js';

import { rolesForCapability } from '@pertexo/workflow-model';

import { and, eq, sql } from 'drizzle-orm';

import {
  workflowDrafts,
  workspaceMemberships,
  workspaces,
  users,
  workflows,
} from '../../../schema.js';

import type { WorkspaceTransaction } from '../../../tenant-access/transactions.js';

import { PreviewAdmissionDeniedError } from './contract.js';

export async function assertAdmission(
  transaction: WorkspaceTransaction,
  workflowId: string,
  draftRevision: number,
) {
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
  if (workflow.length !== 1) throw new PreviewAdmissionDeniedError('draft');
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
  if (drafts[0]?.revision !== draftRevision)
    throw new PreviewAdmissionDeniedError('draft');
  return drafts[0].graph;
}

export async function assertPreviewActor(
  transaction: WorkspaceTransaction,
  actorUserId: string,
): Promise<void> {
  const workspace = await transaction.db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, transaction.workspaceId),
        eq(workspaces.status, 'active'),
      ),
    )
    .for('share')
    .limit(1);
  const actor = await transaction.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actorUserId), eq(users.status, 'active')))
    .for('share')
    .limit(1);
  const membership = await transaction.db
    .select({ role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, transaction.workspaceId),
        eq(workspaceMemberships.userId, actorUserId),
        eq(workspaceMemberships.status, 'active'),
      ),
    )
    .for('share')
    .limit(1);
  const authorUnavailable =
    workspace.length !== 1 ||
    actor.length !== 1 ||
    membership[0] === undefined ||
    !rolesForCapability('workflow:update').some(
      (role) => role === membership[0]?.role,
    );
  if (authorUnavailable) throw new PreviewAdmissionDeniedError('actor');
}

async function previewWorkflowScope(
  transaction: WorkspaceTransaction,
  actorId: string,
  workflowId: string,
  capability: 'workflow:read' | 'workflow:update',
) {
  const scope = await readTransactionFolderScope(transaction, {
    workspaceId: transaction.workspaceId,
    actorId,
  });
  const visible = await transaction.db
    .execute(sql`select 1 from app.workflows workflow
    where workflow.workspace_id=${transaction.workspaceId} and workflow.id=${workflowId}
      and ${workflowScopeSql(scope, sql`workflow.id`, capability)}`);
  return visible.rows.length === 1 ? scope : undefined;
}

export async function previewWorkflowVisible(
  transaction: WorkspaceTransaction,
  actorId: string,
  workflowId: string,
  capability: 'workflow:read' | 'workflow:update',
): Promise<boolean> {
  return (
    (await previewWorkflowScope(
      transaction,
      actorId,
      workflowId,
      capability,
    )) !== undefined
  );
}

export async function assertPreviewWorkflow(
  transaction: WorkspaceTransaction,
  actorId: string,
  workflowId: string,
  capability: 'workflow:read' | 'workflow:update',
) {
  const resources = await previewWorkflowScope(
    transaction,
    actorId,
    workflowId,
    capability,
  );
  if (resources === undefined) throw new PreviewAdmissionDeniedError('draft');
  return resources;
}
