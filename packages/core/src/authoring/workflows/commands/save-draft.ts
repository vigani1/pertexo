import {
  appendAuditFact,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import { and, eq, exists, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { lockArtifactReferences } from '../../../artifacts/references/locks.repository.js';
import { workflowDrafts, workflows } from '@pertexo/database/schema';
import { requireWorkflowCallTargets } from '../../../tenant-access/resources/bindings.queries.js';
import { requireConnectionBindings } from '../../../tenant-access/resources/connections/bindings.queries.js';
import { pruneStepSamples } from '../../step-samples/records.repository.js';

import type { AuthoringCatalogs } from '../catalogs.js';
import type { SaveWorkflowDraftInput } from '../contract.js';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '../errors.js';
import type { WorkflowDraftRecord } from '../representation/contract.js';
import { draftRepresentationTag } from '../representation/tag.js';
import { requirePlaceableDefinitionAdditions } from '../placement.js';
import {
  draftProjection,
  projectDraft,
} from '../representation/records.queries.js';

export async function saveDraft(
  client: PoolClient,
  input: SaveWorkflowDraftInput,
  { definitionCatalog, placementDefinitionCatalog }: AuthoringCatalogs,
): Promise<WorkflowDraftRecord> {
  const representationTag = input.representationTag;
  const graph = input.graphJson;
  const expected = input.expectedRevision;
  const workflowId = input.workflowId;
  const [currentRow] = await readActiveDraft(client, {
    workspaceId: input.workspaceId,
    workflowId,
  });
  if (currentRow === undefined)
    throw new WorkflowNotFoundError('Workflow is not visible');
  const currentDraft = projectDraft(currentRow, definitionCatalog);
  const currentTag = draftRepresentationTag(workflowId, currentDraft);
  if (currentTag !== representationTag || currentDraft.revision !== expected)
    throwRevisionConflict(workflowId, currentDraft);
  requirePlaceableDefinitionAdditions(
    currentDraft.graphJson,
    graph,
    placementDefinitionCatalog,
  );
  await requireWorkflowCallTargets(
    client,
    input,
    graph,
    currentDraft.graphJson,
  );
  await requireConnectionBindings(client, input, graph, currentDraft.graphJson);
  await lockArtifactReferences(client, input.workspaceId, graph, input.actorId);
  const db = drizzle(client);
  const visible = db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, workflowId),
        eq(workflows.lifecycleStatus, 'active'),
      ),
    );
  const [row] = await db
    .update(workflowDrafts)
    .set({
      graphJson: sql`${JSON.stringify(graph)}::json`,
      revision: sql`${workflowDrafts.revision}+1`,
      updatedBy: input.actorId,
      updatedAt: sql`transaction_timestamp()`,
    })
    .where(
      and(
        eq(workflowDrafts.workspaceId, input.workspaceId),
        eq(workflowDrafts.workflowId, workflowId),
        eq(workflowDrafts.revision, expected),
        exists(visible),
      ),
    )
    .returning(draftProjection)
    .catch(rethrowQueryFailure);
  if (row === undefined) {
    const [latest] = await readActiveDraft(client, {
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

function readActiveDraft(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; workflowId: string }>,
) {
  return drizzle(client)
    .select(draftProjection)
    .from(workflowDrafts)
    .innerJoin(
      workflows,
      and(
        eq(workflows.workspaceId, workflowDrafts.workspaceId),
        eq(workflows.id, workflowDrafts.workflowId),
      ),
    )
    .where(
      and(
        eq(workflowDrafts.workspaceId, input.workspaceId),
        eq(workflowDrafts.workflowId, input.workflowId),
        eq(workflows.lifecycleStatus, 'active'),
      ),
    )
    .catch(rethrowQueryFailure);
}
