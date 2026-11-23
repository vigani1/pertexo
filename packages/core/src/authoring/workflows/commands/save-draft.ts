import { admitDraftCandidate } from '../admit-draft-candidate.js';
import { appendAuditFact } from '../../../governance/audit/facts.js';
import type { PoolClient } from 'pg';
import { pruneStepSamples } from '../../step-samples/step-sample-state.repository.js';

import type { AuthoringCatalogs } from '../catalogs.js';
import type { SaveWorkflowDraftInput } from '../workflow-commands.types.js';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '../workflow-authoring.errors.js';
import type { WorkflowDraftRecord } from '../representation/workflow-record.types.js';
import { draftRepresentationTag } from '../representation/tag.js';
import { projectDraft } from '../representation/workflow-representations.repository.js';
import {
  readActiveDraft,
  replaceDraftGraph,
} from './draft-revisions.repository.js';

export async function saveDraft(
  client: PoolClient,
  input: SaveWorkflowDraftInput,
  { definitionCatalog, placementDefinitionCatalog }: AuthoringCatalogs,
): Promise<WorkflowDraftRecord> {
  const representationTag = input.representationTag;
  const graph = input.graphJson;
  const expected = input.expectedRevision;
  const workflowId = input.workflowId;
  const currentRow = await readActiveDraft(client, {
    workspaceId: input.workspaceId,
    workflowId,
  });
  if (currentRow === undefined)
    throw new WorkflowNotFoundError('Workflow is not visible');
  const currentDraft = projectDraft(currentRow, definitionCatalog);
  const currentTag = draftRepresentationTag(workflowId, currentDraft);
  if (currentTag !== representationTag || currentDraft.revision !== expected)
    throwRevisionConflict(workflowId, currentDraft);
  const refusal = await admitDraftCandidate(client, input, {
    previous: currentDraft.graphJson,
    graph,
    catalog: placementDefinitionCatalog,
  });
  if (refusal !== undefined) throw refusal.error;
  const row = await replaceDraftGraph(client, {
    workspaceId: input.workspaceId,
    workflowId,
    expectedRevision: expected,
    graph,
    actorId: input.actorId,
  });
  if (row === undefined) {
    const latest = await readActiveDraft(client, {
      workspaceId: input.workspaceId,
      workflowId,
    });
    if (latest === undefined)
      throw new WorkflowNotFoundError('Workflow is not visible');
    throwRevisionConflict(workflowId, projectDraft(latest, definitionCatalog));
  }
  const saved = projectDraft(row, definitionCatalog);
  await pruneStepSamples(client, input.workspaceId, workflowId, graph);

  await appendAuditFact(client, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: 'workflow.draft_saved',
    targetType: 'workflow',
    targetId: input.workflowId,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
    metadata: { previousRevision: expected, revision: saved.revision },
  });
  return saved;
}

function throwRevisionConflict(
  workflowId: string,
  draft: WorkflowDraftRecord,
): never {
  throw new WorkflowRevisionConflictError(
    draft.revision,
    draftRepresentationTag(workflowId, draft),
  );
}
