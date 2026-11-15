import { credentialCommandScope } from '@pertexo/database/platform';
import { claimCommand, completeCommand } from '@pertexo/database/primitives';
import { appendAuditFact } from '../../../governance/audit/facts.js';
import { generatePersistedId } from '@pertexo/database/platform';
import type { Role } from '@pertexo/policy';
import { EMPTY_WORKFLOW_GRAPH } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import { lockArtifactReferences } from '../../../artifacts/references/lock-references.js';
import { readFolderScope } from '../../../shared/folder-access-facts.repository.js';
import { requireWorkflowCallTargets } from '../../../shared/resources/require-workflow-call-targets.js';
import { requireConnectionBindings } from '../../../shared/resources/require-connection-bindings.js';
import { decodeStoredReceipt } from '../../../shared/receipts.js';
import { requireWorkflowInScope } from '../access.js';
import { createdWorkflowReceipt } from '../receipts.repository.js';
import type { AuthoringCatalogs } from '../catalogs.js';
import type {
  CreateWorkflowInput,
  CreateWorkflowResult,
} from '../workflow-commands.types.js';
import { WorkflowNotFoundError } from '../workflow-authoring.errors.js';
import { requirePlaceableDefinitionAdditions } from '../placement.js';
import { projectDraft } from '../representation/workflow-representations.repository.js';
import {
  insertNewWorkflow,
  readWorkflowWithDraft,
} from './new-workflow.repository.js';

type CreatedReceipt = Readonly<{ workflowId: string }>;

export async function createWorkflow(
  client: PoolClient,
  input: CreateWorkflowInput,
  { definitionCatalog, placementDefinitionCatalog }: AuthoringCatalogs,
  role: Role,
): Promise<CreateWorkflowResult> {
  const workflowId = input.id ?? generatePersistedId();
  const graph = input.emptyGraph;
  requirePlaceableDefinitionAdditions(
    EMPTY_WORKFLOW_GRAPH,
    graph,
    placementDefinitionCatalog,
  );
  const folderId = input.folderId == null ? null : input.folderId.toLowerCase();
  if (
    folderId !== null &&
    !(await readFolderScope(client, input, role)).permits(
      folderId,
      'workflow:create',
    )
  )
    throw new WorkflowNotFoundError('Folder is not visible');
  const name = input.name;
  const command = {
    workspaceId: input.workspaceId,
    operation: 'workflow.create',
    scope: credentialCommandScope(input.actorId, input.commandCredentialId),
    idempotencyKey: input.idempotencyKey,
  };
  const stored = await claimCommand<CreatedReceipt>(client, {
    ...command,
    request: {
      name,
      graph,
      requestedWorkflowId: input.id ?? null,
      ...(folderId === null ? {} : { folderId }),
    },
    resourceId: workflowId,
  });
  let createdId = workflowId;
  if (stored !== null) {
    createdId = decodeStoredReceipt(createdWorkflowReceipt, stored).workflowId;
    await requireWorkflowInScope(
      client,
      await readFolderScope(client, input, role),
      { workspaceId: input.workspaceId, workflowId: createdId },
      'workflow:read',
    );
  } else {
    await requireWorkflowCallTargets(client, input, graph);
    await requireConnectionBindings(client, input, graph);
    await lockArtifactReferences(
      client,
      input.workspaceId,
      graph,
      input.actorId,
    );
    await insertNewWorkflow(client, {
      workspaceId: input.workspaceId,
      workflowId,
      name,
      actorId: input.actorId,
      folderId,
      graph,
    });
    await appendAuditFact(client, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: 'workflow.created',
      targetType: 'workflow',
      targetId: workflowId,
      requestId: input.requestId ?? null,
      traceId: input.traceId ?? null,
      metadata: { revision: 1 },
    });
    await completeCommand(client, command, { workflowId });
  }
  const row = await readWorkflowWithDraft(client, {
    workspaceId: input.workspaceId,
    workflowId: createdId,
  });
  if (row === undefined)
    throw new WorkflowNotFoundError('Workflow is not visible');
  return Object.freeze({
    workflowId: createdId,
    workflow: Object.freeze(row.workflow),
    draft: projectDraft(row.draft, definitionCatalog),
  });
}
