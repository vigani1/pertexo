import { canonicalJson } from '@pertexo/workflow-model';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import type { FolderScope } from '../../../shared/folder-access.types.js';
import { duplicateWorkflow } from './duplicate.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { appendAuditFact } from '../../../governance/audit/facts.js';
import { and, eq, exists, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { lockArtifactReferences } from '../../../artifacts/references/locks.repository.js';
import {
  workflowDrafts,
  workflowOrganizationState,
  workflows,
  workflowVersions,
} from '@pertexo/database/schema';
import { requireWorkflowCallTargets } from '../../../tenant-access/resources/bindings.repository.js';
import { requireConnectionBindings } from '../../../tenant-access/resources/connections/bindings.repository.js';
import { pruneStepSamples } from '../../step-samples/records.repository.js';

import type { AuthoringCatalogs } from '../catalogs.js';
import type { RestoreWorkflowVersionInput } from '../workflow-commands.types.js';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '../workflow-authoring.errors.js';
import { requirePlaceableDefinitionAdditions } from '../placement.js';
import { draftRepresentationTag } from '../representation/tag.js';
import { lockActiveWorkflow, lockDraft } from './locks.repository.js';
import type { WorkflowDraftRecord } from '../representation/workflow-record.types.js';
import {
  draftProjection,
  projectDraft,
  projectVersion,
  versionProjection,
} from '../representation/workflow-representations.repository.js';

export async function restoreWorkflowVersion(
  client: PoolClient,
  input: RestoreWorkflowVersionInput,
  catalogs: AuthoringCatalogs,
  scope: FolderScope,
): Promise<WorkflowDraftRecord & Readonly<{ recoveryCopyId: string | null }>> {
  const { definitionCatalog, placementDefinitionCatalog } = catalogs;
  const workspaceId = input.workspaceId;
  const workflowId = input.workflowId;
  const versionId = input.versionId;
  const actorId = input.actorId;
  const representationTag = input.representationTag;

  const db = drizzle(client);
  await lockActiveWorkflow(client, input);
  const draftRow = await lockDraft(client, input);
  if (draftRow === undefined)
    throw new WorkflowNotFoundError('Workflow is not visible');
  const currentDraft = projectDraft(draftRow, definitionCatalog);
  const currentTag = draftRepresentationTag(workflowId, currentDraft);
  if (currentTag !== representationTag)
    throw new WorkflowRevisionConflictError(currentDraft.revision, currentTag);

  const sourceVersion = await readRestorationSource(client, {
    workspaceId,
    workflowId,
    versionId,
  });
  requirePlaceableDefinitionAdditions(
    currentDraft.graphJson,
    sourceVersion.graphJson,
    placementDefinitionCatalog,
  );

  await requireWorkflowCallTargets(
    client,
    { workspaceId, actorId },
    sourceVersion.graphJson,
  );
  await requireConnectionBindings(
    client,
    { workspaceId, actorId },
    sourceVersion.graphJson,
  );
  await lockArtifactReferences(
    client,
    workspaceId,
    sourceVersion.graphJson,
    actorId,
  );
  const recoveryCopyId = await preserveUnpublishedDraft(
    client,
    input,
    catalogs,
    { scope, current: currentDraft, restoredGraph: sourceVersion.graphJson },
  );
  const visible = db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, workspaceId),
        eq(workflows.id, workflowId),
        eq(workflows.lifecycleStatus, 'active'),
      ),
    );
  const [updatedRow] = await db
    .update(workflowDrafts)
    .set({
      graphJson: sql`${JSON.stringify(sourceVersion.graphJson)}::json`,
      revision: sql`${workflowDrafts.revision}+1`,
      updatedBy: actorId,
      updatedAt: sql`transaction_timestamp()`,
    })
    .where(
      and(
        eq(workflowDrafts.workspaceId, workspaceId),
        eq(workflowDrafts.workflowId, workflowId),
        eq(workflowDrafts.revision, currentDraft.revision),
        exists(visible),
      ),
    )
    .returning(draftProjection)
    .catch(rethrowQueryFailure);
  if (updatedRow === undefined)
    throw new WorkflowRevisionConflictError(currentDraft.revision, currentTag);
  const restoredDraft = projectDraft(updatedRow, definitionCatalog);
  await pruneStepSamples(
    client,
    workspaceId,
    workflowId,
    sourceVersion.graphJson,
  );

  await appendAuditFact(client, {
    workspaceId,
    actorId: actorId,
    action: 'workflow.version_restored',
    targetType: 'workflow',
    targetId: workflowId,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
    metadata: {
      previousRevision: currentDraft.revision,
      revision: restoredDraft.revision,
      sourceVersionId: sourceVersion.id,
    },
  });
  return { ...restoredDraft, recoveryCopyId };
}

async function readRestorationSource(
  client: PoolClient,
  {
    workspaceId,
    workflowId,
    versionId,
  }: Pick<
    RestoreWorkflowVersionInput,
    'workspaceId' | 'workflowId' | 'versionId'
  >,
) {
  const db = drizzle(client);
  const [sourceRow] = await db
    .select(versionProjection)
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workspaceId, workspaceId),
        eq(workflowVersions.workflowId, workflowId),
        eq(workflowVersions.id, versionId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (sourceRow === undefined)
    throw new WorkflowNotFoundError('Workflow version is not visible');
  return projectVersion(sourceRow);
}

async function preserveUnpublishedDraft(
  client: PoolClient,
  input: RestoreWorkflowVersionInput,
  catalogs: AuthoringCatalogs,
  {
    scope,
    current,
    restoredGraph,
  }: Readonly<{
    scope: FolderScope;
    current: WorkflowDraftRecord;
    restoredGraph: WorkflowGraph;
  }>,
): Promise<string | null> {
  const displaced = canonicalJson(current.graphJson);
  if (displaced === canonicalJson(restoredGraph)) return null;
  const db = drizzle(client);
  const [workflow] = await db
    .select({
      name: workflows.name,
      publishedVersionId: workflows.publishedVersionId,
      folderId: workflowOrganizationState.folderId,
      date: sql<string>`to_char(transaction_timestamp() at time zone 'UTC','YYYY-MM-DD')`,
    })
    .from(workflows)
    .leftJoin(
      workflowOrganizationState,
      and(
        eq(workflowOrganizationState.workspaceId, workflows.workspaceId),
        eq(workflowOrganizationState.workflowId, workflows.id),
      ),
    )
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, input.workflowId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (workflow === undefined)
    throw new WorkflowNotFoundError('Workflow is not visible');
  if (workflow.publishedVersionId !== null) {
    const published = await readRestorationSource(client, {
      ...input,
      versionId: workflow.publishedVersionId,
    });
    if (displaced === canonicalJson(published.graphJson)) return null;
  }
  const suffix = ` (unpublished draft, ${workflow.date})`;
  const name =
    workflow.name
      .slice(0, 128 - suffix.length)
      .replace(/[\uD800-\uDBFF]$/u, '') + suffix;
  const copy = await duplicateWorkflow(
    client,
    {
      ...input,
      folderId: workflow.folderId,
      name,
      source: { kind: 'draft' },
      idempotencyKey: `restore:${String(current.revision)}:${input.versionId}`,
    },
    catalogs,
    scope,
  );
  return copy.workflowId;
}
