import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type {
  WorkflowOrganizationProjectionResponse,
  WorkflowOrganizationBulkItemOutcome,
} from '@pertexo/contracts/schemas/workflow-authoring';
import {
  freezeWorkflowOrganizationAttempt,
  type WorkflowOrganizationAttempt,
} from '../../model/workflow-organization';

export type OrganizationOperation = 'move' | 'replace_tags';
export function validOrganizationSelection(
  workflows: readonly WorkflowOrganizationProjectionResponse[],
) {
  return (
    workflows.length >= 1 &&
    workflows.length <= 50 &&
    new Set(workflows.map(({ workflow }) => workflow.id)).size ===
      workflows.length
  );
}
export function canEditOrganization(
  workspace: AccessibleWorkspace,
  workflows: readonly WorkflowOrganizationProjectionResponse[],
  operation: OrganizationOperation,
) {
  if (
    workspace.status !== 'active' ||
    !['owner', 'admin', 'builder'].includes(workspace.role) ||
    !workspace.capabilities.includes('workflow:update')
  )
    return false;
  const archived = workflows.some(
    ({ workflow }) => workflow.lifecycleStatus === 'archived',
  );
  return (
    !archived ||
    (operation === 'move' &&
      (workspace.role === 'owner' || workspace.role === 'admin'))
  );
}
export function organizationEditAttempt(
  workspaceId: string,
  workflows: readonly WorkflowOrganizationProjectionResponse[],
  operation: OrganizationOperation,
  folderId: string | null,
  tagIds: readonly string[],
  idempotencyKey: string,
): WorkflowOrganizationAttempt {
  if (!validOrganizationSelection(workflows))
    throw new Error('Select 1–50 distinct workflows.');
  const items = workflows.map(({ workflow, organization }) => ({
    workflowId: workflow.id,
    expectedOrganizationRevision: organization.organizationRevision,
  }));
  const single = items.length === 1 ? items[0] : undefined;
  const scope = { workspaceId, idempotencyKey };
  const replacementTagIds = [...new Set(tagIds)].sort();
  if (single !== undefined)
    return freezeWorkflowOrganizationAttempt(
      operation === 'move'
        ? {
            ...scope,
            kind: 'place-folder',
            workflowId: single.workflowId,
            body: {
              folderId,
              expectedOrganizationRevision: single.expectedOrganizationRevision,
            },
          }
        : {
            ...scope,
            kind: 'replace-tags',
            workflowId: single.workflowId,
            body: {
              tagIds: replacementTagIds,
              expectedOrganizationRevision: single.expectedOrganizationRevision,
            },
          },
    );
  return freezeWorkflowOrganizationAttempt({
    ...scope,
    kind: 'bulk',
    body:
      operation === 'move'
        ? { operation, folderId, items }
        : { operation, tagIds: replacementTagIds, items },
  });
}
export function organizationOutcomeText(
  item: WorkflowOrganizationBulkItemOutcome,
) {
  switch (item.status) {
    case 'updated':
      return item.replayed ? 'Updated — original result replayed' : 'Updated';
    case 'not_visible':
      return 'Not visible — no change confirmed';
    case 'unavailable':
      return 'Unavailable — retry the original request';
    case 'outcome_unknown':
      return 'Outcome unknown — retry the original request';
    case 'forbidden':
      return 'Access lost — processing stopped';
    case 'not_processed':
      return 'Not processed after access loss';
    case 'conflict': {
      const messages = {
        'workflow.organization_revision_conflict':
          'Conflict — organization changed',
        'request.idempotency_conflict':
          'Conflict — request key used for different input',
        'workflow.lifecycle_conflict': 'Conflict — workflow lifecycle changed',
        'workflow.folder_not_visible': 'Conflict — folder no longer visible',
      };
      return messages[item.code];
    }
  }
}
