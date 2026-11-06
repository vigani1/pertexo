import type {
  WorkflowActor,
  WorkflowRef,
} from '../../../shared/workflow-actor.js';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { decodeStoredValue } from '../../../shared/stored-values.js';
import {
  workflowDrafts,
  workflowVersions,
  workflows,
} from '@pertexo/database/schema';

import {
  draftProjection,
  projectDraft,
} from '../representation/workflow-representations.repository.js';

import {
  parseWorkflowGraphDraft,
  sameWorkflowNotes,
} from '@pertexo/workflow-model';
import { compilePublicationGraph } from '../../publication/compile-publication.js';

import type { WorkflowDefinitionCatalog } from '@pertexo/workflow-model/server';
import type { PoolClient } from 'pg';
import type { FolderScope } from '../../../shared/folder-access.types.js';
import { workflowAccessible } from '../../../shared/resources/workflow-access.repository.js';

import type { AuthoringCatalogs } from '../catalogs.js';

export async function validateDraft(
  client: PoolClient,
  scope: FolderScope,
  { signal, ...workflow }: WorkflowActor,
  catalogs: AuthoringCatalogs,
) {
  const { workspaceId, workflowId } = workflow;
  if (!(await workflowAccessible(client, scope, workflow))) return null;
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
  if (row === undefined) return null;
  const draft = projectDraft(row, catalogs.definitionCatalog);
  const inspected = await compilePublicationGraph(
    client,
    { ...workflow, signal },
    draft.graphJson,
    catalogs,
  );
  const { validation } = inspected;
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
  const currentPublication =
    live === undefined
      ? null
      : Object.freeze({
          versionId: live.versionId,
          versionNumber: live.versionNumber,
          matchesDraft:
            validation.ok &&
            draft.compatibility.compatible &&
            inspected.kind === 'ready' &&
            inspected.publication.checksum === live.checksum &&
            sameWorkflowNotes(
              draft.graphJson,
              decodeStoredValue(() => parseWorkflowGraphDraft(live.graphJson)),
            ),
        });
  return Object.freeze({ draft, validation, currentPublication });
}

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
