import { z } from 'zod';
import { decodeStoredReceipt } from '../../../shared/receipts.js';
import { canonicalJson } from '@pertexo/workflow-model';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import type { FolderScope } from '../../../shared/folder-access.types.js';
import { recoverWorkflowDraft } from './duplicate.js';
import { WORKFLOW_NAME_MAX_CHARACTERS } from '../receipts.repository.js';
import { claimCommand, completeCommand } from '@pertexo/database/primitives';
import { appendAuditFact } from '../../../governance/audit/facts.js';
import type { PoolClient } from 'pg';
import { lockArtifactReferences } from '../../../artifacts/references/locks.repository.js';
import { requireWorkflowCallTargets } from '../../../shared/resources/workflow-call-bindings.repository.js';
import { requireConnectionBindings } from '../../../shared/resources/connection-bindings.repository.js';
import { pruneStepSamples } from '../../step-samples/step-sample-state.repository.js';

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
  projectDraft,
  projectVersion,
} from '../representation/workflow-representations.repository.js';
import { replaceDraftGraph } from './draft-revisions.repository.js';
import {
  readRecoveryCopySource,
  readVersionRow,
} from './version-sources.repository.js';

const restoreReceipt = z
  .object({
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    updatedAt: z.iso.datetime().transform((value) => new Date(value)),
    recoveryCopyId: z.uuid().nullable(),
  })
  .strict();

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

  await lockActiveWorkflow(client, input);
  const command =
    input.idempotencyKey === undefined
      ? null
      : {
          workspaceId,
          operation: 'workflow.version.restore',
          scope: `${actorId}:${workflowId}`,
          idempotencyKey: input.idempotencyKey,
        };
  const stored =
    command === null
      ? null
      : await claimCommand(client, {
          ...command,
          request: { versionId, representationTag },
          resourceId: workflowId,
        });
  if (stored !== null) {
    const receipt = decodeStoredReceipt(restoreReceipt, stored);
    const source = await readRestorationSource(client, input);
    return {
      ...projectDraft(
        {
          workspaceId,
          workflowId,
          revision: receipt.revision,
          updatedAt: receipt.updatedAt,
          updatedBy: actorId,
          graphJson: source.graphJson,
        },
        definitionCatalog,
      ),
      recoveryCopyId: receipt.recoveryCopyId,
    };
  }
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
  const recoveryCopyId = await preserveUnpublishedDraft(client, input, {
    scope,
    current: currentDraft,
    restoredGraph: sourceVersion.graphJson,
  });
  const updatedRow = await replaceDraftGraph(client, {
    workspaceId,
    workflowId,
    expectedRevision: currentDraft.revision,
    graph: sourceVersion.graphJson,
    actorId,
  });
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
  if (command !== null)
    await completeCommand(client, command, {
      revision: restoredDraft.revision,
      updatedAt: restoredDraft.updatedAt.toISOString(),
      recoveryCopyId,
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
  const sourceRow = await readVersionRow(client, {
    workspaceId,
    workflowId,
    versionId,
  });
  if (sourceRow === undefined)
    throw new WorkflowNotFoundError('Workflow version is not visible');
  return projectVersion(sourceRow);
}

async function preserveUnpublishedDraft(
  client: PoolClient,
  input: RestoreWorkflowVersionInput,
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
  const workflow = await readRecoveryCopySource(client, input);
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
      .slice(0, WORKFLOW_NAME_MAX_CHARACTERS - suffix.length)
      .replace(/[\uD800-\uDBFF]$/u, '') + suffix;
  return recoverWorkflowDraft(
    client,
    {
      ...input,
      folderId: workflow.folderId,
      name,
      graph: current.graphJson,
    },
    scope,
  );
}
