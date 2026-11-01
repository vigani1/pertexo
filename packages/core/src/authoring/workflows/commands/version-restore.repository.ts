import {
  appendAuditFact,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/server';
import { and, eq, exists, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { lockArtifactReferences } from '../../../artifacts/references/repository.js';
import {
  workflowDrafts,
  workflows,
  workflowVersions,
} from '@pertexo/database/schema';
import { requireWorkflowCallTargets } from '../../../tenant-access/resources/bindings.queries.js';
import { requireConnectionBindings } from '../../../tenant-access/resources/connections/bindings.queries.js';
import { pruneStepSamples } from '../../step-samples/records.repository.js';

import type { WorkflowAuthoringWriteContext } from '../context.js';
import type {
  RestoreWorkflowVersionInput,
  WorkflowAuthoringDatabase,
} from '../contract.js';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '../errors.js';
import type { WorkflowDraftRecord } from '../representation/contract.js';
import {
  draftProjection,
  projectDraft,
  projectVersion,
  versionProjection,
} from '../representation/records.queries.js';

type VersionRestoreStore = Pick<
  WorkflowAuthoringDatabase,
  'restoreWorkflowVersion'
>;

async function restoreWorkflowVersion(
  context: WorkflowAuthoringWriteContext,
  input: RestoreWorkflowVersionInput,
): Promise<WorkflowDraftRecord> {
  const workspaceId = input.workspaceId;
  const workflowId = input.workflowId;
  const versionId = input.versionId;
  const actorId = input.actorId;
  const representationTag = input.representationTag;

  return context.transact(workspaceId, actorId, async (client) => {
    await context.requireAuthor(client, workspaceId, {
      actorId,
      workflowId,
    });
    const { definitionCatalog, placementDefinitionCatalog } = context.catalogs;

    const db = drizzle(client);
    const [workflow] = await db
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.workspaceId, workspaceId),
          eq(workflows.id, workflowId),
          eq(workflows.lifecycleStatus, 'active'),
        ),
      )
      .for('update')
      .catch(rethrowQueryFailure);
    if (workflow === undefined)
      throw new WorkflowNotFoundError('Workflow is not visible');
    const [draftRow] = await db
      .select(draftProjection)
      .from(workflowDrafts)
      .where(
        and(
          eq(workflowDrafts.workspaceId, workspaceId),
          eq(workflowDrafts.workflowId, workflowId),
        ),
      )
      .for('update')
      .catch(rethrowQueryFailure);
    if (draftRow === undefined)
      throw new WorkflowNotFoundError('Workflow is not visible');
    const currentDraft = projectDraft(draftRow, definitionCatalog);
    const currentTag = workflowDraftRepresentationTag({
      workflowId,
      revision: currentDraft.revision,
      graph: currentDraft.graphJson,
      compatibilityFingerprint: currentDraft.compatibility.fingerprint,
    });
    if (currentTag !== representationTag)
      throw new WorkflowRevisionConflictError(
        currentDraft.revision,
        currentTag,
      );

    const sourceVersion = await readRestorationSource(client, {
      workspaceId,
      workflowId,
      versionId,
    });
    context.requirePlaceable(
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
      throw new WorkflowRevisionConflictError(
        currentDraft.revision,
        currentTag,
      );
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
    return restoredDraft;
  });
}

export function createWorkflowVersionRestoreStore(
  context: WorkflowAuthoringWriteContext,
): VersionRestoreStore {
  return Object.freeze({
    restoreWorkflowVersion: (input) => restoreWorkflowVersion(context, input),
  });
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
