import type { WorkflowRef } from '../../../shared/workflow-actor.types.js';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowDrafts,
  workflowVersions,
  workflows,
} from '@pertexo/database/schema';
import {
  draftProjection,
  projectDraft,
} from '../representation/workflow-representations.repository.js';
import type { WorkflowDefinitionCatalog } from '@pertexo/workflow-model/server';
import type { PoolClient } from 'pg';
import type { FolderScope } from '../../../shared/folder-access.types.js';
import { workflowAccessible } from '../../../shared/resources/workflow-access.repository.js';

export async function readDraft(
  client: PoolClient,
  scope: FolderScope,
  workflow: WorkflowRef,
  definitionCatalog: WorkflowDefinitionCatalog,
) {
  if (!(await workflowAccessible(client, scope, workflow))) return null;
  const [row] = await drizzle(client)
    .select(draftProjection)
    .from(workflowDrafts)
    .where(
      and(
        eq(workflowDrafts.workspaceId, workflow.workspaceId),
        eq(workflowDrafts.workflowId, workflow.workflowId),
      ),
    )
    .catch(rethrowQueryFailure);
  return row === undefined ? null : projectDraft(row, definitionCatalog);
}

export async function readDraftRow(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
) {
  const [row] = await drizzle(client)
    .select(draftProjection)
    .from(workflowDrafts)
    .where(
      and(
        eq(workflowDrafts.workspaceId, workspaceId),
        eq(workflowDrafts.workflowId, workflowId),
      ),
    )
    .catch(rethrowQueryFailure);
  return row;
}

export async function readPublishedVersionRow(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
) {
  const [live] = await drizzle(client)
    .select({
      versionId: workflowVersions.id,
      versionNumber: workflowVersions.versionNumber,
      checksum: workflowVersions.checksum,
      graphJson: workflowVersions.graphJson,
    })
    .from(workflows)
    .innerJoin(
      workflowVersions,
      and(
        eq(workflowVersions.workspaceId, workflows.workspaceId),
        eq(workflowVersions.workflowId, workflows.id),
        eq(workflowVersions.id, workflows.publishedVersionId),
      ),
    )
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    )
    .catch(rethrowQueryFailure);
  return live;
}
