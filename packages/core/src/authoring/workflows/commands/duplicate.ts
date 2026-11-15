import { claimCommand, completeCommand } from '@pertexo/database/primitives';
import { appendAuditFact } from '../../../governance/audit/facts.js';
import {
  EMPTY_WORKFLOW_GRAPH,
  InvalidWorkflowGraphError,
  parseWorkflowGraphDraft,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import type { WorkflowDefinitionCatalog } from '@pertexo/workflow-model/server';
import type { PoolClient } from 'pg';
import { lockArtifactReferences } from '../../../artifacts/references/lock-references.js';
import { requireWorkflowCallTargets } from '../../../shared/resources/require-workflow-call-targets.js';
import { requireConnectionBindings } from '../../../shared/resources/require-connection-bindings.js';

import { generatePersistedId } from '@pertexo/database/platform';
import { decodeStoredValue } from '../../../shared/stored-values.js';
import type { FolderScope } from '../../../shared/folder-access.types.js';
import { decodeStoredReceipt } from '../../../shared/receipts.js';
import { requireWorkflowInScope } from '../access.js';
import { createdWorkflowReceipt } from '../receipts.repository.js';
import type { AuthoringCatalogs } from '../catalogs.js';
import type {
  DuplicateWorkflowInput,
  DuplicateWorkflowResult,
} from '../workflow-commands.types.js';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '../workflow-authoring.errors.js';
import { requirePlaceableDefinitionAdditions } from '../placement.js';
import { projectDraft } from '../representation/workflow-representations.repository.js';
import { draftRepresentationTag } from '../representation/tag.js';
import {
  lockDraft,
  lockWorkflowLifecycleStatus,
  shareLockWorkflow,
} from './locks.repository.js';
import {
  inheritTemplateOrigin,
  insertNewWorkflow,
} from './new-workflow.repository.js';
import { readVersionGraph } from './version-sources.repository.js';

async function selectedGraph(
  client: PoolClient,
  input: DuplicateWorkflowInput,
  catalog: WorkflowDefinitionCatalog,
): Promise<WorkflowGraph> {
  if (input.source.kind === 'version') {
    const graphJson = await readVersionGraph(client, {
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      versionId: input.source.versionId,
    });
    if (graphJson === undefined)
      throw new WorkflowNotFoundError('Workflow source is not visible');
    return decodeStoredValue(() => parseWorkflowGraphDraft(graphJson));
  }
  const row = await lockDraft(client, input);
  if (row === undefined)
    throw new WorkflowNotFoundError('Workflow source is not visible');
  const draft = projectDraft(row, catalog);
  const tag = draftRepresentationTag(input.workflowId, draft);
  if (tag !== input.representationTag)
    throw new WorkflowRevisionConflictError(draft.revision, tag);
  return draft.graphJson;
}

export async function duplicateWorkflow(
  client: PoolClient,
  input: DuplicateWorkflowInput,
  { definitionCatalog, placementDefinitionCatalog }: AuthoringCatalogs,
  scope: FolderScope,
) {
  // Workflow precedes draft, consistent with restore/publication/lifecycle.
  const sourceStatus = await lockWorkflowLifecycleStatus(client, input);
  if (sourceStatus === undefined)
    throw new WorkflowNotFoundError('Workflow source is not visible');
  const destinationId = generatePersistedId();
  // The graph is not part of the request: a retry duplicates the same
  // reviewed source, or replays the first result.
  const command = {
    workspaceId: input.workspaceId,
    operation: 'workflow.duplicate',
    scope: `${input.actorId}:${input.workflowId}`,
    idempotencyKey: input.idempotencyKey,
  };
  const stored = await claimCommand<DuplicateWorkflowResult>(client, {
    ...command,
    request: {
      name: input.name,
      ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
      source: input.source,
      representationTag:
        input.source.kind === 'draft' ? input.representationTag : null,
    },
    resourceId: destinationId,
  });
  if (stored !== null) {
    const replay = decodeStoredReceipt(createdWorkflowReceipt, stored);
    await requireWorkflowInScope(
      client,
      scope,
      { workspaceId: input.workspaceId, workflowId: replay.workflowId },
      'workflow:read',
    );
    if (
      !(await shareLockWorkflow(client, {
        workspaceId: input.workspaceId,
        workflowId: replay.workflowId,
      }))
    )
      throw new WorkflowNotFoundError('Workflow destination is not visible');
    return Object.freeze(replay);
  }
  if (sourceStatus !== 'active')
    throw new WorkflowNotFoundError('Workflow source is not visible');
  if (!scope.permits(input.folderId ?? null, 'workflow:create'))
    throw new WorkflowNotFoundError('Workflow destination is not visible');
  const graph = await selectedGraph(client, input, definitionCatalog);
  requirePlaceableDefinitionAdditions(
    EMPTY_WORKFLOW_GRAPH,
    graph,
    placementDefinitionCatalog ?? definitionCatalog,
  );
  await requireWorkflowCallTargets(client, input, graph);
  try {
    await requireConnectionBindings(client, input, graph);
  } catch (error) {
    if (error instanceof InvalidWorkflowGraphError)
      throw new WorkflowNotFoundError('Workflow connection is not visible');
    throw error;
  }
  await lockArtifactReferences(client, input.workspaceId, graph, input.actorId);
  await persistDuplicate(client, input, { destinationId, graph });
  const result = Object.freeze({ workflowId: destinationId });
  await completeCommand(client, command, result);
  return result;
}
type DuplicatePersistenceInput = Pick<
  DuplicateWorkflowInput,
  | 'workspaceId'
  | 'workflowId'
  | 'actorId'
  | 'name'
  | 'folderId'
  | 'source'
  | 'requestId'
  | 'traceId'
>;

/** Preserve an already-saved draft, including obsolete definitions and bindings. */
export async function recoverWorkflowDraft(
  client: PoolClient,
  input: Omit<DuplicatePersistenceInput, 'source'> &
    Readonly<{ graph: WorkflowGraph }>,
  scope: FolderScope,
): Promise<string> {
  if (!scope.permits(input.folderId ?? null, 'workflow:create'))
    throw new WorkflowNotFoundError('Workflow destination is not visible');
  const destinationId = generatePersistedId();
  await persistDuplicate(
    client,
    { ...input, source: { kind: 'draft' } },
    { destinationId, graph: input.graph },
  );
  return destinationId;
}

async function persistDuplicate(
  client: PoolClient,
  input: DuplicatePersistenceInput,
  {
    destinationId,
    graph,
  }: Readonly<{ destinationId: string; graph: WorkflowGraph }>,
) {
  await insertNewWorkflow(client, {
    workspaceId: input.workspaceId,
    workflowId: destinationId,
    name: input.name,
    actorId: input.actorId,
    folderId: input.folderId,
    graph,
  });
  await inheritTemplateOrigin(client, {
    workspaceId: input.workspaceId,
    sourceWorkflowId: input.workflowId,
    destinationId,
  });
  await appendAuditFact(client, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: 'workflow.duplicated',
    targetType: 'workflow',
    targetId: destinationId,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
    metadata: {
      sourceWorkflowId: input.workflowId,
      source: input.source,
      revision: 1,
    },
  });
}
