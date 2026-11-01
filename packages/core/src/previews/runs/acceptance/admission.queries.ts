import { readTransactionFolderScope } from '../../../shared/facts.queries.js';
import { workflowScopeSql } from '../../../shared/scope.queries.js';

import type { Role } from '@pertexo/workflow-model';

import { and, eq, sql } from 'drizzle-orm';

import { workflowDrafts, workflows } from '@pertexo/database/schema';

import type { WorkspaceTransaction } from '@pertexo/database/primitives';

import { PreviewAdmissionDeniedError } from '../../errors.js';

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

async function previewWorkflowScope(
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

export async function assertPreviewWorkflow(
  transaction: WorkspaceTransaction,
  role: Role,
  actorId: string,
  workflowId: string,
) {
  const resources = await previewWorkflowScope(
    transaction,
    role,
    actorId,
    workflowId,
  );
  if (resources === undefined) throw new PreviewAdmissionDeniedError('draft');
  return resources;
}
